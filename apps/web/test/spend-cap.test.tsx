// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { AppSettings, Orchestration, SpendState } from '@claudio/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { api, ApiRequestError, keys } from '../src/api';
import { TooltipProvider } from '@claudio/ui/components/controls/Tooltip';
import { ToastProvider } from '@claudio/ui/components/Toast';
import { SpendLineView } from '../src/components/SpendLine';
import { OrchestrationSpendWait, SpendQueuedLine, SpendWaitSummary } from '../src/components/SpendWait';
import { SpendItem } from '../src/components/shell/StatusBar';
import i18n, { setLanguage } from '../src/i18n';
import { en, es } from '../src/i18n/resources';
import { targetsFor } from '../src/lib/events';
import { acknowledgeSpend, setSpendCapAsk, spendAcknowledged, spendResetTime, spendScope, spendView, waitingForSpend } from '../src/lib/spend-cap';
import { changedSettings, SpendCard, SpendFields, validCap } from '../src/pages/config/AppSettingsCards';
import { formatPercent } from '@claudio/ui/lib/format';

// The daily spend cap's web (docs/plans/agent-run-improvements.md, idea 13): the status bar item
// and its words, the settings card in each state, and the question a refused request asks before it
// is sent again with the override, once a day per chat.

const state = (spentUsd: number, over: Partial<SpendState> = {}): SpendState => {
  const capUsd = over.capUsd === undefined ? 20 : over.capUsd;
  const share = capUsd === null ? null : spentUsd / capUsd;
  const level = share === null ? 'off' : share >= 1 ? 'exhausted' : share >= 0.75 ? 'bad' : share >= 0.6 ? 'warn' : 'ok';
  return {
    day: '2026-10-16',
    timezone: 'Europe/Madrid',
    capUsd,
    spentUsd,
    share,
    level,
    blocked: level === 'exhausted',
    resetsAt: '2026-10-16T22:00:00.000Z',
    unreported: 0,
    byPurpose: {},
    byAccountKind: { login: 0, token: 0, apiKey: 0, unknown: 0 },
    waiting: { flowRuns: 0, orchestrationTasks: 0 },
    ...over,
  };
};

const settings = (cap: number | null, source: 'env' | 'file' | 'default' = 'default'): AppSettings => ({
  allowedHosts: [],
  maxConcurrentRuns: 4,
  defaultPermissionMode: 'manual',
  setupSeen: false,
  dailySpendCapUsd: cap,
  evalsPhase2: false,
  sources: { allowedHosts: 'default', maxConcurrentRuns: 'default', defaultPermissionMode: 'default', setupSeen: 'default', dailySpendCapUsd: source, evalsPhase2: 'default' },
  allowedHostLayers: { env: [], file: [], runtime: [] },
});

function wrap(children: ReactNode, spend?: SpendState) {
  const client = new QueryClient();
  if (spend) client.setQueryData(keys.spend, spend);
  const html = renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // The toast region is the provider's own, empty until something is said
  return html.replace(/<div class="toasts"[^>]*><\/div>/, '');
}

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const speak = async (language: 'en' | 'es') => {
  setLanguage(language);
  await i18n.changeLanguage(language);
};

test.beforeEach(() => speak('en'));
test.after(() => speak('en'));

test('the status bar draws nothing with no cap, and nothing when the reading is missing', () => {
  assert.equal(wrap(<SpendItem />, state(3, { capUsd: null })), '');
  assert.equal(wrap(<SpendItem />), '', 'no reading, no invented figure');
});

test('the status bar item is neutral below 60 %, warn from 60 %, bad from 75 %, each with its words', () => {
  const neutral = wrap(<SpendItem />, state(8));
  assert.match(neutral, /class="statusbar-item spend"/);
  assert.ok(text(neutral).includes(`daily cap ${formatPercent(40)}`));
  assert.doesNotMatch(neutral, /statusbar-warn|statusbar-bad|is-warn|is-bad/);

  const warn = wrap(<SpendItem />, state(12));
  assert.match(warn, /statusbar-item spend statusbar-warn/);
  assert.match(warn, /meter-fill is-warn/);
  assert.ok(text(warn).includes(`daily cap ${formatPercent(60)} near the cap`));

  const bad = wrap(<SpendItem />, state(16));
  assert.match(bad, /statusbar-item spend statusbar-bad/);
  assert.match(bad, /meter-fill is-bad/);
  assert.ok(text(bad).includes(`daily cap ${formatPercent(80)}`));
  assert.doesNotMatch(text(bad), /near the cap/);
});

test('an exhausted cap says it, and when work comes back in the server’s own time zone', () => {
  const html = wrap(<SpendItem />, state(21));
  assert.match(html, /statusbar-item spend statusbar-bad/);
  assert.match(text(html), /cap reached · back at 00:00/);
  assert.doesNotMatch(html, /meter-track/, 'the words replace the bar once there is nothing left to measure');
});

test('the status bar says it in Spanish too', async () => {
  await speak('es');
  assert.match(text(wrap(<SpendItem />, state(12))), /tope diario 60 % cerca del tope/);
  assert.match(text(wrap(<SpendItem />, state(21))), /tope alcanzado · vuelve a las 00:00/);
});

test('the Usage line shows the cap with the same bar and words, and what was spent past it', () => {
  const html = text(renderToStaticMarkup(<MemoryRouter><SpendLineView state={state(21, { unreported: 2 })} /></MemoryRouter>));
  assert.match(html, /Daily cap · \$21\.00 of \$20\.00/);
  assert.ok(html.includes(formatPercent(105)));
  assert.match(html, /cap reached · back at 00:00/);
  assert.match(html, /\$1\.00 over the cap, from work that was already running/);
  assert.match(html, /2 results without a cost/);
  assert.match(html, /on subscription accounts it is what the use would cost on the API/);
  assert.equal(renderToStaticMarkup(<MemoryRouter><SpendLineView state={state(3, { capUsd: null })} /></MemoryRouter>), '');
});

test('the settings section shows off, on, set by the environment and invalid', () => {
  const off = wrap(<SpendCard saved={settings(null)} />);
  // The section's heading names it; the form starts at its switch
  assert.match(text(off), /^ ?Limit daily spend/);
  assert.match(off, /data-setting="spend-cap\.daily"/);
  assert.match(text(off), /No cap: nothing waits for the day’s spend\./);
  assert.match(text(wrap(<SpendCard saved={settings(null)} />, state(3, { capUsd: null }))), /Today \$3\.00, and no cap: nothing waits for it\./);
  assert.match(off, /role="switch"[^>]*aria-checked="false"/);
  assert.doesNotMatch(off, /type="number"/, 'the amount appears once the cap is on');
  assert.match(text(off), /On subscription accounts it is what it would cost on the API, not what you pay\./);

  const on = wrap(<SpendCard saved={settings(20, 'file')} />, state(8));
  assert.match(on, /role="switch"[^>]*aria-checked="true"/);
  assert.match(on, /type="number"[^>]*value="20"/);
  // The consequence, against the amount: today's spend and its share, then what the cap does
  assert.ok(text(on).includes(`Today $8.00 of $20.00, ${formatPercent(40)}.`));
  assert.match(text(on), /Over the cap, automatic work waits and chats ask first\./);
  assert.doesNotMatch(on, /set by the environment/);

  const env = wrap(<SpendCard saved={settings(50, 'env')} />);
  assert.match(env, /disabled=""/);
  assert.match(text(env), /set by the environment/);
  assert.match(text(env), /CLAUDIO_DAILY_SPEND_CAP_USD/);
  assert.doesNotMatch(env, /type="submit"/, 'nothing to save: only the environment can change it');

  const invalid = wrap(<SpendFields on amount={-3} fromEnv={false} invalid spentUsd={null} onToggle={() => {}} onAmount={() => {}} />);
  assert.match(invalid, /class="field-error" role="alert"/);
  assert.match(text(invalid), /Enter an amount above 0 and up to \$100,000\.00/);
});

test('a whole amount is a valid cap: the browser never refuses the form for its step', () => {
  const on = wrap(<SpendCard saved={settings(20, 'file')} />, state(8));
  assert.match(on, /type="number"[^>]*step="any"/);
});

test('the cap is sent only when it moved, never when the environment set it', () => {
  assert.equal(validCap(20), 20);
  assert.equal(validCap(0.004), null, 'rounds to 0 cents');
  assert.equal(validCap(100_001), null);
  assert.equal(validCap(12.345), 12.35);
  assert.equal(validCap(undefined), null);
  assert.deepEqual(changedSettings(settings(null), { dailySpendCapUsd: 20 }), { dailySpendCapUsd: 20 });
  assert.deepEqual(changedSettings(settings(20, 'file'), { dailySpendCapUsd: null }), { dailySpendCapUsd: null });
  assert.deepEqual(changedSettings(settings(20, 'file'), { dailySpendCapUsd: 20 }), {});
  assert.deepEqual(changedSettings(settings(50, 'env'), { dailySpendCapUsd: 20 }), {});
});

test('the settings section says what it is in Spanish', async () => {
  await speak('es');
  assert.match(text(wrap(<SpendCard saved={settings(null)} />)), /Limitar el gasto diario/);
  const on = text(wrap(<SpendCard saved={settings(20, 'file')} />, state(8)));
  // text() folds the no-break spaces Intl puts in amounts and percentages
  assert.ok(on.includes(`Hoy 8,00 US$ de 20,00 US$, el ${formatPercent(40).replace(/\s/g, ' ')}.`));
  assert.match(on, /Por encima del tope, el trabajo automático espera y los chats preguntan antes\./);
});

test('the views read the same level the server computed', () => {
  assert.equal(spendView(state(5, { capUsd: null })), null);
  assert.deepEqual(spendView(state(12)), { tone: 'warn', percent: 60, fill: 60, exhausted: false, overUsd: 0 });
  assert.deepEqual(spendView(state(25)), { tone: 'bad', percent: 125, fill: 100, exhausted: true, overUsd: 5 });
  assert.equal(spendResetTime(state(1)), '00:00');
  assert.equal(spendResetTime({ resetsAt: '2026-10-16T22:00:00.000Z', timezone: 'Atlantic/Canary' }), '23:00');
});

test('the spend events make the next reading the views', () => {
  const event = { type: 'spend.changed', id: 1, at: '2026-10-16T10:00:00Z', title: 'Daily spend changed', spend: state(1) } as const;
  assert.deepEqual(targetsFor(event)[0]?.[0], keys.spend);
});

test('a card waits under the cap only while it is reached, and offers the pass without being a live region', () => {
  assert.equal(wrap(<SpendQueuedLine itemId="w1" />, state(8)), '');
  const html = wrap(<SpendQueuedLine itemId="w1" />, state(21));
  assert.match(html, /class="wait-line"/);
  assert.doesNotMatch(html, /role="status"/, 'a board with several held cards must not announce each');
  assert.match(text(html), /Waiting for the daily cap · back at 00:00/);
  assert.match(text(html), /Go on today anyway/);
  assert.doesNotMatch(text(wrap(<SpendQueuedLine itemId="w1" inline />, state(21))), /Go on today anyway/, 'a list row has no button');
});

test('the board speaks the held cards once, in one polite live region', () => {
  const held = state(21, { waiting: { flowRuns: 3, orchestrationTasks: 0 } });
  const html = wrap(<SpendWaitSummary />, held);
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
  assert.match(html, /aria-live="polite"/);
  assert.match(text(html), /3 cards are waiting for the daily cap · back at 00:00/);
  assert.doesNotMatch(text(wrap(<SpendWaitSummary />, state(8))), /waiting/);
});

const graph = (over: Partial<Orchestration> = {}): Orchestration =>
  ({
    id: 'o1',
    name: 'graph',
    status: 'running',
    engine: 'agents',
    spendPass: null,
    tasks: [
      { id: 'a', status: 'completed', runId: 'c1', dependsOn: [] },
      { id: 'b', status: 'pending', runId: null, dependsOn: ['a'] },
      { id: 'c', status: 'pending', runId: null, dependsOn: ['a'] },
      { id: 'd', status: 'pending', runId: null, dependsOn: ['b'] },
    ],
    ...over,
  }) as unknown as Orchestration;

test('a graph counts the tasks only the cap holds back, and a pass lifts them', () => {
  const closed = state(21);
  assert.equal(waitingForSpend(graph(), closed), 2, 'b and c are ready; d waits on b');
  assert.equal(waitingForSpend(graph({ spendPass: '2026-10-16' }), closed), 0);
  assert.equal(waitingForSpend(graph({ spendPass: '2026-10-15' }), closed), 2, 'a pass is for one day');
  assert.equal(waitingForSpend(graph(), state(8)), 0);
  assert.equal(waitingForSpend(graph({ status: 'stopped' }), closed), 0);

  const html = wrap(<OrchestrationSpendWait orch={graph()} />, closed);
  assert.match(text(html), /2 tasks wait for the daily cap · back at 00:00/);
  assert.match(text(html), /Go on today anyway/);
  assert.equal(wrap(<OrchestrationSpendWait orch={graph({ spendPass: '2026-10-16' })} />, closed), '');
});

test('the dialog, the wait lines and the notifications keep en/es parity', () => {
  const paths = (value: unknown, prefix = ''): string[] =>
    typeof value === 'object' && value !== null ? Object.entries(value).flatMap(([key, child]) => paths(child, `${prefix}${key}.`)) : [prefix.replace(/_(one|other)\.$/, '.').slice(0, -1)];
  for (const [ns, branch] of [
    ['components', 'spendCap'],
    ['components', 'notificationText'],
    ['shell', 'statusbar'],
    ['usage', 'cap'],
    ['orchestration', 'spendWait'],
    ['work', 'spendWait'],
    ['config', 'appSettings'],
  ] as const) {
    const pick = (resources: typeof en) => paths(((resources as unknown as Record<string, Record<string, unknown>>)[ns] ?? {})[branch]);
    assert.deepEqual([...new Set(pick(es))].sort(), [...new Set(pick(en))].sort(), `${ns}:${branch}`);
  }
});

// ---- The question a refused request asks ----

class MemoryStorage {
  private readonly values = new Map<string, string>();
  getItem = (key: string) => this.values.get(key) ?? null;
  setItem = (key: string, value: string) => void this.values.set(key, value);
}

interface Sent {
  url: string;
  override: string | null;
}

/** A server over the cap: it refuses every send that does not carry the override. */
function overCap() {
  const sent: Sent[] = [];
  const stub: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const override = headers.get('x-claudio-spend-override');
    sent.push({ url: String(input), override });
    if (override !== '1') return new Response(JSON.stringify({ error: 'The daily spend cap was reached', code: 'spend-cap', spend: state(21) }), { status: 409 });
    return new Response(JSON.stringify({ message: { id: 'm1' } }), { status: 200 });
  };
  return { sent, stub };
}

test('the dialog resends with the override and does not ask again for the same chat the same day', async () => {
  const realFetch = globalThis.fetch;
  const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
  const asked: SpendState[] = [];
  const stop = setSpendCapAsk(async (spend) => {
    asked.push(spend);
    return true;
  });
  const server = overCap();
  globalThis.fetch = server.stub;
  try {
    await api.sendMessage('chat-a', { text: 'hello' });
    assert.equal(asked.length, 1);
    assert.deepEqual(server.sent.map((s) => s.override), [null, '1'], 'refused once, then sent again with the header');
    assert.equal(asked[0]?.capUsd, 20);

    await api.sendMessage('chat-a', { text: 'and again' });
    assert.equal(asked.length, 1, 'not asked again for the same chat today');
    assert.equal(server.sent[2]?.override, '1', 'it goes with the header at once');

    await api.sendMessage('chat-b', { text: 'another conversation' });
    assert.equal(asked.length, 2, 'another chat asks for itself');
  } finally {
    stop();
    globalThis.fetch = realFetch;
    if (realStorage) Object.defineProperty(globalThis, 'sessionStorage', realStorage);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('a "no" sends nothing and keeps the refusal as the error', async () => {
  const realFetch = globalThis.fetch;
  const stop = setSpendCapAsk(async () => false);
  const server = overCap();
  globalThis.fetch = server.stub;
  try {
    await assert.rejects(
      () => api.createChat({ prompt: 'hi' }),
      (err) => err instanceof ApiRequestError && err.status === 409 && err.code === 'spend-cap' && err.spend?.capUsd === 20 && err.message === 'Nothing was started: the daily spend cap was reached.',
    );
    assert.equal(server.sent.length, 1, 'not sent again');
    assert.equal(spendAcknowledged('new-chat'), false);
  } finally {
    stop();
    globalThis.fetch = realFetch;
  }
});

test('what a person chose is remembered per chat and per local day', () => {
  const realStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { value: new MemoryStorage(), configurable: true });
  try {
    const today = new Date(2026, 9, 16, 10, 0);
    acknowledgeSpend('chat-a', today);
    assert.equal(spendAcknowledged('chat-a', today), true);
    assert.equal(spendAcknowledged('chat-a', new Date(2026, 9, 16, 23, 59)), true);
    assert.equal(spendAcknowledged('chat-a', new Date(2026, 9, 17, 0, 1)), false, 'the next day asks again');
    assert.equal(spendAcknowledged('chat-b', today), false);
    assert.equal((globalThis.sessionStorage as unknown as MemoryStorage).getItem('claudio.spendCap.ack.2026-10-16.chat-a'), '1');
  } finally {
    if (realStorage) Object.defineProperty(globalThis, 'sessionStorage', realStorage);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});

test('only the routes the cap refuses have a scope', () => {
  assert.equal(spendScope('POST', '/chats'), 'new-chat');
  assert.equal(spendScope('POST', '/chats/abc/messages'), 'abc');
  assert.equal(spendScope('POST', '/chats/abc/resume'), 'abc');
  assert.equal(spendScope('POST', '/chats/abc/fork'), 'abc');
  assert.equal(spendScope('POST', '/chats/abc/stop'), null);
  assert.equal(spendScope('GET', '/chats/abc/messages'), null);
  assert.equal(spendScope('POST', '/workflows/saved/run'), 'workflow');
  assert.equal(spendScope('POST', '/orchestrations'), 'launch');
  assert.equal(spendScope('POST', '/orchestrations/plan/start'), 'plan');
  assert.equal(spendScope('POST', '/orchestrations/templates/t1/launch'), 'launch');
  assert.equal(spendScope('POST', '/orchestrations/o1/resume'), 'o1');
  assert.equal(spendScope('POST', '/orchestrations/o1/tasks/t1/retry-clean'), 'o1');
  assert.equal(spendScope('POST', '/orchestrations/o1/tasks/t1/skip'), null);
  assert.equal(spendScope('POST', '/orchestrations/o1/spend-pass'), null, 'the pass is the answer, not a start');
  assert.equal(spendScope('POST', '/projects/p1/assistant/runs'), 'assistant:p1');
  assert.equal(spendScope('POST', '/assistant/chats'), 'assistant');
});
