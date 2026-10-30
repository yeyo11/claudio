import { descendantsOf, processEntry, processTable, type ProcessEntry } from '../../processes.ts';
import type { HostReply, HostRequest, SpawnMessage } from './protocol.ts';
import { PtyMissingError, loadNodePty, type Pty, type PtyBackend } from './pty.ts';
import { Screen } from './screen.ts';
import { errorMessage } from '@claudio/shared';

interface Entry {
  pty: Pty;
  screen: Screen;
  pid: number;
  started: number | null;
  exited: boolean;
  /** Output that arrived while a snapshot was being taken, which belongs after it, not in it */
  held: Buffer[];
  holds: number;
  ending: boolean;
}

export interface HostDeps {
  send(message: HostReply): void;
  /** The PTY backend, loaded on the first spawn; tests give a fake */
  loadPty?: () => PtyBackend;
  log?: (message: string) => void;
}

const signal = (pid: number, name: NodeJS.Signals): void => {
  try {
    process.kill(pid, name);
  } catch {
    // gone already, or not ours to signal
  }
};

/**
 * The terminal host's logic, apart from the process that runs it: it holds the PTYs and one headless
 * screen per shell, and does what the service asks. It spawns nothing but shells and never uses
 * `child_process`, whose children would inherit every PTY master.
 */
export class TerminalHostCore {
  private readonly terminals = new Map<string, Entry>();
  private backend: PtyBackend | null = null;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(private readonly deps: HostDeps) {}

  handle(message: HostRequest): void {
    switch (message.type) {
      case 'spawn':
        this.spawn(message);
        return;
      case 'write':
        this.live(message.id)?.pty.write(message.data);
        return;
      case 'resize': {
        const entry = this.live(message.id);
        if (!entry) return;
        // The screen first, then the PTY: SIGWINCH reaches the foreground job after the screen agrees
        entry.screen.resize(message.cols, message.rows);
        entry.pty.resize(message.cols, message.rows);
        return;
      }
      case 'pause':
        this.live(message.id)?.pty.pause();
        return;
      case 'resume':
        this.live(message.id)?.pty.resume();
        return;
      case 'snapshot':
        void this.snapshot(message);
        return;
      case 'kill': {
        const entry = this.live(message.id);
        if (entry) this.end(entry, message.graceMs);
        return;
      }
      case 'killAll':
        for (const entry of this.terminals.values()) if (!entry.exited) this.end(entry, message.graceMs);
        return;
      case 'forget': {
        const entry = this.terminals.get(message.id);
        if (entry?.exited) {
          entry.screen.dispose();
          this.terminals.delete(message.id);
        }
        return;
      }
    }
  }

  /** Ends every shell and resolves when they are gone (or the grace and a little more have passed) */
  async shutdown(graceMs: number): Promise<void> {
    const running = [...this.terminals.values()].filter((e) => !e.exited);
    if (running.length === 0) return;
    for (const entry of running) this.end(entry, graceMs);
    await new Promise<void>((done) => {
      const limit = setTimeout(done, graceMs + 1000);
      const poll = setInterval(() => {
        if (running.every((e) => e.exited)) {
          clearInterval(poll);
          clearTimeout(limit);
          done();
        }
      }, 25);
    });
  }

  private live(id: string): Entry | undefined {
    const entry = this.terminals.get(id);
    return entry && !entry.exited ? entry : undefined;
  }

  private spawn(message: SpawnMessage): void {
    let backend: PtyBackend;
    try {
      this.backend ??= (this.deps.loadPty ?? (() => loadNodePty()))();
      backend = this.backend;
    } catch (error) {
      const detail = error instanceof PtyMissingError ? `${error.message}: ${error.detail}` : String(error);
      this.deps.log?.(`pty-missing: ${detail}`);
      this.deps.send({ type: 'spawn-error', id: message.id, reason: 'pty-missing', message: detail });
      return;
    }
    let pty: Pty;
    try {
      pty = backend.spawn({ file: message.shell, args: message.args, cwd: message.cwd, env: message.env, cols: message.cols, rows: message.rows });
    } catch (error) {
      this.deps.send({ type: 'spawn-error', id: message.id, reason: 'spawn-failed', message: errorMessage(error) });
      return;
    }
    const screen = new Screen(message.cols, message.rows, message.scrollbackLines);
    const entry: Entry = { pty, screen, pid: pty.pid, started: processEntry(pty.pid)?.started ?? null, exited: false, held: [], holds: 0, ending: false };
    this.terminals.set(message.id, entry);
    pty.onData((data) => {
      if (entry.holds > 0) {
        entry.held.push(data);
        return;
      }
      this.forward(message.id, entry, data);
    });
    pty.onExit(({ code, signal: name }) => {
      entry.exited = true;
      this.deps.send({ type: 'exit', id: message.id, code, signal: name });
    });
    this.deps.send({ type: 'spawned', id: message.id, pid: pty.pid, pidStarted: entry.started });
  }

  private forward(id: string, entry: Entry, data: Buffer): void {
    entry.screen.write(data);
    this.deps.send({ type: 'data', id, data });
  }

  /**
   * The screen is flushed and serialized with the shell's output held, then released after the reply:
   * what the service reads before the reply is in the snapshot, and what it reads after is not.
   */
  private async snapshot(message: Extract<HostRequest, { type: 'snapshot' }>): Promise<void> {
    const entry = this.terminals.get(message.id);
    if (!entry) {
      this.deps.send({ type: 'snapshot-error', reqId: message.reqId, id: message.id });
      return;
    }
    entry.holds += 1;
    try {
      const snap = await entry.screen.snapshot(message.replayLines, message.maxBytes);
      this.deps.send({ type: 'snapshot', reqId: message.reqId, id: message.id, ...snap });
    } catch {
      this.deps.send({ type: 'snapshot-error', reqId: message.reqId, id: message.id });
    } finally {
      entry.holds -= 1;
      if (entry.holds === 0) {
        const held = entry.held;
        entry.held = [];
        for (const data of held) this.forward(message.id, entry, data);
      }
    }
  }

  /**
   * SIGHUP to the shell's process group at once, SIGTERM a third of the way into the grace, and
   * SIGKILL at the end to whatever is still the same process (same pid and start time: a pid the
   * system has reused since is somebody else's). A job that left the group but is still a descendant
   * of the shell (job control gives each background job its own) is found by ancestry and gets the same.
   */
  private end(entry: Entry, graceMs: number): void {
    if (entry.ending) return;
    entry.ending = true;
    const table = processTable();
    const root = table.find((p) => p.pid === entry.pid && (entry.started === null || p.started === entry.started));
    const victims: ProcessEntry[] = root ? [...descendantsOf(table, root.pid), root] : [];
    const leader = root ? entry.pid : null;
    const sweep = (name: NodeJS.Signals): void => {
      const now = processTable();
      // Only what is still the process it was: a pid reused since is not ours
      if (leader !== null && now.some((p) => p.pid === leader && p.started === root?.started)) signal(-leader, name);
      for (const victim of victims) {
        if (now.some((p) => p.pid === victim.pid && p.started === victim.started)) signal(victim.pid, name);
      }
    };
    if (leader !== null) signal(-leader, 'SIGHUP');
    for (const victim of victims) signal(victim.pid, 'SIGHUP');
    this.later(Math.round(graceMs / 3), () => sweep('SIGTERM'));
    this.later(graceMs, () => sweep('SIGKILL'));
  }

  private later(ms: number, run: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      run();
    }, ms);
    this.timers.add(timer);
  }

  /** Cancels what is waiting; for tests that end the host themselves */
  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const entry of this.terminals.values()) entry.screen.dispose();
    this.terminals.clear();
  }
}
