import type { GuardRuleId, GuardRuleInfo, GuardSettings } from './types.ts';

/** Every rule, `integrity` first; `integrity` is the only one that is not switchable. */
export const GUARD_RULES: readonly GuardRuleInfo[] = [
  { id: 'integrity', defaultOn: true, switchable: false },
  { id: 'no-verify', defaultOn: true, switchable: true },
  { id: 'push', defaultOn: true, switchable: true },
  { id: 'destructive', defaultOn: true, switchable: true },
  { id: 'secrets', defaultOn: true, switchable: true },
  { id: 'protect-configs', defaultOn: false, switchable: true },
];

export const GUARD_RULE_IDS: readonly GuardRuleId[] = GUARD_RULES.map((rule) => rule.id);

/** Most globs `protectConfigs` may hold. */
export const MAX_PROTECTED_CONFIGS = 200;

/**
 * Lint, format and CI configs `protect-configs` guards, as globs relative to a root.
 * `tsconfig*.json`, `package.json` and `pyproject.toml` are left out on purpose: they hold far more
 * than lint settings.
 */
export const DEFAULT_PROTECTED_CONFIGS: readonly string[] = [
  '.eslintrc*',
  'eslint.config.*',
  '.prettierrc*',
  'prettier.config.*',
  'biome.json',
  'biome.jsonc',
  '.stylelintrc*',
  'stylelint.config.*',
  '.editorconfig',
  '.markdownlint*',
  'ruff.toml',
  '.ruff.toml',
  '.flake8',
  '.pylintrc',
  'mypy.ini',
  '.golangci.y*ml',
  'rustfmt.toml',
  '.rustfmt.toml',
  'clippy.toml',
  '.rubocop.yml',
  '.clang-format',
  '.clang-tidy',
  'commitlint.config.*',
  '.commitlintrc*',
  '.lintstagedrc*',
  'lint-staged.config.*',
  'lefthook*.y*ml',
  '.pre-commit-config.yaml',
  '.github/workflows/**',
  '.gitlab-ci.yml',
  '.gitlab/ci/**',
  '.circleci/**',
  '.buildkite/**',
  'azure-pipelines.yml',
  'bitbucket-pipelines.yml',
  'Jenkinsfile',
];

/** A fresh install: guards on for automated runs, enforcing, `protect-configs` off (O2, O3). */
export const DEFAULT_GUARD_SETTINGS: Readonly<GuardSettings> = {
  mode: 'enforce',
  automated: true,
  rules: { 'no-verify': true, push: true, destructive: true, secrets: true, 'protect-configs': false },
  protectConfigs: [...DEFAULT_PROTECTED_CONFIGS],
  extraRoots: [],
};
