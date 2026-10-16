import { addedDiff, unifiedOf } from './patch.ts';
import type { ContentBlock, ToolResultDetail, TranscriptCompaction, TranscriptEntry } from './types.ts';

const MAX_TOOL_RESULT = 20_000;

/** Past this a `data` detail is left out: the text already says it, and a page carries every one */
const MAX_DETAIL_DATA = 8_000;

/** What `data` never repeats: the file, the output or the answer the result's text already holds */
const DATA_DROPPED = new Set(['originalFile', 'content', 'stdout', 'result', 'file']);

function stringifyToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (c && typeof c === 'object' && 'text' in c && typeof c.text === 'string') return c.text;
        if (c && typeof c === 'object' && 'type' in c) return `[${String(c.type)}]`;
        return '';
      })
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const lineCount = (v: unknown, fallback: number): number => {
  const n = count(v);
  return n === null ? fallback : Math.max(0, Math.trunc(n));
};

/**
 * The patch of a writing call, held to the cap the result's text has: whole hunks while they fit,
 * so what reaches the page always parses; a new file is cut at a line, its header counting what is kept.
 */
function patchText(r: Record<string, unknown>, created: boolean): string {
  const hunks = Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
  if (hunks.length > 0) {
    let out = '';
    for (const hunk of hunks) {
      const next = unifiedOf([hunk]);
      if (out.length + next.length > MAX_TOOL_RESULT) break;
      out += next;
    }
    return out;
  }
  if (!created || typeof r.content !== 'string') return '';
  if (r.content.length <= MAX_TOOL_RESULT) return addedDiff(r.content);
  const cut = r.content.lastIndexOf('\n', MAX_TOOL_RESULT);
  return cut > 0 ? addedDiff(r.content.slice(0, cut + 1)) : '';
}

/**
 * What the CLI recorded beside a tool result, read by its shape: the line does not name the tool.
 * The keys are those the CLI writes (checked against its transcripts, 2.1.286 to 2.1.300). A string
 * is a failed call's error and says nothing the text does not; an array is an MCP server's content,
 * which is the text itself.
 */
export function toolResultDetail(raw: unknown): ToolResultDetail | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const file = r.file && typeof r.file === 'object' ? (r.file as Record<string, unknown>) : null;
  if (file && typeof file.filePath === 'string') {
    const numLines = lineCount(file.numLines, 0);
    return {
      kind: 'file',
      path: file.filePath,
      startLine: lineCount(file.startLine, 1),
      numLines,
      totalLines: lineCount(file.totalLines, numLines),
    };
  }
  if (
    typeof r.filePath === 'string' &&
    (Array.isArray(r.structuredPatch) || typeof r.oldString === 'string' || r.type === 'create' || r.type === 'update')
  ) {
    const created = r.type === 'create';
    return { kind: 'patch', path: r.filePath, patch: patchText(r, created), created };
  }
  if (typeof r.stdout === 'string') {
    return {
      kind: 'command',
      stderr: typeof r.stderr === 'string' ? r.stderr : '',
      interrupted: r.interrupted === true,
      backgroundTaskId: typeof r.backgroundTaskId === 'string' && r.backgroundTaskId ? r.backgroundTaskId : null,
    };
  }
  if (typeof r.agentId === 'string' && r.agentId) {
    return {
      kind: 'agent',
      agentId: r.agentId,
      background: r.isAsync === true || r.status === 'async_launched',
      model: typeof r.resolvedModel === 'string' && r.resolvedModel ? r.resolvedModel : null,
    };
  }
  if (typeof r.code === 'number' && 'bytes' in r) return { kind: 'fetch', status: count(r.code), bytes: count(r.bytes) };
  // Grep names its mode (`files_with_matches`, `content`, `count`); Glob names none and lists files
  if (Array.isArray(r.filenames) || typeof r.numFiles === 'number' || typeof r.numMatches === 'number' || (typeof r.mode === 'string' && 'content' in r)) {
    const mode = r.mode === 'content' ? 'content' : r.mode === 'count' ? 'count' : 'files';
    const total =
      mode === 'content'
        ? lineCount(r.numLines, 0)
        : mode === 'count'
          ? lineCount(r.numMatches, 0)
          : lineCount(r.numFiles, Array.isArray(r.filenames) ? r.filenames.length : 0);
    return { kind: 'matches', mode, total };
  }
  const value: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(r)) if (!DATA_DROPPED.has(key)) value[key] = v;
  if (Object.keys(value).length === 0) return null;
  return JSON.stringify(value).length < MAX_DETAIL_DATA ? { kind: 'data', value } : null;
}

/**
 * The detail belongs to the line's one result: with several the line does not say whose it is,
 * and a failed call's is its error, already the text.
 */
function withDetail(blocks: ContentBlock[], o: Record<string, unknown>): ContentBlock[] {
  const raw = o.tool_use_result ?? o.toolUseResult;
  if (raw === undefined) return blocks;
  const results = blocks.filter((b) => b.type === 'tool_result');
  const only = results[0];
  if (results.length !== 1 || !only || only.isError) return blocks;
  const detail = toolResultDetail(raw);
  if (!detail) return blocks;
  return blocks.map((b) => (b === only ? { ...only, detail } : b));
}

function toBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    const b = c as Record<string, unknown>;
    switch (b.type) {
      case 'text':
        if (typeof b.text === 'string' && b.text) blocks.push({ type: 'text', text: b.text });
        break;
      case 'thinking':
        if (typeof b.thinking === 'string' && b.thinking) blocks.push({ type: 'thinking', text: b.thinking });
        break;
      case 'tool_use':
        blocks.push({ type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input });
        break;
      case 'tool_result': {
        const text = stringifyToolResult(b.content);
        blocks.push({
          type: 'tool_result',
          toolUseId: String(b.tool_use_id ?? ''),
          content: text.length > MAX_TOOL_RESULT ? `${text.slice(0, MAX_TOOL_RESULT)}\n… [truncated]` : text,
          isError: b.is_error === true,
        });
        break;
      }
      // Only what the block is: the base64 can run to megabytes and is never needed to display it
      case 'image':
      case 'document': {
        const source = (b.source ?? {}) as Record<string, unknown>;
        blocks.push({
          type: b.type,
          mediaType: String(source.media_type ?? (b.type === 'image' ? 'image' : 'application/pdf')),
          ...(typeof b.title === 'string' ? { name: b.title } : {}),
        });
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

/**
 * Normalizes both a transcript line (~/.claude/projects/*.jsonl) and a CLI stream-json
 * `user`/`assistant` event: both carry `message: { role, content }`.
 */
export function normalizeMessage(raw: unknown): TranscriptEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.type === 'system' && o.subtype === 'local_command') return localCommand(o);
  if (o.type === 'system' && o.subtype === 'compact_boundary') return compactBoundary(o);
  if (o.type === 'attachment') return queuedCommand(o);
  if (o.type !== 'user' && o.type !== 'assistant') return null;
  if (o.isMeta === true) return null;
  const message = o.message as Record<string, unknown> | undefined;
  if (!message) return null;
  const blocks = withDetail(toBlocks(message.content), o);
  if (blocks.length === 0) return null;
  const summary = o.type === 'user' && isCompactSummary(o, message.content);
  return {
    uuid: String(o.uuid ?? ''),
    role: o.type,
    timestamp: typeof o.timestamp === 'string' ? o.timestamp : null,
    model: typeof message.model === 'string' ? message.model : null,
    isSidechain: o.isSidechain === true || (o.parent_tool_use_id != null && o.parent_tool_use_id !== ''),
    parentToolUseId:
      typeof o.parent_tool_use_id === 'string'
        ? o.parent_tool_use_id
        : typeof o.parentToolUseID === 'string'
          ? o.parentToolUseID
          : null,
    blocks,
    ...(summary ? { compaction: { part: 'summary', trigger: null, preTokens: null, postTokens: null, durationMs: null } } : {}),
  };
}

/** How the summary starts, whoever wrote it down: the CLI's fixed lead sentence */
const SUMMARY_LEAD = 'This session is being continued from a previous conversation';

/**
 * The summary Claude Code continues a compacted session from. The file marks it `isCompactSummary`;
 * the stream sends the same line as a synthetic message without that flag (recordings/c0-NOTES.md,
 * F11), so a synthetic line that starts with the CLI's lead sentence is the same summary. Either way
 * it is not something the person typed, and `isVisibleInTranscriptOnly` alone says nothing.
 */
function isCompactSummary(o: Record<string, unknown>, content: unknown): boolean {
  if (o.isCompactSummary === true) return true;
  if (o.isSynthetic !== true) return false;
  const text = typeof content === 'string' ? content : Array.isArray(content) ? (content.find((c) => c?.type === 'text')?.text ?? '') : '';
  return typeof text === 'string' && text.startsWith(SUMMARY_LEAD);
}

/**
 * The CLI's marker that the conversation was compacted here. The stream spells the metadata in
 * snake_case (`compact_metadata`) and the file in camelCase (`compactMetadata`); both are read, and
 * neither carries `post_tokens` always, so it stays null when absent and is never estimated.
 */
function compactBoundary(o: Record<string, unknown>): TranscriptEntry | null {
  const meta = (o.compact_metadata ?? o.compactMetadata ?? {}) as Record<string, unknown>;
  const trigger = meta.trigger === 'manual' || meta.trigger === 'auto' ? meta.trigger : null;
  const compaction: TranscriptCompaction = {
    part: 'boundary',
    trigger,
    preTokens: count(meta.pre_tokens ?? meta.preTokens),
    postTokens: count(meta.post_tokens ?? meta.postTokens),
    durationMs: count(meta.duration_ms ?? meta.durationMs),
  };
  return {
    uuid: String(o.uuid ?? ''),
    role: 'user',
    timestamp: typeof o.timestamp === 'string' ? o.timestamp : null,
    model: null,
    isSidechain: false,
    parentToolUseId: null,
    blocks: [],
    compaction,
  };
}

/**
 * The output of a slash command the CLI ran itself (`/context`, `/cost`, …). The CLI used to write
 * it as a `user` message wrapped in `<local-command-stdout>`, and now writes a `system` line with
 * the same text: read as the message it was, so the page keeps showing it as the command's output.
 */
function localCommand(o: Record<string, unknown>): TranscriptEntry | null {
  if (o.isMeta === true || typeof o.content !== 'string' || !o.content) return null;
  return {
    uuid: String(o.uuid ?? ''),
    role: 'user',
    timestamp: typeof o.timestamp === 'string' ? o.timestamp : null,
    model: null,
    isSidechain: o.isSidechain === true,
    parentToolUseId: null,
    blocks: [{ type: 'text', text: o.content }],
  };
}

/**
 * A message the CLI took into the turn it was running, at a tool boundary: it records it only as an
 * `attachment` of type `queued_command`, never as a `user` line, so without this the message the
 * agent read and answered is missing from every read of the transcript. It is the person's entry,
 * in place, under the id the message was sent with (`source_uuid`, the stream-json `uuid`), which
 * is the id the page and the server know it by; a line written without one keeps its own.
 */
function queuedCommand(o: Record<string, unknown>): TranscriptEntry | null {
  if (o.isMeta === true) return null;
  const attachment = o.attachment as Record<string, unknown> | undefined;
  if (!attachment || attachment.type !== 'queued_command' || attachment.commandMode !== 'prompt') return null;
  const blocks = toBlocks(attachment.prompt);
  if (blocks.length === 0) return null;
  const source = typeof attachment.source_uuid === 'string' && attachment.source_uuid ? attachment.source_uuid : null;
  return {
    uuid: source ?? String(o.uuid ?? ''),
    role: 'user',
    timestamp: typeof o.timestamp === 'string' ? o.timestamp : null,
    model: null,
    isSidechain: o.isSidechain === true,
    parentToolUseId: null,
    blocks,
  };
}

export function entryText(entry: TranscriptEntry): string {
  return entry.blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

/**
 * Whether the CLI reported a real model name.
 *
 * It stamps the messages it makes up itself — an error it synthesised when a session hit its
 * limit, say — with a placeholder in angle brackets where a model would go. Read back as the
 * model of the chat those messages landed in, the placeholder returns as `--model <synthetic>`
 * on the next resume, which the CLI refuses: one bad minute becomes a chat that never starts
 * again. Everything that takes a model from a transcript asks this first.
 */
export function isModelName(model: string | null | undefined): model is string {
  return typeof model === 'string' && model !== '' && !model.startsWith('<');
}
