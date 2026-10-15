import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// The terminal is the person's own shell, beside Claude Code and never a way to reach it. No code path
// from chats, orchestrations, the flow, the assistant, the decision engine or the MCP server may touch the
// terminal service, so an agent cannot type into a shell the person has open (docs/plans/terminal.md).

const core = fileURLToPath(new URL('../src/', import.meta.url));
const mcp = fileURLToPath(new URL('../../mcp/src/', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|mts|tsx)$/.test(name) ? [path] : [];
  });
}

const importsOf = (text: string): string[] => [...text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
const inTerminals = (path: string): boolean => relative(core, path).split(sep)[0] === 'terminals';

test('the terminal service is imported by core/index.ts and nothing else in core', () => {
  const importers = sources(core)
    .filter((path) => !inTerminals(path))
    .filter((path) => importsOf(readFileSync(path, 'utf8')).some((spec) => /(^|\/)terminals\//.test(spec)))
    .map((path) => relative(core, path));
  assert.deepEqual(importers, ['index.ts']);
});

test('the terminal reaches out of its folder only for the store, the paths, the process table, the vault and the event type', () => {
  // Anything else (chats, orchestrations, the flow, the assistant, the decisions, the MCP server) is a way
  // for an agent to reach the person's shell, or for the terminal to react to what an agent does
  const allowed = new Set(['../config/files.ts', '../paths.ts', '../processes.ts', '../secret-vault.ts', '../events.ts', '../../processes.ts']);
  const offenders = sources(join(core, 'terminals')).flatMap((path) =>
    importsOf(readFileSync(path, 'utf8'))
      .filter((spec) => spec.startsWith('../') && !allowed.has(spec))
      .map((spec) => `${relative(core, path)} imports ${spec}`),
  );
  assert.deepEqual(offenders, []);
});

test('the MCP server, which agents reach, does not know the terminal', () => {
  const offenders = sources(mcp)
    .filter((path) => /terminal/i.test(readFileSync(path, 'utf8')))
    .map((path) => relative(mcp, path));
  assert.deepEqual(offenders, []);
});

test("nothing in the terminal starts claude or writes into a shell on its own", () => {
  const offenders = sources(join(core, 'terminals')).flatMap((path) => {
    const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    return /['"`]claude['"`]|--output-format|stream-json/.test(text) ? [relative(core, path)] : [];
  });
  assert.deepEqual(offenders, []);
});
