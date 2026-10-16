import type { BoardSettings, ProjectTeamRole, ProjectTemplate, ProjectTemplateId } from '@claudio/shared';
import { WORK_ITEM_TYPES } from '@claudio/shared';

/*
 * The five built-in templates of docs/plans/project-ecosystem.md, as data. A template carries
 * configuration, not only switches: which modules it turns on, which work item types its board
 * offers, the limits per column it starts with, and the team it would propose. It is applied once,
 * when a project is created or imported; editing the settings afterwards never re-applies it.
 *
 * Models follow the plan's rule: Opus for the roles that decide (Product Owner, Architect), Sonnet
 * for the ones that carry the work out.
 */

const PRODUCT_OWNER: ProjectTeamRole = { role: 'product-owner', model: 'opus', responsibility: 'Refines the backlog and writes acceptance criteria' };
const ARCHITECT: ProjectTeamRole = { role: 'architect', model: 'opus', responsibility: 'Decides the design and reviews it against the codebase' };
const DEVELOPER: ProjectTeamRole = { role: 'developer', model: 'sonnet', responsibility: 'Implements work items in their own worktree' };
const QA: ProjectTeamRole = { role: 'qa', model: 'sonnet', responsibility: 'Verifies each item against its acceptance criteria' };
const RESEARCHER: ProjectTeamRole = { role: 'researcher', model: 'opus', responsibility: 'Reads the sources and sets out what is known' };
const WRITER: ProjectTeamRole = { role: 'writer', model: 'sonnet', responsibility: 'Turns findings into documents' };
const REVIEWER: ProjectTeamRole = { role: 'reviewer', model: 'sonnet', responsibility: 'Checks documents for accuracy and clarity' };

/** Every type, no limits: the board a template that has no opinion about it offers. */
const OPEN_BOARD: BoardSettings = { types: [...WORK_ITEM_TYPES], columnLimits: {} };

// The review roles are read-only: no edits outside the documents folder, and a shell for git reads only
const GIT_READS = ['git diff *', 'git log *', 'git show *', 'git blame *', 'git grep *'];
const SILENT_FAILURE_HUNTER: ProjectTeamRole = {
  role: 'silent-failure-hunter',
  model: 'sonnet',
  responsibility: 'Finds failures that make no noise: swallowed errors, unawaited promises, hidden fallbacks',
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
  writes: [],
  commands: GIT_READS,
};
const TYPE_DESIGN_ANALYST: ProjectTeamRole = {
  role: 'type-design-analyst',
  model: 'opus',
  responsibility: 'Judges whether the types make illegal states unrepresentable',
  tools: ['Read', 'Grep', 'Glob', 'Bash'],
  writes: [],
  commands: GIT_READS,
};
// Meant to change code, so no `tools`, `writes` or `commands`: the stop rules in its guidance bound it
const BUILD_RESOLVER: ProjectTeamRole = { role: 'build-resolver', model: 'sonnet', responsibility: 'Makes a failing build, type check or lint pass with the smallest change' };
const SPEC_MINER: ProjectTeamRole = {
  role: 'spec-miner',
  model: 'opus',
  responsibility: 'Writes down what the code does today, from the code and its tests',
  tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'],
  writes: [],
  commands: GIT_READS,
};
const OPTIONAL_SOFTWARE_TEAM = [SILENT_FAILURE_HUNTER, TYPE_DESIGN_ANALYST, BUILD_RESOLVER, SPEC_MINER];

const SOFTWARE_TEAM = [PRODUCT_OWNER, ARCHITECT, DEVELOPER, QA];

export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: 'simple',
    name: 'Simple',
    description: 'A directory to chat in. No modules.',
    modules: [],
    board: OPEN_BOARD,
    team: [],
    optionalTeam: [],
  },
  {
    id: 'software',
    name: 'Professional software',
    description: 'Board, team, documents and shared memory, with limits on the columns where work piles up.',
    modules: ['board', 'team', 'documents', 'memory'],
    // Small limits on the two columns a team of agents fills fastest, so a pile-up shows early
    board: { types: [...WORK_ITEM_TYPES], columnLimits: { in_progress: 3, in_review: 2 } },
    team: SOFTWARE_TEAM,
    optionalTeam: OPTIONAL_SOFTWARE_TEAM,
  },
  {
    id: 'library',
    name: 'Library or package',
    description: 'A board of tasks and bugs, documents and shared memory. The team is offered when switched on.',
    modules: ['board', 'documents', 'memory'],
    // A library has users of its API rather than product stories
    board: { types: ['epic', 'task', 'bug'], columnLimits: { in_progress: 2 } },
    team: [ARCHITECT, DEVELOPER, QA],
    optionalTeam: OPTIONAL_SOFTWARE_TEAM,
  },
  {
    id: 'research',
    name: 'Research or documentation',
    description: 'Documents and shared memory first, with a board of epics and tasks to follow the work.',
    modules: ['board', 'documents', 'memory'],
    board: { types: ['epic', 'task'], columnLimits: {} },
    team: [RESEARCHER, WRITER, REVIEWER],
    optionalTeam: [SPEC_MINER],
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Everything off, for you to choose module by module.',
    modules: [],
    board: OPEN_BOARD,
    // Offered if the Team module is switched on later; the most complete team is the useful default
    team: SOFTWARE_TEAM,
    optionalTeam: OPTIONAL_SOFTWARE_TEAM,
  },
];

/** A copy, so whoever applies a template can never edit the built-in data through it. */
export function projectTemplate(id: ProjectTemplateId): ProjectTemplate {
  const template = PROJECT_TEMPLATES.find((t) => t.id === id);
  if (!template) throw new Error(`unknown template ${id}`);
  return structuredClone(template);
}
