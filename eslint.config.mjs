// ESLint, for rules the type checker cannot hold. Run with `pnpm lint`.
import { stripTypeScriptTypes } from 'node:module';
import * as espree from 'espree';

/**
 * TypeScript through Node's own type stripping and ESLint's default parser: typescript-eslint
 * refuses TypeScript 7, which this repo builds with. Strip mode keeps every position; a file with
 * syntax that only transforms away (constructor parameter properties) goes through transform mode.
 * `import type` is stripped with the rest, which is fine for the rules here: a type cannot start work.
 */
const stripTypes = {
  meta: { name: 'claudio-strip-types' },
  parse(code, options) {
    let js;
    try {
      js = stripTypeScriptTypes(code, { mode: 'strip' });
    } catch {
      js = stripTypeScriptTypes(code, { mode: 'transform' });
    }
    return espree.parse(js, { ...options, ecmaVersion: 'latest', sourceType: 'module', range: true, loc: true, tokens: true, comment: true });
  },
};

/**
 * What the Collaborators code may not import (docs/plans/collaborators.md §3.5): every module that can
 * start work, so the serving side cannot start a chat, a run, a flow or an orchestration for a peer
 * however it is changed. `packages/core/test/collab-isolation.test.ts` checks the same list, in case
 * this file changes.
 */
const COLLAB_FORBIDDEN = [
  {
    regex: '(^|/)(chat-service|orchestrator[^/]*|flow|workflow-engine[^/]*|processes|cli|schedules|cron|assistant[^/]*)(\\.ts)?$',
    message: 'Collaborators reads only: it may not import what starts chats, runs, flows or orchestrations (docs/plans/collaborators.md §3.5).',
  },
  { regex: '(^|/)terminals(/|$)', message: 'Collaborators may not reach the terminals (docs/plans/collaborators.md §3.5).' },
  { regex: '^@claudio/(api|core)(/|$)|(^|/)apps/api(/|$)', message: 'Collaborators may not import the API, nor the core through its barrel (docs/plans/collaborators.md §3.5).' },
  { regex: '^\\.\\./index(\\.ts)?$', message: "The core's barrel reaches every service; import the module itself (docs/plans/collaborators.md §3.5)." },
];

export default [
  {
    files: ['packages/core/src/collab/**/*.ts'],
    languageOptions: { parser: stripTypes },
    rules: {
      'no-restricted-imports': ['error', { patterns: COLLAB_FORBIDDEN }],
    },
  },
];
