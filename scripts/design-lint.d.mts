// Types for scripts/design-lint.mjs, which plain Node runs from the hooks and the command line.
export interface DesignProblem {
  file: string;
  line: number;
  rule: string;
  message: string;
  where: string;
}
export const REPO: string;
export const ROOTS: string[];
export const CAPS_SELECTORS: string[];
export function kindOf(path: string): 'css' | 'tsx' | 'locale' | null;
export function lintCss(file: string, css: string): DesignProblem[];
export function lintTsx(file: string, text: string): DesignProblem[];
export function lintLocale(file: string, text: string): DesignProblem[];
export function lintText(file: string, text: string): DesignProblem[];
export function lintFile(path: string): DesignProblem[];
export function coveredFiles(): string[];
export function format(problems: DesignProblem[]): string;
