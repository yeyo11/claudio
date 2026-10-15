// A stand-in for the API server: starts the terminal host, opens one shell and says its pid, then
// waits to be killed. The test kills it with SIGKILL and looks for the shell.
import { forkedHost } from '../../src/terminals/host-client.ts';

const host = forkedHost()({ data: () => undefined, exit: () => undefined, failed: () => undefined });
const started = await host.spawn({
  id: 'orphan',
  shell: '/bin/bash',
  args: [],
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? '/usr/bin', HOME: process.cwd(), TERM: 'xterm' },
  cols: 80,
  rows: 24,
  scrollbackLines: 100,
});
process.stdout.write(`${JSON.stringify(started)}\n`);
setInterval(() => undefined, 1000);
