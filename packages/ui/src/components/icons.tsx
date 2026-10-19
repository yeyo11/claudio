// Shared icon defaults and the few icon pickers that depend on data (tool names, file names).
import {
  Bot,
  Braces,
  FileCode2,
  FileJson2,
  FilePen,
  FileSearch,
  FileTerminal,
  FileText,
  FileType2,
  Globe,
  ListChecks,
  Plug,
  Search,
  SquareTerminal,
  Wand2,
  Wrench,
  type LucideIcon,
  type LucideProps,
} from 'lucide-react';
import { forwardRef, useId } from 'react';

/** Every icon in the app uses this size/stroke unless a component says otherwise. */
export const ICON: LucideProps = { size: 16, strokeWidth: 1.75, 'aria-hidden': true };
export const ICON_SM: LucideProps = { size: 14, strokeWidth: 1.75, 'aria-hidden': true };

/**
 * Claudio's mark: the open C, the spark and the prompt block, as in
 * docs/design-system/claudio-brand-kit/logos/svg/claudio-symbol.svg. Colours come from classes in
 * styles/shell.css (presentation attributes don't resolve var()), so the spark can turn from cyan
 * to blue in the light theme. Not `.brand-mark`: that is a program's logo on its light tile.
 */
export function BrandMark({ size = 26 }: { size?: number }) {
  // useId() returns ':r0:'-style ids, and the colons break url(#…)
  const gradient = `logo${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="9.5 10 100 100" aria-hidden focusable="false">
      <defs>
        <linearGradient id={gradient} x1="0.35" y1="0" x2="0.6" y2="1">
          <stop className="logo-stop-a" offset="0" />
          <stop className="logo-stop-a" offset="0.5" />
          <stop className="logo-stop-b" offset="1" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${gradient})`}
        d="M41.76 14.24Q46 10 52 10L71 10Q74 10 76.12 12.12L93.88 29.88Q96 32 93 32L57 32Q54 32 51.88 34.12L34.83 51.17Q32 54 32 58L32 62Q32 66 34.83 68.83L51.88 85.88Q54 88 57 88L93 88Q96 88 93.88 90.12L76.12 107.88Q74 110 71 110L52 110Q46 110 41.76 105.76L14.24 78.24Q10 74 10 68L10 52Q10 46 14.24 41.76Z"
      />
      <path className="logo-spark" d="M62 41Q68 54 81 60Q68 66 62 79Q56 66 43 60Q56 54 62 41Z" />
      <rect className="logo-spark" x="98" y="51.5" width="11" height="17" rx="3" />
    </svg>
  );
}

const SPARK_PATH = 'M0 -19Q6 -6 19 0Q6 6 0 19Q-6 6 -19 0Q-6 -6 0 -19Z';

/**
 * Claudio, the assistant's mascot in colour: the logo's prompt block as a small character with
 * eyes looking up, and the spark above it, as in docs/design-system/illustrations/claudio-mark.svg.
 * It speaks where the assistant speaks (the first message of its chat), from 20 px up. Colours come
 * from `.mascot-mark` in styles/primitives.css; the eyes paint with the page's --bg.
 */
export function ClaudioMascot({ size = 24 }: { size?: number }) {
  return (
    <svg className="mascot-mark" width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false">
      <rect className="mascot-body" x="2.5" y="6.5" width="12.5" height="17" rx="3.5" />
      <ellipse className="mascot-eye" cx="9.3" cy="12.2" rx="1.2" ry="1.65" />
      <ellipse className="mascot-eye" cx="12.5" cy="12.2" rx="1.2" ry="1.65" />
      <path className="mascot-spark" transform="translate(19.2 5) scale(0.235)" d={SPARK_PATH} />
    </svg>
  );
}

/**
 * Claudio in one colour (docs/design-system/illustrations/claudio-glyph.svg), for icon slots at 14
 * and 16 px: it takes the slot's colour like the stroke icons beside it, so a live run's tile turns
 * it --live and the sidebar shows no static cyan. Typed as a LucideIcon so NavItem, the palette and
 * MenuItem accept it; it is a filled character, so `strokeWidth` does not apply and is ignored.
 */
export const ClaudioGlyph: LucideIcon = forwardRef<SVGSVGElement, Omit<LucideProps, 'ref'>>(function ClaudioGlyph(
  { size = 16, color, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absolute, ...rest },
  ref,
) {
  return (
    <svg ref={ref} width={size} height={size} viewBox="0 0 16 16" fill={color ?? 'currentColor'} focusable="false" {...rest}>
      <path
        fillRule="evenodd"
        d="M3.75 3.75H7.0A2.25 2.25 0 0 1 9.25 6.0V13.25A2.25 2.25 0 0 1 7.0 15.5H3.75A2.25 2.25 0 0 1 1.5 13.25V6.0A2.25 2.25 0 0 1 3.75 3.75ZM4.75 8.4A0.8 1.15 0 1 0 6.35 8.4A0.8 1.15 0 1 0 4.75 8.4ZM6.95 8.4A0.8 1.15 0 1 0 8.55 8.4A0.8 1.15 0 1 0 6.95 8.4Z"
      />
      <path transform="translate(12.4 3.6) scale(0.1737)" d={SPARK_PATH} />
    </svg>
  );
});

const TOOL_ICONS: Array<[RegExp, LucideIcon]> = [
  [/^(bash|powershell|repl|monitor)/i, SquareTerminal],
  [/^(read|notebookread)/i, FileText],
  [/^(edit|write|multiedit|notebookedit)/i, FilePen],
  [/^(grep|glob|toolsearch)/i, FileSearch],
  [/^(websearch)/i, Search],
  [/^(webfetch)/i, Globe],
  [/^(task|agent|sendmessage|listagents)/i, Bot],
  [/^(todo|task(create|get|list|update|output|stop))/i, ListChecks],
  [/^skill/i, Wand2],
  [/^mcp__/i, Plug],
];

export function toolIcon(name: string): LucideIcon {
  // Task* bookkeeping tools must win over the generic Task (subagent) rule
  if (/^task(create|get|list|update|output|stop)/i.test(name)) return ListChecks;
  return TOOL_ICONS.find(([re]) => re.test(name))?.[1] ?? Wrench;
}

export function fileIcon(name: string): LucideIcon {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'json') return FileJson2;
  if (ext === 'md' || ext === 'txt') return FileText;
  if (['sh', 'bash', 'zsh'].includes(ext)) return FileTerminal;
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py'].includes(ext)) return FileCode2;
  if (['yaml', 'yml', 'toml'].includes(ext)) return Braces;
  return FileType2;
}

/** Deterministic hue from a name, for project monograms. */
export function nameHue(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/**
 * The letters of a monogram: the first of each of the first two words. A project always gets two
 * (design system, decision 10: `claude-wrapper` CW, `pagos-api` PA), taking the first two letters of
 * a lone word (`notas` NO); a person keeps one, since their mark stands beside their name. Words are
 * letters and digits in any script, so `señales-éxito` is SE and not a stray ASCII fragment.
 */
export function monogramLetters(name: string, pair = false): string {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const [first = '', second] = words;
  if (pair && second === undefined) return Array.from(first).slice(0, 2).join('').toUpperCase();
  return words
    .slice(0, 2)
    .map((part) => Array.from(part)[0]?.toUpperCase() ?? '')
    .join('');
}

/** A project's two letters, the one rule every project mark follows. */
export function projectMonogram(name: string): string {
  return monogramLetters(name, true);
}

export function Monogram({ name, size = 36, project = false }: { name: string; size?: number; /** Two letters even for one word */ project?: boolean }) {
  const letters = monogramLetters(name, project);
  return (
    <span className="monogram" style={{ '--hue': nameHue(name), '--monogram-size': `${size}px`, width: size, height: size } as React.CSSProperties} aria-hidden>
      {letters || '?'}
    </span>
  );
}
