import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReviewPath, parseFindings, parseVerdicts, REVIEW_FINDINGS_SCHEMA, REVIEW_VERDICTS_SCHEMA } from '../src/review-schemas.ts';

const finding = {
  title: 'Null index crashes the loader',
  severity: 'high',
  file: 'src/load.ts',
  line: 12,
  evidence: 'const x = rows[0].name',
  failureScenario: 'An empty table makes rows[0] undefined and the loader throws',
  confidence: 0.8,
};
const output = (findings: unknown[], coverage: unknown = { complete: true }) => ({ findings, coverage });

test('schemas keep the plan shape', () => {
  assert.deepEqual(REVIEW_FINDINGS_SCHEMA.required, ['findings', 'coverage']);
  assert.equal(REVIEW_FINDINGS_SCHEMA.properties.findings.maxItems, 25);
  assert.equal('verdict' in REVIEW_FINDINGS_SCHEMA.properties, false);
  assert.deepEqual(REVIEW_VERDICTS_SCHEMA.properties.verdicts.items.properties.status.enum, ['confirmed', 'refuted', 'uncertain']);
});

test('valid output parses', () => {
  const parsed = parseFindings(output([finding], { complete: true, filesRead: ['src/load.ts'] }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dropped, 0);
  assert.equal(parsed.findings[0]?.path, 'src/load.ts');
  assert.equal(parsed.findings[0]?.side, 'right');
  assert.deepEqual(parsed.coverage, { complete: true, notReviewed: null, filesRead: ['src/load.ts'] });
});

test('a string holding JSON parses; text that is not JSON is invalid', () => {
  assert.equal(parseFindings(JSON.stringify(output([finding]))).findings.length, 1);
  assert.equal(parseFindings('not json').ok, false);
  assert.equal(parseFindings(null).ok, false);
  assert.equal(parseFindings([]).ok, false);
});

test('missing top-level fields make the output invalid', () => {
  assert.equal(parseFindings({ findings: [] }).ok, false);
  assert.equal(parseFindings({ coverage: { complete: true } }).ok, false);
  assert.equal(parseFindings(output([], { complete: 'yes' })).ok, false);
  assert.equal(parseFindings(output([])).ok, true);
});

test('a finding missing a required field is dropped and counted', () => {
  const { evidence: _evidence, ...noEvidence } = finding;
  const parsed = parseFindings(output([finding, noEvidence, { ...finding, severity: 'urgent' }, { ...finding, title: 'short' }, 'x']));
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.dropped, 4);
  assert.equal(parsed.ok, true);
});

test('output whose every finding is dropped is not ok', () => {
  const parsed = parseFindings(output([{ ...finding, severity: 'urgent' }]));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.dropped, 1);
});

test('extra keys are dropped and long strings are cut', () => {
  const parsed = parseFindings(output([{ ...finding, verdict: 'approve', evidence: 'e'.repeat(2000), title: `${'t'.repeat(300)}` }]));
  const first = parsed.findings[0];
  assert.ok(first);
  assert.equal('verdict' in first, false);
  assert.equal(first.evidence.length, 1500);
  assert.equal(first.title.length, 160);
});

test('strings are trimmed', () => {
  assert.equal(parseFindings(output([{ ...finding, title: '   Padded title here   ' }])).findings[0]?.title, 'Padded title here');
});

test('paths are normalised and refused when absolute or climbing', () => {
  assert.equal(normalizeReviewPath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizeReviewPath('a/src/a.ts'), 'src/a.ts');
  assert.equal(normalizeReviewPath('b/src/a.ts'), 'src/a.ts');
  assert.equal(normalizeReviewPath('src\\win\\a.ts'), 'src/win/a.ts');
  assert.equal(normalizeReviewPath('/etc/passwd'), null);
  assert.equal(normalizeReviewPath('C:\\x\\y'), null);
  assert.equal(normalizeReviewPath('src/../../x'), null);
  assert.equal(normalizeReviewPath('..'), null);
  const parsed = parseFindings(output([{ ...finding, file: '/etc/passwd' }]));
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0]?.path, null);
});

test('side without a line is dropped; side old maps to left', () => {
  const { line: _line, ...noLine } = finding;
  assert.equal(parseFindings(output([{ ...noLine, side: 'old' }])).findings[0]?.side, null);
  assert.equal(parseFindings(output([{ ...finding, side: 'old' }])).findings[0]?.side, 'left');
  assert.equal(parseFindings(output([{ ...finding, side: 'new' }])).findings[0]?.side, 'right');
});

test('a bad line is dropped with its side', () => {
  const parsed = parseFindings(output([{ ...finding, line: 0, side: 'old' }, { ...finding, line: 1.5 }]));
  assert.equal(parsed.findings[0]?.line, null);
  assert.equal(parsed.findings[0]?.side, null);
  assert.equal(parsed.findings[1]?.line, null);
});

test('confidence out of range is clamped; a non-number drops the finding', () => {
  const parsed = parseFindings(output([{ ...finding, confidence: 7 }, { ...finding, confidence: -2 }, { ...finding, confidence: 'high' }]));
  assert.deepEqual(parsed.findings.map((f) => f.confidence), [1, 0]);
  assert.equal(parsed.dropped, 1);
});

test('more than 25 findings are cut and counted', () => {
  const parsed = parseFindings(output(Array.from({ length: 30 }, () => finding)));
  assert.equal(parsed.findings.length, 25);
  assert.equal(parsed.dropped, 5);
});

test('secrets are masked in every stored string', () => {
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const parsed = parseFindings(output([{ ...finding, evidence: `key = "${secret}"`, suggestion: `use ${secret}` }], { complete: false, notReviewed: `token ${secret}` }));
  const dump = JSON.stringify(parsed);
  assert.equal(dump.includes(secret), false);
});

test('verdicts: valid, string input, unknown ids ignored, missing ids unverified', () => {
  const raw = {
    verdicts: [
      { id: 'f1', status: 'confirmed', reason: 'The lines show it', evidence: 'load.ts:12' },
      { id: 'f9', status: 'confirmed', reason: 'Never asked' },
      { id: 'f3', status: 'maybe', reason: 'Bad status' },
    ],
  };
  const parsed = parseVerdicts(JSON.stringify(raw), ['f1', 'f2', 'f3']);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.verdicts.map((v) => [v.id, v.status]), [['f1', 'confirmed'], ['f2', 'unverified'], ['f3', 'unverified']]);
  assert.equal(parsed.verdicts[0]?.evidence, 'load.ts:12');
});

test('verdicts: output that is not an object leaves every id unverified', () => {
  const parsed = parseVerdicts('garbage', ['f1']);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.verdicts[0]?.status, 'unverified');
});

test('verdicts: the first answer for an id wins and reasons are masked', () => {
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
  const parsed = parseVerdicts(
    { verdicts: [{ id: 'f1', status: 'refuted', reason: `saw ${secret}` }, { id: 'f1', status: 'confirmed', reason: 'second' }] },
    ['f1'],
  );
  assert.equal(parsed.verdicts[0]?.status, 'refuted');
  assert.equal(JSON.stringify(parsed).includes(secret), false);
});
