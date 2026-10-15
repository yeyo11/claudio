import { Fragment, Schema, Slice, type Node } from 'prosemirror-model';

/**
 * A message is plain text: the box holds paragraphs of text and nothing else, so what is sent is
 * exactly what was typed, a line per paragraph. Markdown stays as written, for the agent to read.
 */
export const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'text*',
      // Pasted HTML is never parsed (`plainSlice`), but a drop or an undo may still hand the view a div
      parseDOM: [{ tag: 'p' }, { tag: 'div' }],
      toDOM: () => ['p', 0],
    },
    text: {},
  },
});

const paragraph = (line: string): Node => schema.node('paragraph', null, line ? schema.text(line) : undefined);

/** The document for a text: one paragraph per line, an empty one for an empty text. */
export function docFromText(text: string): Node {
  return schema.node('doc', null, normalise(text).split('\n').map(paragraph));
}

/** What the box says: its paragraphs, a line each. */
export function textOf(doc: Node): string {
  const lines: string[] = [];
  doc.forEach((node) => lines.push(node.textContent));
  return lines.join('\n');
}

/** Pasted or dropped text as a slice of paragraphs whose ends join the paragraph it lands in. */
export function plainSlice(text: string): Slice {
  const lines = normalise(text).split('\n');
  return new Slice(Fragment.from(lines.map(paragraph)), 1, 1);
}

const normalise = (text: string): string => text.replace(/\r\n?/g, '\n');

/**
 * Where an offset into `textOf(doc)` is in the document. A line break of the text is the boundary
 * between two paragraphs, which takes two positions (the end of one, the start of the next).
 */
export function posOfOffset(doc: Node, offset: number): number {
  let seen = 0;
  let found = doc.content.size - 1;
  let done = false;
  doc.forEach((node, start) => {
    if (done) return;
    const length = node.content.size;
    if (offset <= seen + length) {
      found = start + 1 + Math.max(0, offset - seen);
      done = true;
      return;
    }
    seen += length + 1;
  });
  return found;
}

/** The offset into `textOf(doc)` of a document position: the inverse of {@link posOfOffset}. */
export function offsetOfPos(doc: Node, pos: number): number {
  let seen = 0;
  let found = 0;
  let done = false;
  doc.forEach((node, start) => {
    if (done) return;
    const length = node.content.size;
    if (pos <= start + 1 + length) {
      found = seen + Math.min(length, Math.max(0, pos - start - 1));
      done = true;
      return;
    }
    seen += length + 1;
    found = seen - 1;
  });
  return found;
}
