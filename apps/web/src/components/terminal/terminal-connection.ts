import type { TerminalClientFrame, TerminalServerFrame, TerminalTicket } from '@claudio/shared';
import type { LinkState } from './terminal-model';

/** What the connection needs of a WebSocket, so a test can put a fake one behind it. */
export interface SocketLike {
  binaryType: string;
  readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}

export interface ConnectionDeps {
  /** A new ticket for this terminal; every connection, a reconnect included, spends one */
  ticket(id: string): Promise<TerminalTicket>;
  open(url: string): SocketLike;
  /** Where the socket lives: `ws://host/api/terminals/…` */
  socketUrl(id: string, ticket: string): string;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface ConnectionHandlers {
  onLink(link: LinkState): void;
  /** The snapshot opens every attach; the next binary frame is the unfinished tail of the screen */
  onHello(frame: Extract<TerminalServerFrame, { type: 'hello' }>): void;
  onOutput(bytes: Uint8Array): void;
  onSize(cols: number, rows: number): void;
  onExit(code: number | null, signal: string | null): void;
  /** The server ended the terminal or this attachment; `reconnecting` is true when the connection will try again */
  onClosed(reason: Extract<TerminalServerFrame, { type: 'closed' }>['reason'], reconnecting: boolean): void;
}

const OPEN = 1;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 15_000;

/** The wait before attempt `n` (0 is the first retry): doubles from half a second to fifteen. */
export function backoffDelay(attempt: number): number {
  return Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
}

/** A refusal of the ticket that retrying cannot change: the terminal is gone or the gate said no. */
const final = (error: unknown): boolean => {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 403 || status === 404 || status === 405 || status === 409;
};

/**
 * One terminal's socket, kept open for as long as the view wants it. It asks for a new ticket for
 * every connection and backs off between failures. It leaves the shell alone when it drops: the
 * shell lives in the server, and the next attach starts with a fresh snapshot.
 */
export class TerminalConnection {
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private stopped = false;
  private ended = false;

  constructor(
    private readonly id: string,
    private readonly deps: ConnectionDeps,
    private readonly on: ConnectionHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    this.ended = false;
    this.on.onLink('connecting');
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
  }

  /** Typed or pasted bytes; dropped while there is no open socket, as a terminal with no line does */
  input(data: string): boolean {
    if (!this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(new TextEncoder().encode(data));
    return true;
  }

  frame(frame: TerminalClientFrame): void {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(frame));
  }

  private async connect(): Promise<void> {
    let ticket: TerminalTicket;
    try {
      ticket = await this.deps.ticket(this.id);
    } catch (error) {
      if (this.stopped) return;
      if (final(error)) return this.finish();
      return this.retry();
    }
    if (this.stopped) return;
    const socket = this.deps.open(this.deps.socketUrl(this.id, ticket.ticket));
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.on.onLink('open');
    };
    socket.onmessage = (event) => this.message(event.data);
    socket.onerror = () => undefined;
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (!this.ended) this.retry();
    };
  }

  private message(data: unknown): void {
    if (typeof data === 'string') {
      let frame: TerminalServerFrame;
      try {
        frame = JSON.parse(data) as TerminalServerFrame;
      } catch {
        return;
      }
      if (frame.type === 'hello') this.on.onHello(frame);
      else if (frame.type === 'size') this.on.onSize(frame.cols, frame.rows);
      else if (frame.type === 'exit') {
        this.ended = true;
        this.on.onExit(frame.code, frame.signal);
        this.on.onLink('ended');
      } else if (frame.type === 'closed') {
        // A slow client is put out so it can start again from a snapshot; every other reason is final
        const again = frame.reason === 'evicted-slow';
        if (!again) this.ended = true;
        this.on.onClosed(frame.reason, again);
        if (!again) this.on.onLink('ended');
      }
      return;
    }
    if (data instanceof ArrayBuffer) this.on.onOutput(new Uint8Array(data));
  }

  private finish(): void {
    this.ended = true;
    this.on.onLink('ended');
  }

  private retry(): void {
    if (this.stopped || this.ended) return;
    this.on.onLink('reconnecting');
    const wait = backoffDelay(this.attempt++);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.connect();
    }, wait);
  }
}

/** The socket's address on the page that serves it, with the ticket as its only credential. */
export function defaultSocketUrl(id: string, ticket: string, base: string, where: Pick<Location, 'protocol' | 'host'>): string {
  const scheme = where.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${where.host}${base}/terminals/${encodeURIComponent(id)}/socket?ticket=${encodeURIComponent(ticket)}`;
}
