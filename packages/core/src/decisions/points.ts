import type {
  DecisionAnswer,
  DecisionBaseline,
  DecisionChoiceQuestion,
  DecisionNoulQuestion,
  DecisionPointId,
  DecisionPointKind,
  DecisionPrimitive,
  DecisionQuestion,
  DecisionRunEffect,
  DecisionScope,
  DecisionScoreQuestion,
  DecisionSubjectKind,
} from '@claudio/shared';
import { DECISION_POINT_IDS } from './settings.ts';

/*
 * The catalogue of decision points (docs/plans/decision-engine.md, "Decision points on main"). Each
 * entry declares what the point may send and what it asks; a call site only hands the engine a
 * subject. Every question and rubric is English (D4): the providers read `label` and `description`.
 */

/** What a call site knows about the thing being decided; the point's builder picks what is sent */
export interface DecisionSubject {
  kind: DecisionSubjectKind;
  id: string | null;
  /** Everything the caller has. Only the point's `fields` are ever sent, after redaction */
  data: Record<string, unknown>;
}

export interface DecisionPointDefinition {
  id: DecisionPointId;
  kind: DecisionPointKind;
  scope: DecisionScope;
  primitives: readonly DecisionPrimitive[];
  /** Default confidence an act point needs; ignored by suggest points */
  defaultThreshold: number;
  /** Bytes of state the point may send, after redaction */
  maxStateBytes: number;
  /** What acting on an answer does, read against today's behaviour; the evidence layer reads it */
  effect: DecisionPointEffect;
  /** True when acting on it changes something a person sees (shows the "decided" mark) */
  visible: boolean;
  /** The provider must be fast enough for the call site; only Jev is */
  needsLowLatency: boolean;
  /** Bumps when the shape of the state changes, which clears the consent given for an older one */
  stateVersion: number;
  /** The subject fields the state may carry, and nothing else */
  fields: readonly string[];
  buildState(subject: DecisionSubject): Promise<Record<string, unknown>>;
  questions(subject: DecisionSubject): ReadonlyArray<DecisionQuestion>;
}

const DEFAULT_MAX_STATE_BYTES = 8 * 1024;
/** Batches that ask one question per item stay well inside a provider's option and token limits */
const MAX_ITEMS = 40;

const choice = (id: string, question: string, options: Array<[string, string]>): DecisionChoiceQuestion => ({
  kind: 'choice',
  id,
  question,
  options: options.map(([optionId, label]) => ({ id: optionId, label })),
});
const noul = (id: string, question: string): DecisionNoulQuestion => ({ kind: 'noul', id, question });
const score = (id: string, question: string, levels: Array<[string, string]>): DecisionScoreQuestion => ({
  kind: 'score',
  id,
  question,
  levels: levels.map(([levelId, description]) => ({ id: levelId, description })),
});

const isMap = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The items of a list field the caller hands over, each with a string `id` (what the answers are keyed by) */
function items(subject: DecisionSubject, field: string): Array<Record<string, unknown> & { id: string }> {
  const raw = subject.data[field];
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is Record<string, unknown> & { id: string } => isMap(item) && typeof item.id === 'string').slice(0, MAX_ITEMS);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * What acting on a point's answers does, against today's behaviour (docs/plans/decision-engine-v2.md,
 * M2, M4 and M6). "Acts" names the answer that changes what happens (act points) or raises a flag
 * (suggest points): its precision is what a point must prove, and the code rule's `baseline` is read
 * the same way so the two can be compared row by row.
 */
export interface DecisionPointEffect {
  /** Runs acting on these answers saves (1) or causes (-1) against today's behaviour; `baseline` refines it when the call site gave one */
  runs(answers: Record<string, DecisionAnswer>, baseline: DecisionBaseline | null): DecisionRunEffect;
  /** Whether these answers are the ones that act or flag; null when they say neither (a ranking, a model per task) */
  acts(answers: Record<string, DecisionAnswer>, state: Record<string, unknown>): boolean | null;
  /** The same reading of the code rule's answer; null when the baseline is absent or not one this point reads */
  baselineActs(baseline: DecisionBaseline | null): boolean | null;
  /** For the catalogue: whether some answer can save a run, and whether some answer can cause one */
  savesRun: boolean;
  causesRun: boolean;
}

const choiceValue = (answers: Record<string, DecisionAnswer>, id: string): string | null => {
  const a = answers[id];
  return a?.kind === 'choice' ? a.value : null;
};
const noulValue = (answers: Record<string, DecisionAnswer>, id: string): boolean | null => {
  const a = answers[id];
  return a?.kind === 'noul' ? a.value : null;
};

/** A baseline of `true`/`false` is read as it is by every point: "the code rule acts" or not */
const booleanBaseline = (baseline: DecisionBaseline | null): boolean | null => (typeof baseline === 'boolean' ? baseline : null);

/** The answer to one choice question acts when it is `option`; a baseline is that option's id, or a boolean */
function choiceEffect(id: string, option: string, runs: DecisionRunEffect = 0): DecisionPointEffect {
  return {
    runs: (answers) => (choiceValue(answers, id) === option ? runs : 0),
    acts: (answers) => {
      const value = choiceValue(answers, id);
      return value === null ? null : value === option;
    },
    baselineActs: (baseline) => (typeof baseline === 'string' ? baseline === option : booleanBaseline(baseline)),
    savesRun: runs > 0,
    causesRun: runs < 0,
  };
}

/** The answer to one yes/no question acts when it is `value` */
function noulEffect(id: string, value: boolean, runs: DecisionRunEffect = 0): DecisionPointEffect {
  return {
    runs: (answers) => (noulValue(answers, id) === value ? runs : 0),
    acts: (answers) => {
      const answer = noulValue(answers, id);
      return answer === null ? null : answer === value;
    },
    baselineActs: booleanBaseline,
    savesRun: runs > 0,
    causesRun: runs < 0,
  };
}

/** Per-item questions: the row acts when any item's answer is `option` (a choice) or `value` (a yes/no) */
function anyEffect(match: (answer: DecisionAnswer) => boolean, runs: DecisionRunEffect = 0): DecisionPointEffect {
  const any = (answers: Record<string, DecisionAnswer>): boolean => Object.values(answers).some(match);
  return {
    runs: (answers) => (any(answers) ? runs : 0),
    acts: (answers) => (Object.keys(answers).length === 0 ? null : any(answers)),
    baselineActs: booleanBaseline,
    savesRun: runs > 0,
    causesRun: runs < 0,
  };
}

/** A suggest point of yes/no questions flags on any yes; the code rule never flags */
const FLAGS: DecisionPointEffect = anyEffect((a) => a.kind === 'noul' && a.value);

/** A point whose answers neither act nor flag one way: rankings, a model per task, a prefill */
const SILENT: DecisionPointEffect = { runs: () => 0, acts: () => null, baselineActs: () => null, savesRun: false, causesRun: false };

/**
 * `run.continuation` acts by continuing (`owes-work`). Against the phrase list it replaces: a
 * continuation the phrase list would also have sent costs nothing extra, and `done` saves a run only
 * where the phrase list would have continued. With no baseline (rows stored before it), the contract's
 * values: `done` saves one, `owes-work` causes one.
 */
const CONTINUATION: DecisionPointEffect = {
  runs: (answers, baseline) => {
    const report = choiceValue(answers, 'report');
    const phrased = continuationBaseline(baseline);
    if (report === 'owes-work') return phrased === true ? 0 : -1;
    if (report === 'done') return phrased === false ? 0 : 1;
    return 0;
  },
  acts: (answers) => {
    const report = choiceValue(answers, 'report');
    return report === null ? null : report === 'owes-work';
  },
  baselineActs: (baseline) => continuationBaseline(baseline),
  savesRun: true,
  causesRun: true,
};

/** The phrase list's items continue the run when there is any; a boolean says so directly */
function continuationBaseline(baseline: DecisionBaseline | null): boolean | null {
  if (Array.isArray(baseline)) return baseline.length > 0;
  return booleanBaseline(baseline);
}

type Base = Pick<DecisionPointDefinition, 'id' | 'kind' | 'scope' | 'primitives' | 'fields'> & Partial<Pick<DecisionPointDefinition, 'maxStateBytes' | 'effect' | 'visible' | 'needsLowLatency' | 'stateVersion'>>;

function point(base: Base, questions: DecisionPointDefinition['questions']): DecisionPointDefinition {
  return {
    defaultThreshold: 0.85,
    maxStateBytes: DEFAULT_MAX_STATE_BYTES,
    effect: base.kind === 'suggest' ? FLAGS : SILENT,
    visible: true,
    needsLowLatency: false,
    stateVersion: 1,
    ...base,
    buildState: (subject) => {
      const state: Record<string, unknown> = {};
      for (const field of base.fields) if (subject.data[field] !== undefined) state[field] = subject.data[field];
      return Promise.resolve(state);
    },
    questions,
  };
}

const CRITERION = [
  ['met-or-unknown', 'The criterion is met, or nothing here says whether it is'],
  ['needs-a-person', 'Only a person can check this criterion; no run can'],
  ['clearly-unmet', 'The criterion is clearly not met by the work described'],
] as Array<[string, string]>;

/** `team.assign` flags when it proposes another member than the column's own (`state.assigned`) */
const TEAM_ASSIGN: DecisionPointEffect = {
  ...SILENT,
  acts: (answers, state) => {
    const member = choiceValue(answers, 'member');
    return member === null ? null : member !== (typeof state.assigned === 'string' ? state.assigned : null);
  },
  baselineActs: booleanBaseline,
};

/** `palette.intent` proposes a command unless it answers `none` */
const PALETTE: DecisionPointEffect = {
  ...SILENT,
  acts: (answers) => {
    const command = choiceValue(answers, 'command');
    return command === null ? null : command !== 'none';
  },
  baselineActs: booleanBaseline,
};

/** `account.model-fallback` proposes a mapping unless it answers `none` */
const MODEL_FALLBACK: DecisionPointEffect = {
  ...SILENT,
  acts: (answers) => {
    const model = choiceValue(answers, 'model');
    return model === null ? null : model !== 'none';
  },
  baselineActs: booleanBaseline,
};

export const DECISION_POINTS: readonly DecisionPointDefinition[] = [
  point({ id: 'flow.refine-needed', kind: 'act', scope: 'project', primitives: ['choice'], effect: choiceEffect('refine', 'ready', 1), fields: ['title', 'description', 'type', 'criteria', 'labels', 'sizeEstimate'] }, () => [
    choice('refine', 'Can this card be built as written, or must it be refined first?', [
      ['ready', 'Ready: the description and acceptance criteria are specific enough to build without refining'],
      ['refine', 'Needs refining: the description or acceptance criteria are vague, missing or contradictory'],
    ]),
  ]),
  point({ id: 'flow.bounce', kind: 'act', scope: 'project', primitives: ['choice'], effect: choiceEffect('bounce', 'needs-person', 1), fields: ['rejection', 'criteria', 'bounces'] }, () => [
    choice('bounce', "QA rejected this card. Can the Developer fix what QA reported without a person's input?", [
      ['fixable', 'Fixable: the Developer can address every reported problem alone'],
      ['needs-person', 'Needs a person: a decision, access or clarification only a person can give is missing'],
    ]),
  ]),
  point({ id: 'context.compact', kind: 'act', scope: 'project', primitives: ['choice'], effect: choiceEffect('compact', 'compact-first'), maxStateBytes: 1024, fields: ['stage', 'share', 'usedTokens', 'window', 'bounces', 'rejectionChars'] }, () => [
    choice('compact', 'A developer is about to continue its own earlier conversation after QA sent the card back. Should that conversation be compacted first?', [
      ['compact-first', 'Compact first: the context is full enough that the next round would likely be compacted mid-task anyway'],
      ['continue', 'Continue as it is: there is room, and compacting would lose detail the next round needs'],
    ]),
  ]),
  point({ id: 'orchestration.retry', kind: 'act', scope: 'project', primitives: ['choice'], effect: choiceEffect('retry', 'permanent', 1), fields: ['error', 'task', 'attempt'] }, () => [
    choice('retry', 'A task failed with this error. Will trying again in the same chat help?', [
      ['transient', 'Transient: the failure looks temporary and a plain retry will likely work'],
      ['fixable', 'Fixable: a retry can work because the task can adjust to the error'],
      ['permanent', 'Permanent: the same error will come back however many times it is retried'],
    ]),
  ]),
  point({ id: 'supervisor.intervene', kind: 'act', scope: 'global', primitives: ['noul'], effect: noulEffect('intervene', false, 1), fields: ['signal', 'detail', 'calls'] }, () => [
    noul('intervene', 'Is this worker stuck in a way a short hint from a supervisor could get it out of?'),
  ]),
  point({ id: 'memory.triage', kind: 'suggest', scope: 'project', primitives: ['score'], effect: anyEffect((a) => a.kind === 'score' && (a.value === 'high' || a.value === 'medium')), fields: ['proposal', 'target', 'memoryTitles', 'journalTitles'] }, () => [
    score('usefulness', 'How useful is this proposed memory entry to future runs of the project?', [
      ['duplicate', 'Duplicate: an existing entry or journal line already says the same'],
      ['low', 'Low: specific to one moment, or obvious from the code'],
      ['medium', 'Medium: true and occasionally useful'],
      ['high', 'High: a durable fact or rule that future runs would otherwise get wrong'],
    ]),
  ]),
  point({ id: 'assistant.rerank', kind: 'suggest', scope: 'project', primitives: ['score'], fields: ['proposals', 'agents', 'skills', 'commands', 'members'] }, (subject) =>
    items(subject, 'proposals').map((p) =>
      score(p.id, `How valuable is this proposal (${text(p.title)}) for the project?`, [
        ['covered', 'Already covered by something the project has'],
        ['minor', 'Minor: a small gain'],
        ['useful', 'Useful: fills a real gap'],
        ['key', 'Key: the project is clearly missing this'],
      ]),
    ),
  ),
  point({ id: 'assistant.sources', kind: 'act', scope: 'project', primitives: ['noul'], effect: anyEffect((a) => a.kind === 'noul' && !a.value), fields: ['brief', 'files'] }, (subject) =>
    items(subject, 'files').map((f) => noul(f.id, `Will the run need to read the file ${text(f.name) || f.id} to do the brief?`)),
  ),
  point({ id: 'journal.relevance', kind: 'act', scope: 'project', primitives: ['score'], effect: anyEffect((a) => a.kind === 'score' && a.value === 'irrelevant'), maxStateBytes: 16 * 1024, visible: false, fields: ['title', 'criteria', 'entries'] }, (subject) =>
    items(subject, 'entries').map((e) =>
      score(e.id, 'How relevant is this journal entry to the work described?', [
        ['irrelevant', 'Irrelevant: about something unrelated'],
        ['related', 'Related: same area, but the work does not depend on it'],
        ['relevant', 'Relevant: the work should take it into account'],
        ['essential', 'Essential: ignoring it would likely break or repeat earlier work'],
      ]),
    ),
  ),
  point({ id: 'lesson.mine', kind: 'suggest', scope: 'project', primitives: ['noul'], effect: noulEffect('mine', true, -1), visible: false, fields: ['signals'] }, () => [
    noul('mine', 'Do these signals show a person correcting, stopping or overruling the agent in a way that should change how agents work in this project from now on, beyond this one task?'),
  ]),
  point({ id: 'board.triage', kind: 'suggest', scope: 'project', primitives: ['choice', 'noul'], effect: SILENT, fields: ['title', 'description', 'openItems', 'epics'] }, () => [
    choice('type', 'What kind of work item is this draft?', [
      ['task', 'A task: routine work with a clear end'],
      ['bug', 'A bug: something that worked and no longer does, or never worked as intended'],
      ['story', 'A story: a user-visible capability with several tasks behind it'],
    ]),
    choice('priority', 'How urgent is this draft?', [
      ['low', 'Low: nice to have'],
      ['medium', 'Medium: planned work'],
      ['high', 'High: blocks or degrades real use'],
      ['urgent', 'Urgent: something is broken for people now'],
    ]),
    noul('duplicate', 'Does an existing open item already cover this draft?'),
  ]),
  point({ id: 'team.assign', kind: 'suggest', scope: 'project', primitives: ['choice'], effect: TEAM_ASSIGN, fields: ['title', 'type', 'criteria', 'members'] }, (subject) => {
    const members = items(subject, 'members');
    if (members.length < 2) return [];
    return [choice('member', 'Which team member is the best fit for this card?', members.map((m): [string, string] => [m.id, `${text(m.role) || m.id}: ${text(m.responsibilities)}`.trim()]))];
  }),
  point({ id: 'flow.scope-drift', kind: 'suggest', scope: 'project', primitives: ['noul'], fields: ['title', 'criteria', 'commits'] }, (subject) =>
    items(subject, 'commits').map((c) => noul(c.id, 'Does this commit do work beyond what the card asks for?')),
  ),
  point({ id: 'flow.criteria-precheck', kind: 'act', scope: 'project', primitives: ['choice'], effect: anyEffect((a) => a.kind === 'choice' && a.value === 'clearly-unmet', 1), fields: ['criteria', 'summary', 'commits', 'paths'] }, (subject) =>
    items(subject, 'criteria').map((c) => choice(c.id, `Given the work described, where does this acceptance criterion stand: "${text(c.text)}"?`, CRITERION)),
  ),
  point({ id: 'flow.criteria-merge', kind: 'suggest', scope: 'project', primitives: ['noul'], fields: ['existing', 'proposed'] }, (subject) =>
    items(subject, 'proposed').map((c) => noul(c.id, 'Does this proposed criterion say the same as one of the existing criteria?')),
  ),
  point({ id: 'flow.restart', kind: 'act', scope: 'project', primitives: ['noul'], effect: noulEffect('requeue', false, 1), visible: false, fields: ['stage', 'cause', 'restarts', 'error'] }, () => [
    noul('requeue', 'Is it worth running this flow run again after the restart cut it?'),
  ]),
  point({ id: 'run.continuation', kind: 'act', scope: 'project', primitives: ['choice'], effect: CONTINUATION, visible: false, maxStateBytes: 4 * 1024, fields: ['title', 'tail', 'continuations'] }, () => [
    choice('report', 'Is the last paragraph of this run a final report, or does it say work is still owed?', [
      ['done', 'Done: a report of finished work; nothing is left to do'],
      ['owes-work', 'Owes work: it announces a next step, offers to continue or leaves something undone'],
    ]),
  ]),
  point({ id: 'orchestration.model', kind: 'suggest', scope: 'project', primitives: ['choice'], effect: SILENT, fields: ['tasks', 'models'] }, (subject) => {
    const models = items(subject, 'models');
    if (models.length < 2) return [];
    return items(subject, 'tasks').map((t) => choice(t.id, 'Which model is the cheapest one that can do this task well?', models.map((m): [string, string] => [m.id, text(m.label) || m.id])));
  }),
  point({ id: 'orchestration.fixer', kind: 'act', scope: 'project', primitives: ['noul'], effect: noulEffect('another-attempt', false, 1), fields: ['checks', 'failedSpecs', 'notes', 'attempt'] }, () => [
    noul('another-attempt', 'Is another fixer attempt likely to make these failing checks pass?'),
  ]),
  point({ id: 'health.semantic-loop', kind: 'suggest', scope: 'global', primitives: ['noul'], fields: ['calls'] }, () => [
    noul('loop', 'Is this worker repeating the same kind of step without making progress?'),
  ]),
  point({ id: 'health.test-weakening', kind: 'suggest', scope: 'global', primitives: ['noul'], fields: ['path', 'before', 'after'] }, () => [
    noul('weakened', 'Does this edit make the test weaker: fewer or looser assertions, skipped cases or a tautology?'),
  ]),
  point({ id: 'changes.unexplained-hunk', kind: 'suggest', scope: 'project', primitives: ['noul'], fields: ['hunk', 'step', 'title'] }, () => [
    noul('unexplained', 'Does the sentence before the change fail to explain this hunk?'),
  ]),
  point({ id: 'palette.intent', kind: 'suggest', scope: 'global', primitives: ['choice'], effect: PALETTE, needsLowLatency: true, maxStateBytes: 16 * 1024, fields: ['query', 'commands'] }, (subject) => {
    const commands = items(subject, 'commands');
    if (commands.length === 0) return [];
    return [choice('command', 'Which command does the query ask for?', [...commands.map((c): [string, string] => [c.id, text(c.title) || c.id]), ['none', 'None of these commands'] as [string, string]])];
  }),
  // `risk` is the riskiest tool call of the chat in its last ten minutes, one line; version 2 asks for consent again with it in the preview
  point({ id: 'notification.urgency', kind: 'act', scope: 'global', primitives: ['choice'], effect: choiceEffect('urgency', 'high'), visible: false, maxStateBytes: 2 * 1024, stateVersion: 2, fields: ['kind', 'title', 'body', 'risk'] }, () => [
    choice('urgency', 'Should this notification interrupt the person now?', [
      ['normal', 'Normal: it can wait until the person next looks'],
      ['high', 'High: the person would want to know right away'],
    ]),
  ]),
  // The tails are the host's CI output, untrusted: they are data for the question and nothing else. `headSha` is what the resolver reads the outcome against
  point({ id: 'checks.fix', kind: 'act', scope: 'project', primitives: ['choice'], effect: choiceEffect('fix', 'branch-fixable', -1), maxStateBytes: 32 * 1024, fields: ['checks', 'attempt', 'diffStat', 'headSha'] }, () => [
    choice('fix', 'Did the changes on this branch cause these check failures, in a way the Developer can fix?', [
      ['branch-fixable', 'Branch-fixable: the branch caused the failures and the Developer can fix them by changing code'],
      ['not-branch', 'Not the branch: infrastructure, a flaky test or a change unrelated to this branch'],
      ['needs-person', 'Needs a person: a decision, access or a secret only a person can give is missing'],
    ]),
  ]),
  // Light or full: there is no `skip`, because a model choosing to skip the gate would be a path that fails open. The resolver arrives with the gate runner
  point({ id: 'review.depth', kind: 'act', scope: 'project', primitives: ['choice'], effect: choiceEffect('depth', 'light'), maxStateBytes: 4 * 1024, fields: ['files', 'added', 'deleted', 'paths', 'securityHit', 'dimensions', 'estimateUsd'] }, () => [
    choice('depth', 'How deep should the review of this branch go?', [
      ['light', 'Light: the change is small or mechanical, so correctness (and security when it applies) is enough'],
      ['full', 'Full: the change is large, risky or touches behaviour, so every dimension should review it'],
    ]),
  ]),
  // Review comments are other people's text: they are data for the question and nothing else. The caller hands the unresolved threads; at most 40 are asked, each body already cut to 1 KiB
  point({ id: 'review.triage', kind: 'suggest', scope: 'project', primitives: ['choice'], effect: SILENT, maxStateBytes: 64 * 1024, fields: ['title', 'threads'] }, (subject) =>
    items(subject, 'threads').map((thread) =>
      choice(thread.id, `Who should take this review comment${text(thread.path) ? ` on ${text(thread.path)}` : ''}?`, [
        ['agent', 'An agent: it asks for a concrete code change the Developer can make'],
        ['person', 'A person: it is a question, a design decision or a disagreement'],
        ['no-action', 'No action: praise, a point already resolved or a nit already done'],
      ]),
    ),
  ),
  // An issue is a stranger's text: it is data for the question and nothing else. The caller hands one page of the import list; at most 40 are asked, each body already cut to 2 KiB
  point({ id: 'issue.triage', kind: 'suggest', scope: 'project', primitives: ['choice'], effect: SILENT, maxStateBytes: 96 * 1024, fields: ['tracker', 'issues', 'notTriaged'] }, (subject) =>
    items(subject, 'issues').map((issue) =>
      // The title stays in the state: a question's text is sent and stored as it is, without the masking and the byte cut the state gets
      choice(issue.id, `Can an agent start on issue ${text(issue.id)} as written?`, [
        ['ready', 'Ready: the goal and the acceptance are clear and the work is inside the repository'],
        ['needs-refining', 'Needs refining: the goal or the acceptance is unclear'],
        ['not-for-agents', 'Not for agents: it needs a person, for access, a decision or work outside the repository'],
      ]),
    ),
  ),
  // The candidates are what the account with headroom offers, from its cached `initialize` list: the question's options are built from them, so the answer is always a model that account can run. A person accepts the mapping; the answer alone changes nothing
  point({ id: 'account.model-fallback', kind: 'suggest', scope: 'global', primitives: ['choice'], effect: MODEL_FALLBACK, fields: ['model', 'candidates'] }, (subject) => {
    const candidates = items(subject, 'candidates').map((c) => ({ id: c.id, label: text(c.displayName) || c.id, tier: text(c.tier) }));
    if (candidates.length === 0) return [];
    return [
      choice('model', `No account with headroom can run ${text(subject.data.model) || 'this chat\'s model'}. Which of these models is the nearest to it: the same line first, then the tier below?`, [
        ...candidates.map((c): [string, string] => [c.id, `${c.label}${c.tier ? ` (${c.tier})` : ''}`]),
        ['none', 'None: nothing here is close enough, so the chat should wait for an account that can run its model'],
      ]),
    ];
  }),
];

const BY_ID: ReadonlyMap<DecisionPointId, DecisionPointDefinition> = new Map(DECISION_POINTS.map((p) => [p.id, p]));

export function decisionPoint(id: DecisionPointId): DecisionPointDefinition | undefined {
  return BY_ID.get(id);
}

// A point missing from the catalogue would compile into a hole in the settings; refuse at load
for (const id of DECISION_POINT_IDS) if (!BY_ID.has(id)) throw new Error(`decision point ${id} has no definition`);
