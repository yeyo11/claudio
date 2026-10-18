// Runs the container's launcher on the directories a test made, with short trial times: the same
// `launch()` the bundled /app/launcher.mjs calls, in a process of its own so its signals are real.
import { launch } from '../../src/launcher/main.ts';

const [appDir, dataDir] = process.argv.slice(2);
if (!appDir || !dataDir) throw new Error('usage: launcher-harness <appDir> <dataDir>');
const code = await launch({
  appDir,
  dataDir,
  env: process.env,
  trialMs: Number(process.env.TRIAL_MS ?? 3000),
  pollMs: 50,
  log: (line) => process.stderr.write(`launcher: ${line}\n`),
});
process.exit(code);
