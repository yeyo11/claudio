#!/usr/bin/env node
// Stop: when this session edited UI files and no ui-reviewer ran after the last of those edits, ask
// for /ui-review once. It blocks a single time per set of files (the state is cleared as it blocks,
// and `stop_hook_active` lets the next stop through), so it can never trap a session in a loop.
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { block, dirtyFiles, readHookInput } from './_common.mjs';

const input = readHookInput();
if (input.stop_hook_active) process.exit(0);
const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
const { path, files } = dirtyFiles(root, input.session_id);
if (!files.length) process.exit(0);

let reviewed = false;
try {
  const transcript = readFileSync(input.transcript_path, 'utf8');
  const lastEdit = Math.max(...files.map((f) => transcript.lastIndexOf(f)));
  const lastReview = Math.max(transcript.lastIndexOf('"subagent_type":"ui-reviewer"'), transcript.lastIndexOf('<command-name>/ui-review'));
  reviewed = lastReview > lastEdit;
} catch {
  // no transcript to read: ask, once
}
if (existsSync(path)) unlinkSync(path);
if (reviewed) process.exit(0);
block(
  `You changed the UI (${files.length} file(s)) and it has not been reviewed. Run /ui-review <route> ` +
    '(the screens are in .claude/designer/route-map.json) and fix its blocking findings before you finish. ' +
    `Files: ${files.slice(0, 6).join(', ')}${files.length > 6 ? '…' : ''}`,
);
