// Entrypoint of the single-file bundle (`node dist/server.mjs`) that the desktop app runs as a child process.
// First, before anything can use libuv's thread pool
import './threadpool.ts';
import { DataDirLockedError, resolveUserPath } from '@claudio/core';
import { DATA_DIR_LOCKED_EXIT_CODE } from '@claudio/core/launcher/protocol';
import { startServer } from './server.ts';

// The desktop app starts this bundle on Electron's binary with ELECTRON_RUN_AS_NODE=1. Electron reads
// it once, at launch, so it is done with here; left in, every chat, command and Electron app the
// server starts would inherit it and run as plain Node
delete process.env.ELECTRON_RUN_AS_NODE;

// A service or a launcher starts this without the profile files that set up the person's PATH. The
// desktop app has already resolved it, and a second login shell would only slow the start down
if (!process.env.CLAUDIO_DESKTOP_TOKEN) process.env.PATH = await resolveUserPath();

const server = await startServer({
  port: Number(process.env.PORT ?? 0),
  host: process.env.HOST ?? '127.0.0.1',
  webDist: process.env.CLAUDIO_WEB_DIST,
}).catch((err: unknown) => {
  // The launcher (the container's, the desktop's) reads the code: not the payload's fault, nothing to restart
  if (!(err instanceof DataDirLockedError)) throw err;
  console.error(err.message);
  process.exit(DATA_DIR_LOCKED_EXIT_CODE);
});

// The parent parses this single line to learn where the API is listening
console.log(`CLAUDIO_READY ${JSON.stringify({ url: server.url, port: server.port })}`);

const shutdown = () => void server.close().then(() => process.exit(0));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, shutdown);
// With an IPC channel, a dead parent must not leave the server orphaned
process.on('disconnect', shutdown);
