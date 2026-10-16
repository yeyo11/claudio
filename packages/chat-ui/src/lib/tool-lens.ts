import type { ToolResultDetail } from '@claudio/shared';

/*
 * How an opened tool call reads (docs/plans/tool-rows-and-live-branches.md §3.2): the lens each tool
 * gets, and the pieces each lens draws from the call's input, its result text and the detail the CLI
 * recorded beside it. Pure, so what a reader sees for a given call is unit tested rather than eyeballed.
 */

export type LensKind = 'bash' | 'read' | 'edit' | 'search' | 'fetch' | 'websearch' | 'agent' | 'todo' | 'generic';

const LENSES: Record<string, LensKind> = {
  Bash: 'bash',
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  Write: 'edit',
  NotebookEdit: 'edit',
  Grep: 'search',
  Glob: 'search',
  WebFetch: 'fetch',
  WebSearch: 'websearch',
  Agent: 'agent',
  Task: 'agent',
  TodoWrite: 'todo',
  TaskCreate: 'todo',
  TaskUpdate: 'todo',
  TaskList: 'todo',
  TaskGet: 'todo',
};

/** The lens a tool's body is read through; an MCP tool and anything unknown get the generic one. */
export const lensOf = (name: string | null): LensKind => (name ? (LENSES[name] ?? 'generic') : 'generic');

/** The longest result text drawn before "Show all", as the raw block always did. */
export const RESULT_CAP_CHARS = 6000;
/** A file read is cut here: past it the reader asks for the rest. */
export const READ_CAP_LINES = 120;
/** How deep an object is unfolded as a list before the rest is shown as its JSON. */
export const TREE_DEPTH = 2;
/** Keys a branch lists before it says how many more there are: a long array is the raw view's to show. */
export const TREE_ITEMS = 50;
const TREE_STRING_CHARS = 200;
const BASH_HINT_CHARS = 80;

export type Input = Record<string, unknown>;

export const asInput = (input: unknown): Input => (input && typeof input === 'object' && !Array.isArray(input) ? (input as Input) : {});
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A path as the chat sees it: relative to where it works when it is inside it. */
export function relativePath(path: string, cwd: string | null | undefined): string {
  if (!cwd || !path.startsWith('/')) return path;
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

/** What the folded line says next to a tool's name. `aside` is drawn muted after it; `items` is a count the row words itself. */
export interface ToolHint {
  text: string;
  aside?: string;
  items?: number;
}

/**
 * The short label a tool row shows next to the tool's name, per tool where the table of §3.2 says
 * so, and the first string field (`callHint`) for the rest.
 */
export function toolHint(name: string | null, input: unknown, cwd: string | null | undefined, fallback: (input: unknown) => string): ToolHint {
  const o = asInput(input);
  switch (lensOf(name)) {
    case 'bash': {
      const description = oneLine(str(o.description));
      if (description) return { text: description };
      const command = oneLine(str(o.command));
      return { text: command.length > BASH_HINT_CHARS ? `${command.slice(0, BASH_HINT_CHARS - 1)}…` : command };
    }
    case 'read': {
      const path = relativePath(str(o.file_path) || str(o.notebook_path), cwd);
      const offset = num(o.offset);
      const limit = num(o.limit);
      if (!path || (offset === null && limit === null)) return { text: path };
      const from = offset ?? 1;
      return { text: limit === null ? `${path}:${from}` : `${path}:${from}–${from + limit - 1}` };
    }
    case 'edit':
      return { text: relativePath(str(o.file_path) || str(o.notebook_path), cwd) };
    case 'search': {
      const where = str(o.path);
      return where ? { text: str(o.pattern), aside: relativePath(where, cwd) } : { text: str(o.pattern) };
    }
    case 'fetch':
      return { text: hostOf(str(o.url)) };
    case 'websearch':
      return { text: oneLine(str(o.query)) };
    case 'agent':
      return { text: oneLine(str(o.description)) || fallback(input) };
    case 'todo': {
      const items = checklistOf(name, input);
      const subject = oneLine(str(o.subject) || str(o.content));
      if (subject) return { text: subject };
      return Array.isArray(o.todos) ? { text: '', items: items.length } : { text: fallback(input) };
    }
    case 'generic':
      return { text: fallback(input) };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The line prefixes the CLI writes before each line of a file it read: `12\t` (and `12→` before 2.1). */
const LINE_PREFIX = /^ *\d+(?:\t|→)/;

/** A read file's text without its line-number prefixes, and the number its first line had. */
export function readText(text: string, detail: ToolResultDetail | undefined, input: unknown): { lines: string[]; startLine: number } {
  const raw = text.split('\n');
  // The CLI ends the file with an empty numbered line when it ends in a newline; it is not a line of it
  const prefixed = raw.length > 0 && raw.every((line) => line === '' || LINE_PREFIX.test(line));
  const lines = prefixed ? raw.map((line) => line.replace(LINE_PREFIX, '')) : raw;
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  const first = prefixed ? Number(/\d+/.exec(raw[0] ?? '')?.[0]) : NaN;
  const startLine = detail?.kind === 'file' ? detail.startLine : Number.isFinite(first) ? first : (num(asInput(input).offset) ?? 1);
  return { lines, startLine: Math.max(1, startLine) };
}

/** The language a file is highlighted in: its extension, which the highlighter reads as an alias. */
export function langOfPath(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : undefined;
}

/** One line of the generic lens's input: a key, and its value read for what it is. */
export type FieldValue = { kind: 'text'; text: string } | { kind: 'block'; text: string } | { kind: 'scalar'; text: string } | { kind: 'tree'; nodes: TreeNode[] };

export interface Field {
  key: string;
  value: FieldValue;
}

/** A key of an unfolded object: a leaf with its value, a branch with its size and its own keys, or how many were left out. */
export type TreeNode = { key: string; leaf: string; tone: 'text' | 'scalar' } | { key: string; size: string; children: TreeNode[] } | { more: number };

function leafOf(key: string, value: unknown): TreeNode {
  if (typeof value === 'string') {
    const line = oneLine(value);
    return { key, leaf: line.length > TREE_STRING_CHARS ? `${line.slice(0, TREE_STRING_CHARS - 1)}…` : line, tone: 'text' };
  }
  if (value === null || typeof value !== 'object') return { key, leaf: String(value), tone: 'scalar' };
  const json = JSON.stringify(value);
  return { key, leaf: json.length > TREE_STRING_CHARS ? `${json.slice(0, TREE_STRING_CHARS - 1)}…` : json, tone: 'text' };
}

const entriesOf = (value: object): Array<[string, unknown]> => (Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value));

/** An object or array as nested keys, `depth` levels deep; what is deeper shows as its JSON. */
export function treeOf(value: unknown, depth = TREE_DEPTH): TreeNode[] {
  if (!value || typeof value !== 'object') return [];
  const entries = entriesOf(value);
  // An array's items are what it holds, not a level of their own: a list of hits shows each hit's keys
  const unfold = Array.isArray(value) ? depth >= 1 : depth > 1;
  const nodes = entries.slice(0, TREE_ITEMS).map(([key, v]): TreeNode => {
    if (v && typeof v === 'object' && unfold) return { key, size: Array.isArray(v) ? `[${v.length}]` : `{${Object.keys(v).length}}`, children: treeOf(v, depth - 1) };
    return leafOf(key, v);
  });
  return entries.length > TREE_ITEMS ? [...nodes, { more: entries.length - TREE_ITEMS }] : nodes;
}

/** The generic lens's call zone: every key of the input, each value drawn as what it is. */
export function fieldsOf(input: unknown): Field[] {
  if (!input || typeof input !== 'object') return [];
  return entriesOf(input).map(([key, value]) => {
    if (typeof value === 'string') return { key, value: value.includes('\n') ? { kind: 'block', text: value } : { kind: 'text', text: value } };
    if (value && typeof value === 'object') return { key, value: { kind: 'tree', nodes: treeOf(value) } };
    return { key, value: { kind: 'scalar', text: String(value) } };
  });
}

/** A result's text read for what it is: a JSON tree, Markdown, or plain preformatted text. */
export type ResultReading = { kind: 'json'; nodes: TreeNode[] } | { kind: 'markdown'; text: string } | { kind: 'plain'; text: string };

const MARKDOWN = [/^#{1,6}\s+\S/m, /^\s*(?:[-*+]|\d+\.)\s+\S/m, /^\s*(?:```|~~~)/m, /^\s*\|.*\|\s*\n\s*\|[\s:|-]+\|\s*$/m];

/** MCP servers answer in content blocks; when the text is still that array, its words are the answer. */
function blocksText(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const texts: string[] = [];
  for (const block of value) {
    const o = asInput(block);
    if (o.type !== 'text' || typeof o.text !== 'string') return null;
    texts.push(o.text);
  }
  return texts.join('\n\n');
}

export function readResult(text: string): ResultReading {
  const trimmed = text.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const inner = blocksText(parsed);
      if (inner !== null) return readResult(inner);
      if (parsed && typeof parsed === 'object' && entriesOf(parsed).length > 0) return { kind: 'json', nodes: treeOf(parsed) };
    } catch {
      // not JSON after all: read as text below
    }
  }
  return MARKDOWN.some((rule) => rule.test(text)) ? { kind: 'markdown', text } : { kind: 'plain', text };
}

/** Text cut at a cap, and how many lines the whole has, for "Show all {{count}} lines". */
export function capText(text: string, cap = RESULT_CAP_CHARS): { text: string; cut: boolean; lines: number } {
  const lines = text.split('\n').length;
  if (text.length <= cap) return { text, cut: false, lines };
  const at = text.lastIndexOf('\n', cap);
  return { text: text.slice(0, at > cap / 2 ? at : cap), cut: true, lines };
}

/** The `Grep`/`Glob` result: which mode it answered in, and its paths, lines or count. */
export type SearchReading = { mode: 'files'; files: string[] } | { mode: 'content'; text: string } | { mode: 'count'; total: number; text: string };

const FOUND_LINE = /^Found \d+ (?:files?|total occurrences?.*)$|^No (?:files|matches) found$/;

export function readSearch(name: string | null, input: unknown, text: string, detail: ToolResultDetail | undefined, cwd: string | null | undefined): SearchReading {
  const o = asInput(input);
  const asked = str(o.output_mode);
  const mode = detail?.kind === 'matches' ? detail.mode : asked === 'content' ? 'content' : asked === 'count' ? 'count' : 'files';
  // The CLI's own summary lines say again what the list shows
  const lines = text.split('\n').filter((line) => line.trim() && !FOUND_LINE.test(line.trim()));
  if (mode === 'files' || name === 'Glob') return { mode: 'files', files: lines.map((line) => relativePath(line.trim(), cwd)) };
  if (mode === 'count') {
    const total = detail?.kind === 'matches' ? detail.total : lines.reduce((sum, line) => sum + (Number(/:(\d+)$/.exec(line)?.[1]) || 0), 0);
    return { mode: 'count', total, text: lines.join('\n') };
  }
  return { mode: 'content', text: lines.join('\n') };
}

/** The options a `Grep`/`Glob` was given beside its pattern and path, as `key value` words. */
export function searchOptions(input: unknown): string[] {
  const o = asInput(input);
  const out: string[] = [];
  for (const [key, value] of Object.entries(o)) {
    if (key === 'pattern' || key === 'path' || value === undefined || value === null || value === false) continue;
    out.push(value === true ? key : `${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return out;
}

/** The checklist a planning tool wrote or changed. */
export type ChecklistStatus = 'pending' | 'inProgress' | 'completed';

export interface ChecklistItem {
  text: string;
  status: ChecklistStatus;
}

const STATUS: Record<string, ChecklistStatus> = { pending: 'pending', in_progress: 'inProgress', completed: 'completed', done: 'completed' };

export function checklistOf(name: string | null, input: unknown): ChecklistItem[] {
  const o = asInput(input);
  const item = (raw: unknown): ChecklistItem | null => {
    const i = asInput(raw);
    const text = oneLine(str(i.content) || str(i.subject) || str(i.activeForm) || str(i.description));
    if (!text) return null;
    return { text, status: STATUS[str(i.status)] ?? 'pending' };
  };
  if (Array.isArray(o.todos)) return o.todos.map(item).filter((i): i is ChecklistItem => i !== null);
  if (name === 'TaskCreate' || name === 'TaskUpdate') {
    const one = item(o);
    return one ? [one] : [];
  }
  return [];
}

/** What the `+`/`−` of a patch add up to, for the meta line under its diff. */
export function patchCounts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/**
 * A subagent's report without the bookkeeping the CLI appends for the model: the line with its id
 * and the usage block. "This tool result is internal metadata…" is never shown to a person.
 */
export function agentReport(text: string): string {
  const cut = text.search(/^\s*agentId: /m);
  const body = cut >= 0 ? text.slice(0, cut) : text;
  return body.replace(/<usage>[\s\S]*?<\/usage>/g, '').trim();
}

/** Whether the agent was sent to run on its own: what its detail says, else what the call asked. */
export const agentInBackground = (input: unknown, detail: ToolResultDetail | undefined): boolean =>
  detail?.kind === 'agent' ? detail.background : asInput(input).run_in_background === true;
