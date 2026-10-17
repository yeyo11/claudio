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
import { useId } from 'react';

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
