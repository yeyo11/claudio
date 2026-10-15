import { SerializeAddon } from '@xterm/addon-serialize';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import * as headless from '@xterm/headless';

// The package's CommonJS build exposes everything under `default` when Node imports it, and as named
// exports when a bundler does: either way the class is the same
const { Terminal } = (headless as unknown as { default?: typeof headless }).default ?? headless;

/** Replay steps for a snapshot that does not fit: each is tried until the snapshot is small enough */
const STEPS = [1000, 500, 250, 100, 0];

export interface ScreenSnapshot {
  /** The screen as escape sequences, scrollback included, for a client that reattaches to repaint from */
  snapshot: string;
  /** The bytes since the parser last rested, which the serializer drops: a sequence cut in half at that instant */
  tail: Buffer;
  cols: number;
  rows: number;
}

/**
 * Where the parser stands in a byte stream: at rest, or inside an escape sequence or a multi-byte
 * character. It is the host's own small scanner rather than a look into xterm's parser, so the tail it
 * keeps does not depend on xterm's private state. Control strings (OSC, DCS, APC, PM, SOS) end at BEL or ST.
 */
type Rest = 'ground' | 'esc' | 'csi' | 'string' | 'string-esc' | { utf8: number };

/** The most a half-written sequence may hold: a runaway string is abandoned instead of buffered */
const TAIL_LIMIT = 256 * 1024;

export class TailTracker {
  private state: Rest = 'ground';
  private pending: Buffer[] = [];
  private size = 0;

  /** Feeds a chunk; what is held afterwards is exactly the unfinished sequence at its end */
  feed(chunk: Buffer): void {
    let start = 0;
    for (let at = 0; at < chunk.length; at += 1) {
      this.state = step(this.state, chunk[at] as number);
      if (this.state === 'ground') {
        // The sequence that was open ended here: nothing before this byte is held any more
        this.pending = [];
        this.size = 0;
        start = at + 1;
      }
    }
    if (this.state !== 'ground') {
      const rest = chunk.subarray(start);
      this.pending.push(rest);
      this.size += rest.length;
      if (this.size > TAIL_LIMIT) {
        this.pending = [];
        this.size = 0;
        this.state = 'ground';
      }
    }
  }

  tail(): Buffer {
    return Buffer.concat(this.pending, this.size);
  }
}

function step(state: Rest, byte: number): Rest {
  if (typeof state === 'object') return state.utf8 > 1 ? { utf8: state.utf8 - 1 } : 'ground';
  // CAN and SUB abort whatever is open
  if (byte === 0x18 || byte === 0x1a) return 'ground';
  switch (state) {
    case 'ground':
      if (byte === 0x1b) return 'esc';
      if (byte >= 0xc0 && byte <= 0xdf) return { utf8: 1 };
      if (byte >= 0xe0 && byte <= 0xef) return { utf8: 2 };
      if (byte >= 0xf0 && byte <= 0xf7) return { utf8: 3 };
      return 'ground';
    case 'esc':
      if (byte === 0x5b) return 'csi';
      if (byte === 0x5d || byte === 0x50 || byte === 0x58 || byte === 0x5e || byte === 0x5f) return 'string';
      if (byte === 0x1b) return 'esc';
      // Intermediates (`ESC ( B`) wait for their final byte
      return byte >= 0x20 && byte <= 0x2f ? 'esc' : 'ground';
    case 'csi':
      if (byte === 0x1b) return 'esc';
      return byte >= 0x40 && byte <= 0x7e ? 'ground' : 'csi';
    case 'string':
      if (byte === 0x07) return 'ground';
      return byte === 0x1b ? 'string-esc' : 'string';
    case 'string-esc':
      // ESC \ is the string terminator; any other byte after ESC starts a new sequence
      return byte === 0x5c ? 'ground' : step('esc', byte);
  }
}

/**
 * One terminal's screen as the host keeps it, for one purpose: repainting a client that reattaches.
 * It is never searched, logged, stored on disk or handed to an agent.
 */
export class Screen {
  private readonly term: InstanceType<typeof Terminal>;
  private readonly serializer = new SerializeAddon();
  private readonly tracker = new TailTracker();
  private writing: Promise<void> = Promise.resolve();

  constructor(cols: number, rows: number, scrollback: number) {
    this.term = new Terminal({ cols, rows, scrollback, allowProposedApi: true });
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(this.serializer);
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  write(data: Buffer): void {
    this.tracker.feed(data);
    this.writing = new Promise<void>((done) => this.term.write(data, done));
  }

  /** Resolves once everything written so far has been parsed */
  flush(): Promise<void> {
    return this.writing;
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  /**
   * The screen after everything written so far, in the smallest replay that fits `maxBytes`: the
   * serialized screen is stepped down from `replayLines` through 500, 250 and 100 lines to none, so a
   * phone's first frame stays small.
   */
  async snapshot(replayLines: number, maxBytes: number): Promise<ScreenSnapshot> {
    await this.flush();
    const steps = [replayLines, ...STEPS.filter((s) => s < replayLines)];
    let snapshot = '';
    for (const lines of steps) {
      snapshot = this.serializer.serialize({ scrollback: lines });
      if (Buffer.byteLength(snapshot) <= maxBytes) break;
    }
    return { snapshot, tail: this.tracker.tail(), cols: this.term.cols, rows: this.term.rows };
  }

  dispose(): void {
    this.term.dispose();
  }
}
