// The terminal host: the child process that holds the PTYs and their screens (bundled as
// terminal-host.mjs). The server forks it at the first terminal, it lives exactly as long as the
// server does, and it spawns nothing but shells.
import { TerminalHostCore } from './host.ts';
import type { HostRequest } from './protocol.ts';

const GRACE_MS = 3000;

const send = process.send?.bind(process);
if (!send) {
  process.stderr.write('terminal host: started without an IPC channel; it is only run by the server\n');
  process.exit(2);
}

const host = new TerminalHostCore({
  send: (message) => {
    try {
      send(message);
    } catch {
      // The channel closed: the disconnect handler below is already ending the shells
    }
  },
  log: (message) => process.stderr.write(`terminal host: ${message}\n`),
});

process.on('message', (message: HostRequest) => host.handle(message));

// The server is gone, however it went: the shells do not outlive it
let leaving = false;
const leave = (): void => {
  if (leaving) return;
  leaving = true;
  void host.shutdown(GRACE_MS).finally(() => process.exit(0));
};
process.on('disconnect', leave);
process.on('SIGTERM', leave);
process.on('SIGHUP', leave);

send({ type: 'ready' });
