import { reserveAccountOf, type AccountReserve, type Choice } from '@claudio/accounts';
import type { NoRoomChoice, NoRoomRule, RotationPolicy } from '@claudio/shared';

/**
 * Work in progress per project, and the reserves it activates (docs/plans/account-configuration-and-project-rules.md §7.2).
 *
 * Every account choice may ask, so nothing here reads a file or a row: the sources are the
 * in-memory state of what runs (chats with a running turn, orchestrations that are running or
 * waiting, schedules due soon), each answering with the directories its work runs in. A directory's
 * project is remembered for a short while, since resolving it walks the projects list.
 */

/**
 * The key of the chats that belong to no project, which a rule's `looseChats` governs. The choice
 * compares a reserve's project with the work's, and both sides use this key for "no project".
 */
export const NO_PROJECT = '';

/** How far ahead a schedule's next run counts as work in progress (§7.2: "within the reserve's horizon") */
export const RESERVE_HORIZON_MS = 60 * 60 * 1000;

/** How long a directory's project is remembered: projects are added or moved by hand, rarely */
const PROJECT_TTL_MS = 30_000;

/** The directories some kind of work is running in now; called on every choice that has a reserve to weigh. */
export type WorkSource = () => Iterable<string>;

export class ProjectActivity {
  private readonly sources = new Set<WorkSource>();
  private readonly known = new Map<string, { project: string; at: number }>();

  constructor(
    /** The project a directory belongs to, null for none; read through a getter because Core sets it late */
    private readonly projectOf: () => ((dir: string) => string | null) | null,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Adds a source; returns its removal. */
  add(source: WorkSource): () => void {
    this.sources.add(source);
    return () => void this.sources.delete(source);
  }

  /** The keys of the projects with work in progress now, {@link NO_PROJECT} for chats of none. */
  projects(): Set<string> {
    const lookup = this.projectOf();
    const now = this.clock();
    const out = new Set<string>();
    for (const source of this.sources) {
      let dirs: Iterable<string>;
      try {
        dirs = source();
      } catch {
        // A source that cannot answer adds nothing: a reserve held back for a moment protects less, never blocks work
        continue;
      }
      for (const dir of dirs) out.add(this.keyOf(dir, lookup, now));
    }
    return out;
  }

  /** The reserves of the rules whose projects have work in progress now; none, and no source asked, while no rule reserves. */
  reserves(policies: readonly RotationPolicy[]): AccountReserve[] {
    if (!policies.some((p) => p.reserve)) return [];
    return reservesOf(policies, this.projects());
  }

  private keyOf(dir: string, lookup: ((dir: string) => string | null) | null, now: number): string {
    const hit = this.known.get(dir);
    if (hit && now - hit.at < PROJECT_TTL_MS) return hit.project;
    let project: string | null = null;
    try {
      project = lookup?.(dir) ?? null;
    } catch {
      project = null;
    }
    const key = project ?? NO_PROJECT;
    this.known.set(dir, { project: key, at: now });
    return key;
  }
}

/**
 * The reserve each rule holds while one of its projects has work: on the rule's preferred account,
 * else the first of its order (`reserveAccountOf`), one entry per active project. A rule that names
 * no account has nowhere to reserve.
 */
export function reservesOf(policies: readonly RotationPolicy[], active: ReadonlySet<string>): AccountReserve[] {
  const out: AccountReserve[] = [];
  for (const p of policies) {
    if (!p.reserve) continue;
    const account = reserveAccountOf(p);
    if (account === undefined) continue;
    const projects = [...p.projects, ...(p.looseChats ? [NO_PROJECT] : [])];
    for (const project of projects) if (active.has(project)) out.push({ project, account, percent: p.reserve.percent });
  }
  return out;
}

/**
 * The rule a choice that found no account with room ran into (§7.2): its project and the earliest
 * reset among the accounts it allows, with what is left to the work (`choices`: a person's chat may
 * also take one turn on another account). Null when the rule passed over nothing, which is the lack
 * of room every install meets without rules, told as before.
 */
export function noRoomRuleOf(choice: Pick<Choice, 'account' | 'waitUntil' | 'why'> | null, choices: readonly NoRoomChoice[] = ['wait']): NoRoomRule | null {
  if (!choice || choice.account !== null) return null;
  const ruled = choice.why.passedOver?.find((p) => p.because === 'not-allowed');
  if (!ruled) return null;
  return { project: ruled.project ? ruled.project : null, resetsAt: choice.waitUntil !== null ? new Date(choice.waitUntil).toISOString() : null, choices: [...choices] };
}

/**
 * The same rule in English, for the logs and the `reason` of a wait an older page reads: "no account
 * allowed on project X has room", with the reset. The page says it from {@link noRoomRuleOf}'s data.
 */
export function noRoomWords(choice: Pick<Choice, 'account' | 'waitUntil' | 'why'> | NoRoomRule | null): string | null {
  const rule = choice && 'choices' in choice ? choice : noRoomRuleOf(choice);
  if (!rule) return null;
  const whose = rule.project !== null ? `on project ${rule.project}` : 'on chats of no project';
  const back = rule.resetsAt !== null ? ` until ${rule.resetsAt}` : '';
  return `no account allowed ${whose} has room${back}`;
}
