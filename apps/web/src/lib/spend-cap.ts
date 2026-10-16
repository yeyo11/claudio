import type { Orchestration, SpendState } from '@claudio/shared';
import { intlLocale } from '@claudio/ui/i18n/language';

/** The header that lets a person's request through the daily spend cap; a chat's token cannot send it. */
export const SPEND_OVERRIDE_HEADER = 'X-Claudio-Spend-Override';

/**
 * The scope a person's request is asked about once a day: the chat or graph it is for, or the kind
 * of start when there is no id yet. `null` for a request the cap never refuses. The routes are the
 * ones the server answers `409 spend-cap` on (docs/plans/agent-run-improvements.md).
 */
export function spendScope(method: string, path: string): string | null {
  if (method !== 'POST') return null;
  const clean = path.split('?')[0] ?? path;
  const id = (value: string | undefined): string => decodeURIComponent(value ?? '');
  if (clean === '/chats') return 'new-chat';
  if (clean === '/workflows/saved/run') return 'workflow';
  if (clean === '/orchestrations' || /^\/orchestrations\/templates\/[^/]+\/launch$/.test(clean)) return 'launch';
  if (clean === '/orchestrations/plan' || clean === '/orchestrations/plan/start') return 'plan';
  if (clean === '/assistant/chats') return 'assistant';
  const chat = /^\/chats\/([^/]+)\/(messages|resume|fork)$/.exec(clean);
  if (chat) return id(chat[1]);
  const graph = /^\/orchestrations\/([^/]+)\/(resume|relaunch|verify|tasks\/[^/]+\/(retry|retry-clean|rerun))$/.exec(clean);
  if (graph) return id(graph[1]);
  const assistant = /^\/projects\/([^/]+)\/assistant\/runs$/.exec(clean);
  if (assistant) return `assistant:${id(assistant[1])}`;
  return null;
}

/** The browser's local calendar day, which is the one a person remembers a choice for. */
export function localDay(now: Date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

const ackKey = (scope: string, now: Date): string => `claudio.spendCap.ack.${localDay(now)}.${scope}`;

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // a browser that refuses storage still gets asked: it just asks every time
    return null;
  }
}

/** Whether the person already chose to go on for this chat (or graph) today. */
export function spendAcknowledged(scope: string, now: Date = new Date()): boolean {
  return store()?.getItem(ackKey(scope, now)) === '1';
}

/** Remembers the choice for the rest of the local day, in this tab. */
export function acknowledgeSpend(scope: string, now: Date = new Date()): void {
  try {
    store()?.setItem(ackKey(scope, now), '1');
  } catch {
    // full or blocked storage: the next request asks again
  }
}

/** Asks the person whether to go on past the cap. The dialog the app mounts answers it; without one nobody can. */
export type SpendCapAsk = (spend: SpendState) => Promise<boolean>;

let ask: SpendCapAsk | null = null;

/** Registers the dialog; the returned function takes it away again. */
export function setSpendCapAsk(next: SpendCapAsk): () => void {
  ask = next;
  return () => {
    if (ask === next) ask = null;
  };
}

export const askSpendCap = (spend: SpendState): Promise<boolean> => (ask ? ask(spend) : Promise.resolve(false));

export type SpendTone = 'neutral' | 'warn' | 'bad';

export interface SpendView {
  tone: SpendTone;
  /** Whole percent of the cap, which may pass 100 */
  percent: number;
  /** The width of the bar: it stops at the full track */
  fill: number;
  exhausted: boolean;
  /** USD past the cap, from work that was already running; 0 below it */
  overUsd: number;
}

/**
 * What a reading of the cap looks like. The thresholds are the usage bars' (neutral below 60 %, warn
 * from 60 %, bad from 75 % and when exhausted), which the server already worked out as the level.
 * Null with no cap: there is nothing to show.
 */
export function spendView(state: SpendState): SpendView | null {
  if (state.capUsd === null || state.share === null || state.level === 'off') return null;
  const percent = Math.floor(state.share * 100 + 1e-9);
  const exhausted = state.level === 'exhausted';
  return {
    tone: exhausted || state.level === 'bad' ? 'bad' : state.level === 'warn' ? 'warn' : 'neutral',
    percent,
    fill: Math.min(100, percent),
    exhausted,
    overUsd: Math.max(0, Math.round((state.spentUsd - state.capUsd) * 100) / 100),
  };
}

/** When the day's spend starts again, in the server's own zone ("00:00"), as `resetsAt` is its midnight. */
export function spendResetTime(state: Pick<SpendState, 'resetsAt' | 'timezone'>): string {
  const at = new Date(state.resetsAt);
  if (Number.isNaN(at.getTime())) return '00:00';
  try {
    return new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: state.timezone }).format(at);
  } catch {
    return new Intl.DateTimeFormat(intlLocale(), { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  }
}

/**
 * How many of a graph's tasks only the cap holds back: what the server counts for the gate. A running
 * graph without today's pass, whose tasks are ready (every dependency done) and have no chat yet; a
 * workflow-engine graph holds all its pending tasks until its script starts. Zero while the gate is open.
 */
export function waitingForSpend(orch: Pick<Orchestration, 'status' | 'engine' | 'tasks' | 'workflow' | 'spendPass'>, spend: Pick<SpendState, 'blocked' | 'day'>): number {
  if (!spend.blocked || orch.status !== 'running' || orch.spendPass === spend.day) return 0;
  if (orch.engine === 'workflow') return orch.workflow?.runId ? 0 : orch.tasks.filter((task) => task.status === 'pending').length;
  const byId = new Map(orch.tasks.map((task) => [task.id, task]));
  return orch.tasks.filter((task) => task.status === 'pending' && !task.runId && (task.dependsOn ?? []).every((dep) => byId.get(dep)?.status === 'completed')).length;
}
