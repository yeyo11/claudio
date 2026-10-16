import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { ClaudeCodeDriver } from '../src/providers/claude-code/driver.ts';
import { claudeCodeManifest } from '../src/providers/claude-code/manifest.ts';
import { driverConformance } from './conformance/suite.ts';

// The Claude driver through the conformance suite, on the control-protocol fake. The turns are
// replayed from recorded shapes of the CLI's stream (fixtures/replay), never invented here.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));
const replay = (file: string, raw = false) => `${raw ? 'REPLAY-RAW' : 'REPLAY'} ${fileURLToPath(new URL(join('./fixtures/replay', file), import.meta.url))}`;

driverConformance('claude-code', {
  manifest: claudeCodeManifest,
  driver: () => new ClaudeCodeDriver(FAKE_CLAUDE),
  script: {
    turn: replay('conformance-turn.jsonl'),
    ask: (tool) => `ASK ${tool}`,
    unexpected: 'ODD',
    budget: replay('budget.jsonl', true),
    // The fixture's reset is far in the future on purpose: the rejection has to bind whatever day the suite runs
    rateLimit: replay('rate-limit.jsonl', true),
    structured: replay('structured.jsonl', true),
    // Wording a tool or hook may well print: stderr is shown, never read for the account's limit
    noisy: 'STDERR conformance stderr line: API rate limit exceeded, usage limit reached',
    delegating: replay('agent-turn.jsonl', true),
  },
  structuredResult: { verdict: 'pass', notes: ['a', 'b'] },
  decision: (result) => (result.includes('"behavior":"allow"') ? 'allow' : result.includes('"behavior":"deny"') ? 'deny' : null),
  stderrText: 'conformance stderr line: API rate limit exceeded, usage limit reached',
});
