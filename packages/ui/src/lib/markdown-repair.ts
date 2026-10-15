/** Whether the text ends inside a fenced code block that has not been closed yet. */
export function insideOpenFence(text: string): boolean {
  let open: string | null = null;
  for (const line of text.split('\n')) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!match?.[1]) continue;
    const fence = match[1];
    if (open === null) open = fence;
    // Only a fence of the same kind, at least as long, and with nothing after it closes the block
    else if (fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) open = null;
  }
  return open !== null;
}

/** How many times `mark` appears without a backslash before it. */
export function countUnescaped(text: string, mark: string): number {
  let count = 0;
  for (let i = text.indexOf(mark); i !== -1; i = text.indexOf(mark, i + mark.length)) {
    if (text[i - 1] !== '\\') count += 1;
  }
  return count;
}

/** Whole inline code spans removed, so the marks inside them do not count as emphasis. */
function withoutCode(text: string): string {
  return text.replace(/`[^`]*`/g, '');
}

/** How many `**` there are outside inline code. */
export function countMarker(text: string, marker: string): number {
  return countUnescaped(withoutCode(text), marker);
}

/**
 * How many single `*` or `_` there are outside inline code, leaving out the ones that are not
 * emphasis: part of `**`, a list bullet at the start of a line, or (for `_`) inside a word.
 */
export function countSingle(text: string, mark: '*' | '_'): number {
  const plain = withoutCode(text).replace(/\*\*/g, '').replace(/^[ \t]*\* /gm, '');
  let count = 0;
  for (let i = plain.indexOf(mark); i !== -1; i = plain.indexOf(mark, i + 1)) {
    if (plain[i - 1] === '\\') continue;
    if (mark === '_' && /\w/.test(plain[i - 1] ?? '') && /\w/.test(plain[i + 1] ?? '')) continue;
    count += 1;
  }
  return count;
}

/**
 * The end of a growing answer made renderable: what the model has opened and not yet closed would
 * otherwise show as raw marks until it does. Only ever applied to the last block of a streaming answer.
 */
export function repairTail(text: string): string {
  if (insideOpenFence(text)) return text; // a growing code block renders as one already
  let out = text
    .replace(/!\[[^\]]*$/, '') // half an image: `![alt`
    .replace(/!\[[^\]]*\]\([^)]*$/, '') // `![alt](url`
    .replace(/\[([^\]]*)\]\([^)]*$/, '$1') // `[text](url` → text
    .replace(/\[([^\]]*)$/, '$1'); // `[text` → text
  if (countUnescaped(out, '`') % 2 === 1) return `${out}\``; // inside inline code: close it, nothing else applies
  if (countMarker(out, '**') % 2 === 1) out += '**';
  if (countSingle(out, '*') % 2 === 1) out += '*';
  if (countSingle(out, '_') % 2 === 1 && /(^|\s)_\S[^_]*$/.test(out)) out += '_';
  return out;
}
