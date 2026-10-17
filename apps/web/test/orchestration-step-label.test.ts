import assert from 'node:assert/strict';
import test from 'node:test';
import i18n from '../src/i18n';
import { stepLabel, type OrchestrationStep } from '../src/lib/orchestration-steps';

const STEPS: OrchestrationStep[] = [
  { id: 'stage-1', kind: 'stage', state: 'pending', index: 0, tasks: [], completed: 0 },
  { id: 'integration', kind: 'integration', state: 'pending' },
  { id: 'verification', kind: 'verification', state: 'pending' },
  { id: 'synthesis', kind: 'synthesis', state: 'pending' },
  { id: 'pull-request', kind: 'pull-request', state: 'pending' },
  { id: 'phase-1', kind: 'phase', state: 'pending', phase: null, agents: [], tasks: [] },
  { id: 'workflow', kind: 'workflow', state: 'pending', tasks: [] },
];

for (const [lng, pullRequest] of [['en', 'Push & open PR'], ['es', 'Subir y abrir la PR']] as const) {
  test(`no step of an orchestration is labelled with an unfilled template in ${lng}`, async () => {
    await i18n.changeLanguage(lng);
    const t = i18n.getFixedT(lng, ['config', 'orchestrationV2'] as const);
    for (const step of STEPS) assert.doesNotMatch(stepLabel(t, 'PR', step), /\{\{|\}\}/, step.kind);
    // The step before any pull request exists names the action, with the host's noun
    assert.equal(stepLabel(t, 'PR', STEPS[4] as OrchestrationStep), pullRequest);
  });
}
