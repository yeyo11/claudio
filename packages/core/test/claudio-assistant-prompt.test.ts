import assert from 'node:assert/strict';
import test from 'node:test';
import { CLAUDIO_MCP_COLLAB_TOOL_NAMES, CLAUDIO_MCP_READ_TOOL_NAMES, CLAUDIO_MCP_WRITE_TOOL_NAMES } from '@claudio/mcp';
import { CAPABILITIES } from '@claudio/mcp/catalogue';
import { claudioAssistantPrompt } from '../src/claudio-assistant-prompt.ts';

/*
 * The assistant's guide promised what its tools could not do: start a chat in a project, accept a
 * proposal nothing listed, chat states the API does not have, nothing about orchestrations (report
 * §4.10). Its capabilities are now generated from the server's catalogue, one line per tool, and
 * these tests hold every such line to a tool and every tool to a line.
 */

const section = (prompt: string): string[] => {
  const start = prompt.indexOf('# What you can do');
  assert.ok(start >= 0, 'the guide has a capability section');
  const end = prompt.indexOf('\n# ', start + 1);
  return prompt.slice(start, end < 0 ? undefined : end).split('\n');
};

test('every capability line of the guide names a tool of the catalogue, and every tool has its line', () => {
  const prompt = claudioAssistantPrompt(null, 'en', 'reads');
  const claims = section(prompt).filter((line) => line.startsWith('- '));
  const known = new Set<string>([...CLAUDIO_MCP_READ_TOOL_NAMES, ...CLAUDIO_MCP_WRITE_TOOL_NAMES, ...CLAUDIO_MCP_COLLAB_TOOL_NAMES]);
  const named = claims.map((line) => /^- ([a-z_]+): \S/.exec(line)?.[1]);
  for (const [i, tool] of named.entries()) assert.ok(tool && known.has(tool), `the line "${claims[i]}" names no tool`);
  assert.deepEqual([...named].sort(), [...known].sort(), 'one line per tool, none missing');
  // Each line says what its tool's description says first, so a description change moves the guide too
  for (const capability of CAPABILITIES) assert.ok(prompt.includes(`- ${capability.tool}: ${capability.says}`), capability.tool);
});

test("the teammates' reads are promised only while the assistant may make them", () => {
  for (const teammates of ['off', null] as const) {
    const lines = section(claudioAssistantPrompt(null, 'en', teammates));
    assert.equal(lines.some((line) => line.startsWith('- collab_')), false, String(teammates));
    assert.ok(lines.some((line) => line.startsWith('- launch_orchestration: ')), String(teammates));
  }
});

test('the writes are listed apart from the reads, under the sentence that says the person allows each', () => {
  const lines = section(claudioAssistantPrompt(null, 'es', null));
  const changing = lines.findIndex((line) => line.startsWith('Changing'));
  assert.ok(changing > 0);
  for (const tool of CLAUDIO_MCP_WRITE_TOOL_NAMES) assert.ok(lines.findIndex((line) => line.startsWith(`- ${tool}: `)) > changing, tool);
  for (const tool of CLAUDIO_MCP_READ_TOOL_NAMES) assert.ok(lines.findIndex((line) => line.startsWith(`- ${tool}: `)) < changing, tool);
});

test('the guide names only chat states the API has, and refuses what no tool does', () => {
  const prompt = claudioAssistantPrompt(null, 'en');
  assert.match(prompt, /a state \(working, waiting for the person, or idle\)/);
  assert.doesNotMatch(prompt, /idle, done, failed/);
  assert.match(prompt, /You cannot delete anything, change settings, accounts, permissions or security/);
});
