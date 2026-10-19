import net from 'node:net';

/** A request as the raw server read it */
export interface RawRequest {
  path: string;
  headers: Record<string, string>;
  /** Its position among every request this server answered, from 0 */
  index: number;
}

export type RawHandler = (req: RawRequest, socket: net.Socket) => void | Promise<void>;

export interface RawServer {
  url: (path: string) => string;
  requests: RawRequest[];
  close: () => Promise<void>;
}

/**
 * An HTTP server written on bare sockets, so a test decides byte by byte what the client sees: a
 * body cut in the middle, a reset, an HTTP/1.0 answer delimited by the close, a stall.
 */
export async function rawServer(handler: RawHandler): Promise<RawServer> {
  const requests: RawRequest[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      const [line = '', ...rest] = head.slice(0, end).split('\r\n');
      const headers: Record<string, string> = {};
      for (const h of rest) {
        const colon = h.indexOf(':');
        if (colon > 0) headers[h.slice(0, colon).trim().toLowerCase()] = h.slice(colon + 1).trim();
      }
      const req = { path: line.split(' ')[1] ?? '/', headers, index: requests.length };
      requests.push(req);
      void Promise.resolve(handler(req, socket)).catch(() => socket.destroy());
    };
    socket.on('data', onData);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    url: (path) => `http://127.0.0.1:${String(port)}${path}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** The status line and headers of an answer */
export function head(status: string, headers: Record<string, string | number>, version = '1.1'): string {
  return `HTTP/${version} ${status}\r\n${Object.entries(headers)
    .map(([k, v]) => `${k}: ${String(v)}\r\n`)
    .join('')}\r\n`;
}

/** Writes `body` in pieces of `size`, letting the socket drain in between, as a file server does */
export async function writeInPieces(socket: net.Socket, body: Buffer, size = 16 * 1024): Promise<void> {
  for (let at = 0; at < body.length; at += size) {
    if (socket.destroyed) return;
    if (!socket.write(body.subarray(at, at + size))) await new Promise<void>((resolve) => socket.once('drain', resolve));
  }
}
