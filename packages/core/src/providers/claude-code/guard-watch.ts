import type { GuardOutcome, GuardRuleId, RunGuardEvent } from '@claudio/shared';
import { maskSecrets } from '../../decisions/redact.ts';
import type { DriverEvent } from '../driver.ts';

/** Every line of a hook's stderr that starts with this is the guard speaking (docs/plans/guards.md, "Marker parsing") */
export const GUARD_MARK = 'claudio-guard/1 ';

/**
 * Tools that run without a guard marker, so a result with none is no fault. g0 recorded every tool
 * the CLI lists as hooked; `StructuredOutput` only hands back the answer a schema asked for and
 * writes nothing.
 */
export const GUARD_UNHOOKED_TOOLS: ReadonlySet<string> = new Set(['StructuredOutput']);

const RULES: ReadonlySet<string> = new Set(['integrity', 'no-verify', 'push', 'destructive', 'secrets', 'protect-configs', 'declared-tools']);
/** Block markers the guard prints when it failed rather than judged: the call was blocked, the cause is ours */
const FAULT_MATCHERS: ReadonlySet<string> = new Set(['integrity.guard-error', 'integrity.deadline', 'integrity.rules-unavailable', 'integrity.input-too-large', 'integrity.bad-input']);
const EXCERPT_MAX = 240;
const REMEMBERED = 2000;
const ID = /^[\w.:-]{1,128}$/;

interface Call {
  name: string;
  excerpt: string;
}

interface Marker {
  kind: 'pass' | 'block' | 'observe' | 'allowed-once';
  id: string;
  rule: GuardRuleId;
  matcher: string;
  reason: string;
}

/** The command or path a call is about, masked and cut: what a person reads in the transcript line */
function excerptOf(input: unknown): string {
  const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const text = ['command', 'file_path', 'notebook_path', 'path', 'url'].map((key) => fields[key]).find((value): value is string => typeof value === 'string');
  return maskSecrets(text ?? '').replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX);
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.set(key, value);
  for (const old of map.keys()) {
    if (map.size <= REMEMBERED) break;
    map.delete(old);
  }
}

/**
 * Reads the guard's markers out of `hook_response` events and holds them against the tool calls the
 * stream shows: every call needs its marker before its result (D6). Hook events without a marker are
 * the person's own hooks and say nothing here.
 */
export class GuardWatch {
  /** Calls seen and not yet spoken for */
  private readonly awaiting = new Map<string, Call>();
  /** Calls whose marker arrived, so a call announced twice is not awaited again */
  private readonly settled = new Map<string, true>();
  /** Markers for a call the stream has not shown yet; none is expected, the CLI emits the call first (F3) */
  private readonly early = new Map<string, Marker>();
  /**
   * Calls awaited when an interrupt was asked for, or first shown while it was being answered: the
   * CLI answers each with a result of its own making, which carries no marker and is no fault. Only
   * these are excused, so an interrupt that ended no turn can never hide a real `missing` later
   * (report §1.7 of docs/reports/regression-audit-2026-10-29.md).
   */
  private readonly interrupted = new Set<string>();
  /** An interrupt was asked for and the CLI has not answered it yet */
  private interruptOpen = false;
  private warned = false;

  constructor(
    private readonly sink: (event: DriverEvent) => void,
    private readonly rulesSha256: string,
  ) {}

  hookResponse(raw: Record<string, unknown>): void {
    const stderr = typeof raw.stderr === 'string' ? raw.stderr : '';
    const lines = stderr.split('\n');
    const mark = lines.find((line) => line.startsWith(GUARD_MARK));
    if (!mark) return;
    const words = mark.slice(GUARD_MARK.length).trim().split(/\s+/);
    const kind = words[0];
    if (kind === 'armed') {
      // Only the SessionStart hook arms, and only for the rules file this process was given
      const hook = typeof raw.hook_event === 'string' ? raw.hook_event : String(raw.hook_name ?? '');
      if (hook.startsWith('SessionStart') && words[2] === this.rulesSha256.slice(0, 16)) this.sink({ kind: 'guard-armed' });
      return;
    }
    const id = words[1];
    if ((kind !== 'pass' && kind !== 'block' && kind !== 'observe' && kind !== 'allowed-once') || !id || !ID.test(id)) return;
    const rule = words[2] && RULES.has(words[2]) ? (words[2] as GuardRuleId) : 'integrity';
    const said = lines.map((line) => /^Claudio guard blocked this \([\w-]+\): (.*)$/.exec(line)?.[1]).find(Boolean);
    const matcher = words[3] ?? `${rule}.unknown`;
    const marker: Marker = {
      kind,
      id,
      rule,
      matcher,
      reason: said ?? (kind === 'observe' ? `Observed, would have blocked (${matcher})` : kind === 'allowed-once' ? 'Allowed once by the person' : ''),
    };
    const call = this.awaiting.get(id);
    if (!call) {
      if (this.settled.has(id)) return;
      if (!this.warned) {
        this.warned = true;
        console.warn(`guard: a marker for the tool call ${id}, which this chat has not shown (further ones are not logged)`);
      }
      remember(this.early, id, marker);
      return;
    }
    this.settle(id, call, marker);
  }

  toolUse(id: string, name: string, input: unknown): void {
    if (GUARD_UNHOOKED_TOOLS.has(name) || this.settled.has(id) || this.awaiting.has(id)) return;
    const call: Call = { name, excerpt: excerptOf(input) };
    const early = this.early.get(id);
    if (early) {
      this.early.delete(id);
      this.settle(id, call, early);
      return;
    }
    remember(this.awaiting, id, call);
    if (this.interruptOpen) this.interrupted.add(id);
  }

  /** An interrupt is being asked for: what is awaited now may get the CLI's own result instead of running */
  interrupting(): void {
    this.interruptOpen = true;
    for (const id of this.awaiting.keys()) this.interrupted.add(id);
  }

  /** The CLI answered the interrupt (or refused it): calls shown from now on are judged as any other */
  interruptAnswered(): void {
    this.interruptOpen = false;
  }

  /** A result arrived: a call still awaited ran without a guard marker */
  toolResult(id: string): void {
    const call = this.awaiting.get(id);
    if (!call) return;
    this.awaiting.delete(id);
    if (this.interrupted.delete(id)) return;
    const guard: RunGuardEvent = {
      outcome: 'missing',
      toolUseId: id,
      toolName: call.name,
      rule: 'integrity',
      matcher: 'integrity.no-marker',
      reason: 'The tool call ran and no guard marker came before its result',
      excerpt: call.excerpt,
    };
    this.sink({ kind: 'guard-missing', guard, run: { kind: 'guard', guard } });
  }

  private settle(id: string, call: Call, marker: Marker): void {
    this.awaiting.delete(id);
    this.interrupted.delete(id);
    remember(this.settled, id, true);
    if (marker.kind === 'pass') return;
    const outcome: GuardOutcome = marker.kind === 'block' ? (FAULT_MATCHERS.has(marker.matcher) ? 'error' : 'blocked') : marker.kind === 'observe' ? 'observed' : 'allowed-once';
    const guard: RunGuardEvent = { outcome, toolUseId: id, toolName: call.name, rule: marker.rule, matcher: marker.matcher, reason: marker.reason, excerpt: call.excerpt };
    this.sink({ kind: 'guard', guard, run: { kind: 'guard', guard } });
  }
}
