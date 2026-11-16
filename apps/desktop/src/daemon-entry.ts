// `dist/daemon.cjs`: the daemon on the desktop binary run as Node (ELECTRON_RUN_AS_NODE=1)
import { daemonMain } from './daemon-main.ts';

// Read once by Electron at launch; left in, the server and every chat would inherit it
delete process.env.ELECTRON_RUN_AS_NODE;
void daemonMain(process.argv).then((code) => process.exit(code));
