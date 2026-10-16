// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import { toolRisk, type EditStep, type ToolRisk } from '@claudio/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { StepScrubber } from '../src/components/changes/steps/StepScrubber';
import { StepRisk } from '../src/components/changes/steps/StepRisk';
import { riskySteps } from '../src/components/changes/steps/steps-model';
import i18n from '../src/i18n';

// The risk of a step (idea 9 of docs/plans/agent-run-improvements.md): a tag in the list and the
// detail header, and a ring with words on the scrubber's high-risk dots.

const ctx = { cwd: '/work/app' };
const CI = toolRisk({ name: 'Edit', input: { file_path: '/work/app/.github/workflows/ci.yml' } }, ctx);
const OUTSIDE = toolRisk({ name: 'Write', input: { file_path: '/etc/hosts' } }, ctx);

const step = (index: number, path: string, risk?: ToolRisk): EditStep => ({
  id: `toolu_${index}`,
  index,
  at: '2026-09-28T10:00:00Z',
  tool: 'Edit',
  path,
  additions: 1,
  deletions: 0,
  diff: '',
  created: false,
  intent: null,
  entryIndex: index,
  pending: false,
  ...(risk ? { risk } : {}),
});

const STEPS = [step(1, 'src/a.ts'), step(2, '.github/workflows/ci.yml', CI), step(3, '/etc/hosts', OUTSIDE)];

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <MemoryRouter>
      <TooltipProvider>{node}</TooltipProvider>
    </MemoryRouter>,
  );

test('a high step carries a bad tag with its word, a medium one a muted tag, a low one nothing', async () => {
  await i18n.changeLanguage('en');
  assert.equal(OUTSIDE.level, 'high');
  assert.equal(CI.level, 'medium');
  const high = render(<StepRisk risk={OUTSIDE} inLink />);
  assert.match(high, /badge-bad/);
  assert.match(high, /Outside the working directory/);
  assert.match(high, /data-risk="high"/);
  const medium = render(<StepRisk risk={CI} inLink />);
  assert.match(medium, /badge-muted/);
  assert.match(medium, /Sensitive file/);
  assert.equal(render(<StepRisk risk={undefined} />), '');
});

test('the tag is in Spanish with the Spanish words', async () => {
  await i18n.changeLanguage('es');
  assert.match(render(<StepRisk risk={OUTSIDE} />), /Fuera del directorio de trabajo/);
  await i18n.changeLanguage('en');
});

test('outside a list row the tag can be reached with the keyboard, inside one the link is the stop', () => {
  assert.match(render(<StepRisk risk={OUTSIDE} />), /tabindex="0"/);
  assert.doesNotMatch(render(<StepRisk risk={OUTSIDE} inLink />), /tabindex/);
});

test('only the high steps mark the scrubber, with words for a screen reader', async () => {
  await i18n.changeLanguage('en');
  const html = render(<StepScrubber steps={STEPS} currentId="toolu_1" onPick={() => undefined} />);
  assert.equal(html.match(/data-risk="high"/g)?.length, 1);
  assert.match(html, /<i[^>]*data-step="toolu_3"[^>]*data-risk="high"[^>]*aria-label="3 · hosts · High risk"/);
  assert.doesNotMatch(html, /<i[^>]*data-step="toolu_2"[^>]*data-risk/);
  // The group names how many there are, since its dots are drawn as one image
  assert.match(html, /aria-label="Step 1 of 3, 1 step of high risk"/);
  assert.equal(riskySteps(STEPS), 1);

  const calm = render(<StepScrubber steps={[STEPS[0] as EditStep]} currentId="toolu_1" onPick={() => undefined} />);
  assert.doesNotMatch(calm, /data-risk/);
  assert.match(calm, /aria-label="Step 1 of 1"/);
});
