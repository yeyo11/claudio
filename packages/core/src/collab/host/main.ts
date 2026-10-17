// The Collaborators host: the child process that holds the iroh endpoint (bundled as
// collab-host.mjs). The server forks it when Collaborators is turned on and restarts it when it dies:
// a panic in the native module ends this process and nothing else (docs/plans/collaborators.md §3.2).
import { pathToFileURL } from 'node:url';
import { CollabHostCore } from './host.ts';
import { IROH_MODULE_ENV, type CoreToHost, type HostToCore } from './protocol.ts';

const GRACE_MS = 2000;

const send = process.send?.bind(process);
if (!send) {
  process.stderr.write('collab host: started without an IPC channel; it is only run by the server\n');
  process.exit(2);
}

const log = (message: string): void => {
  process.stderr.write(`collab host: ${message}\n`);
};

// The binding's promises can reject with nobody awaiting them (`LocallyClosed` after a failed
// write, §7.2): that must cost a log line, not the process and every connection in it
process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`));

const override = process.env[IROH_MODULE_ENV];
const host = new CollabHostCore({
  send: (message: HostToCore) => {
    try {
      send(message);
    } catch {
      // The channel closed: the disconnect handler below is already closing the endpoint
    }
  },
  load: () => (override ? import(pathToFileURL(override).href) : import('@number0/iroh')),
  log,
});

process.on('message', (message: CoreToHost) => host.handle(message));

// The server is gone, however it went: the endpoint does not outlive it
let leaving = false;
const leave = (): void => {
  if (leaving) return;
  leaving = true;
  const timer = setTimeout(() => process.exit(0), GRACE_MS);
  void host.shutdown().finally(() => {
    clearTimeout(timer);
    process.exit(0);
  });
};
process.on('disconnect', leave);
process.on('SIGTERM', leave);
process.on('SIGHUP', leave);

send({ type: 'ready' });
