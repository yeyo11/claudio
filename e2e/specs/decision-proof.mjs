// What a spec does to make a decision point really act: earn its standing `proven` the way a person
// would, through the API the product ships, and only then set it to `active`
// (docs/plans/decision-engine-v2.md §5). `PUT /decisions/settings` refuses `active` on an act point,
// or on a suggest point that starts a run (`lesson.mine`), until the point has 30 live rows with a
// direct outcome or a stored replay over labelled states under its current questions. A sandbox has
// no live rows, so a replay it is: labelled states are imported (`POST /decisions/labels/import`),
// the CLI provider answers them (the fake CLI, which reads each case's answer from the state: see
// "A replayed case" in e2e/fake-cli/README.md) and the stored result is what the gate reads.
//
// Fake-CLI specs only (`export const fakeCli = true`): a replay asks the CLI once per case, and the
// real one would spend tokens. The replay is stored for good (there is no route to delete one), so a
// point stays proven for the rest of the sandbox's life; the labels this adds are deleted again.
import { setTimeout as sleep } from 'node:timers/promises';

const MARK = 'E2E-REPLAY';

/** `{ mine: true }` as the marker the fake CLI answers from, `E2E-REPLAY:mine=true` */
const markerOf = (answers) => `${MARK}:${Object.entries(answers).map(([id, value]) => `${id}=${String(value)}`).join(',')}`;

const ok = (response) => response.status >= 200 && response.status < 300;

/**
 * Makes `point` provable and proves it. Returns what to clean up with {@link forgetProof}.
 *
 * - `field`: the state field the point reads, which carries each case's marker. A string, since the
 *   marker is text the fake CLI finds in the prompt (`signals` for `lesson.mine`, `detail` for
 *   `supervisor.intervene`).
 * - `acting`: the answers that make the point act (the answer its effect acts on), e.g. `{ mine: true }`;
 *   `holding`: the answers that make it hold, e.g. `{ mine: false }`.
 * - `flagging`: true for a suggest point, whose gate wants a flag rate under the gate's limit as well
 *   as precision, so most cases hold; false for an act point, whose cases all act and are right.
 */
export async function earnStanding({ api, check }, point, { field, acting, holding, flagging = false, limit = 180_000 }) {
  const info = (await api.get('/decisions/points')).body.find((p) => p.id === point);
  check(!!info, `the catalogue lists ${point}`);
  const settings = (await api.get('/decisions/settings')).body;
  const gate = settings.gate ?? { minCases: 30, suggestMaxFlagRate: 0.3 };
  // The replay is judged on the cases it answered, so a few over the gate's minimum leave room for one that failed
  const total = Math.min(gate.minCases + 10, 500);
  const flagged = flagging ? Math.max(1, Math.floor(total * gate.suggestMaxFlagRate * 0.8)) : total;

  // A replay sends states out as a live request does, so it needs the point's own consent (CLI only)
  const consent = await api.put(`/decisions/points/${point}/consent`, { granted: true, stateVersion: info.stateVersion, providers: ['cli'] });
  check(ok(consent), `consent for ${point} was given for the replay (${consent.status} ${JSON.stringify(consent.body)})`);

  // Only the fallback: the replay builds the point's current questions itself
  const questions = [{ kind: 'noul', id: Object.keys(acting)[0] ?? 'answer', question: `e2e replay case of ${point}` }];
  const label = (i, acts) => ({
    point,
    // `case <n>` keeps every state different, so no row is taken for a repeat
    state: { [field]: `${markerOf(acts ? acting : holding)} case ${i}` },
    questions,
    positive: acts,
    note: 'e2e replay case',
  });
  const labels = Array.from({ length: total }, (_, i) => label(i, i < flagged));
  const imported = await api.post('/decisions/labels/import', { labels });
  check(ok(imported) && imported.body.imported === total, `${total} labelled states were imported for ${point} (${imported.status} ${JSON.stringify(imported.body)})`);

  const startedAt = Date.now();
  const started = await api.post('/decisions/replays', { point, provider: 'cli', limit: total, concurrency: 4, note: 'e2e: earn the gate' });
  check(ok(started), `a replay of ${point} started on the cli (${started.status} ${JSON.stringify(started.body)})`);

  // The result is stored when the run ends; a run that stored nothing says why under `failed`
  const end = Date.now() + limit;
  let stored;
  for (;;) {
    const list = (await api.get(`/decisions/replays?point=${point}`)).body;
    const failure = list.failed?.find((f) => f.point === point && Date.parse(f.at) >= startedAt - 1_000);
    if (failure) throw new Error(`decision-proof: the replay of ${point} failed: ${failure.message}`);
    stored = list.items.find((r) => Date.parse(r.at) >= startedAt - 1_000);
    if (stored) break;
    if (Date.now() > end) throw new Error(`decision-proof: timed out after ${limit} ms waiting for the replay of ${point} to be stored (${JSON.stringify(list.running)})`);
    await sleep(500);
  }
  check(stored.cases === total, `the replay covered ${total} cases (${stored.cases})`);
  check(stored.unavailable === 0, `the fake CLI answered every case (${stored.unavailable} unavailable)`);
  return { point, total };
}

/**
 * Sets `point` to `active` through the settings route, as a person would after the gate is cleared.
 * The refusal's body names what the point lacks, which is the message to read when it fails.
 */
export async function activate({ api, check }, point, threshold) {
  const { jev, ...update } = (await api.get('/decisions/settings')).body;
  const saved = await api.put('/decisions/settings', { ...update, points: { ...update.points, [point]: { mode: 'active', threshold, consent: null } } });
  check(saved.status === 200, `${point} is active (${saved.status} ${JSON.stringify(saved.body).slice(0, 600)})`);
  return saved;
}

/** Deletes the labels {@link earnStanding} imported; the stored replay stays (nothing deletes one) */
export async function forgetProof({ api }, point) {
  const labels = (await api.get(`/decisions/labels?point=${point}`)).body ?? [];
  for (const l of labels) if (l.note === 'e2e replay case') await api.del(`/decisions/labels/${l.id}`).catch(() => {});
}
