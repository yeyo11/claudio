// What a control's accessible name holds against the text it shows, read from server-rendered
// markup. It follows axe-core's `label-content-name-mismatch` (WCAG 2.5.3, Label in Name): the
// words a sighted person sees on a control must appear, in order and together, in the name a
// voice user says to reach it, when that name is given in words of its own. Like axe, the visible text is every text node drawn on screen,
// aria-hidden ones included (a status letter is still drawn) and `.sr-only` ones left out, and the
// pieces are joined with nothing between them: two chips side by side read as one word unless a
// space sits between them.

interface Element {
  tag: string;
  attrs: Record<string, string>;
  children: Node[];
}
type Node = Element | string;

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' };

const decode = (text: string) => text.replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name] ?? whole);

function parse(html: string): Element {
  const root: Element = { tag: '#root', attrs: {}, children: [] };
  const stack: Element[] = [root];
  const tag = /<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>/g;
  let at = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    const top = stack[stack.length - 1] ?? root;
    if (m.index > at) top.children.push(decode(html.slice(at, m.index)));
    at = tag.lastIndex;
    const [, closing, rawName = '', rawAttrs = '', selfClosing] = m;
    const name = rawName.toLowerCase();
    if (closing) {
      const open = stack.map((e) => e.tag).lastIndexOf(name);
      if (open > 0) stack.length = open;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of rawAttrs.matchAll(/([^\s=>/]+)(?:="([^"]*)")?/g)) if (a[1]) attrs[a[1]] = decode(a[2] ?? '');
    const element: Element = { tag: name, attrs, children: [] };
    top.children.push(element);
    if (!selfClosing && !VOID.has(name) && name !== 'svg') stack.push(element);
    // An icon's svg carries no text: skip its content
    if (name === 'svg' && !selfClosing) {
      const end = html.indexOf('</svg>', at);
      at = end < 0 ? html.length : end + '</svg>'.length;
      tag.lastIndex = at;
    }
  }
  if (at < html.length) (stack[stack.length - 1] ?? root).children.push(decode(html.slice(at)));
  return root;
}

const classes = (e: Element) => (e.attrs.class ?? '').split(/\s+/);

/** The text drawn on screen, as axe reads it: hidden-from-AT text counts, off-screen text does not. */
function visibleText(node: Node): string {
  if (typeof node === 'string') return node;
  if (classes(node).includes('sr-only')) return '';
  return node.children.map(visibleText).join('');
}

/** The name a control gets from its content: aria-hidden subtrees out, an img's own label in. */
function contentName(node: Node): string {
  if (typeof node === 'string') return node;
  if (node.attrs['aria-hidden'] === 'true' || node.attrs['aria-hidden'] === '') return '';
  if (node.attrs.role === 'img' && node.attrs['aria-label']) return node.attrs['aria-label'];
  return node.children.map(contentName).join('');
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/** A control's accessible name: its aria-label, or else what its content says. */
export function accessibleName(e: Element): string {
  return squash(e.attrs['aria-label'] ?? contentName(e));
}

/** Words as axe compares them: no parentheticals, letters and digits only, lower case. */
function tokens(text: string): string[] {
  let s = text.normalize('NFKD').toLowerCase();
  for (let before = ''; before !== s; ) {
    before = s;
    s = s.replace(/\([^()]*\)/g, '');
  }
  return s
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

function contains(name: string[], label: string[]): boolean {
  if (label.length === 0) return true;
  for (let i = 0; i + label.length <= name.length; i++) if (label.every((word, j) => name[i + j] === word)) return true;
  return false;
}

function walk(node: Node, into: Element[] = []): Element[] {
  if (typeof node === 'string') return into;
  into.push(node);
  for (const child of node.children) walk(child, into);
  return into;
}

// The widgets whose name can come from their content, which is what the rule looks at
const NAMED_BY_CONTENT = new Set(['button', 'link', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'checkbox', 'radio', 'treeitem']);
const roleOf = (e: Element) => e.attrs.role ?? (e.tag === 'button' ? 'button' : e.tag === 'a' && 'href' in e.attrs ? 'link' : null);

export interface Control {
  role: string;
  className: string;
  name: string;
  visible: string;
  /** The visible words are in the name, in order and together */
  holds: boolean;
}

/** Every control in the markup that a person can reach, with its name and the text it shows. */
export function controls(html: string): Control[] {
  return walk(parse(html))
    .filter((e) => {
      const role = roleOf(e);
      return role !== null && NAMED_BY_CONTENT.has(role);
    })
    .map((e) => {
      const visible = squash(visibleText(e));
      const name = accessibleName(e);
      // Like axe, only a name given in words of its own (aria-label) can leave the visible text
      // out, and a lone glyph is not a label anyone can say, so it is not held against the name
      const labelled = 'aria-label' in e.attrs;
      const sayable = tokens(visible).join('').length > 1;
      return { role: roleOf(e) ?? '', className: e.attrs.class ?? '', name, visible, holds: !labelled || !sayable || contains(tokens(name), tokens(visible)) };
    });
}

/** The controls whose name leaves out what they show; empty when the markup keeps the rule. */
export function labelMismatches(html: string): string[] {
  return controls(html)
    .filter((c) => !c.holds)
    .map((c) => `${c.role} shows "${c.visible}" but is named "${c.name}"`);
}

/** Whether `name` holds the words of `visible`, in order and together, as the rule compares them. */
export function holdsWords(name: string, visible: string): boolean {
  return contains(tokens(name), tokens(visible));
}
