import { isDeepStrictEqual } from 'node:util';
import {
  DECISION_POINT_IDS,
  DEFAULT_GUARD_SETTINGS,
  guardRuleSettingId,
  isServerSettingId,
  pointSettingId,
  SERVER_SETTING_IDS,
  type AccountsSettings,
  type AppSettingValues,
  type FixedServerSettingId,
  type GuardSwitchableRuleId,
  type ProjectSettings,
  type ServerSettingId,
  type SettingDefault,
  type SettingOverrides,
  type SettingSource,
  type SettingState,
  type SettingsState,
  type TerminalStatus,
  type TerminalSettings,
} from '@claudio/shared';
import { DEFAULT_SETTINGS as DEFAULT_ACCOUNTS_SETTINGS, type AccountStore } from '@claudio/accounts';
import type { AppSettingsStore } from './app-settings.ts';
import type { CollaboratorsService } from './collab/service.ts';
import { storedAt, valueAt, type SettingPath } from './config/setting-paths.ts';
import { decisionPoint } from './decisions/points.ts';
import { DEFAULT_DECISION_SETTINGS, DEFAULT_THRESHOLD, type DecisionSettingsStore } from './decisions/settings.ts';
import type { GuardSettingsStore } from './guards/settings.ts';
import { DEFAULT_LESSON_SETTINGS, type LessonSettingsStore } from './lessons/settings.ts';
import { DEFAULT_APP_SETTINGS } from './paths.ts';
import { defaultRotationSettings, type ProvidersSettingsStore } from './providers/settings.ts';
import { DEFAULT_COLLABORATORS_SETTINGS } from './collab/settings.ts';
import type { TunnelManager } from './tunnel.ts';

/*
 * One registry for every server-side setting a row can reset (docs/plans/settings-reset-and-polish.md,
 * D6 and D7), keyed by the rows' `data-setting` ids. Each entry knows where its value lives in its
 * store's JSON document, what its default is, and how to remove the person's value through the
 * store's own write, which emits the event the store's `PUT` emits. A Reset removes the key instead
 * of writing the default, so the row follows a default that changes later or differs by
 * distribution; that is why the default is served from here and never hard-coded in the web.
 */

export interface SettingRead {
  /** The store holds a value for the row */
  stored: boolean;
  value: unknown;
  default: SettingDefault;
  source: SettingSource;
}

export interface SettingEntry {
  read(): SettingRead | Promise<SettingRead>;
  reset(): Promise<void>;
}

/** What `DELETE /settings/state/:setting` refuses with: `statusCode` and `reason` are what the API answers */
export class SettingsError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'SettingsError';
  }
}

/** A project and its settings document, for the overrides */
export interface ProjectSettingsOf {
  id: string;
  name: string;
  settings: ProjectSettings | null | undefined;
}

export interface SettingsRegistryDeps {
  appSettings: Pick<AppSettingsStore, 'get' | 'resetKeys'>;
  providers: Pick<ProvidersSettingsStore, 'get' | 'stored' | 'resetKeys'>;
  /** Told after a provider setting is reset, as `PUT /providers/settings` tells the detector */
  providersChanged?: () => void;
  lessons: Pick<LessonSettingsStore, 'get' | 'stored' | 'resetKeys'>;
  decisions: Pick<DecisionSettingsStore, 'get' | 'stored' | 'resetKeys'>;
  guards: Pick<GuardSettingsStore, 'get' | 'stored' | 'resetKeys'>;
  /**
   * The terminal's settings, by shape: only `index.ts` imports the terminal service
   * (`terminals-isolation.test.ts`), so nothing here can reach a shell
   */
  terminals: {
    status(): Pick<TerminalStatus, 'settings' | 'sources'>;
    settingDefaults(): TerminalSettings;
    resetSettings(paths: readonly SettingPath[]): Promise<unknown>;
  };
  tunnel: Pick<TunnelManager, 'status' | 'startStored' | 'defaultSettings' | 'resetSettings'>;
  accounts: Pick<AccountStore, 'settings' | 'storedSettingKeys' | 'resetSettings'>;
  collaborators: Pick<CollaboratorsService, 'currentSettings' | 'storedSettings' | 'resetSettings'>;
  /** Every project with its settings document, for `overrides()` */
  projects(): Promise<ProjectSettingsOf[]>;
}

export interface SettingsRegistry {
  /** `GET /settings/state` */
  state(): Promise<SettingsState>;
  /** `DELETE /settings/state/:setting`: the row's state after its stored value is removed */
  reset(id: string): Promise<SettingState>;
  /** `GET /settings/overrides` */
  overrides(): Promise<SettingOverrides>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A store's default as the contract types it: plain JSON, copied so nobody changes the store's own */
const asDefault = (value: unknown): SettingDefault => structuredClone(value) as SettingDefault;

const sourceOf = (env: boolean, stored: boolean): SettingSource => (env ? 'env' : stored ? 'stored' : 'default');

/** A row of a document read whole by `get` and as stored by `stored`, at one path */
function documentEntry(
  doc: { get(): unknown; stored(): unknown },
  path: SettingPath,
  defaults: unknown,
  reset: (paths: readonly SettingPath[]) => Promise<unknown>,
): SettingEntry {
  return {
    read: async () => {
      const [current, stored] = await Promise.all([doc.get(), doc.stored()]);
      const isStored = storedAt(stored, path);
      return { stored: isStored, value: valueAt(current, path), default: asDefault(valueAt(defaults, path)), source: sourceOf(false, isStored) };
    },
    reset: async () => {
      await reset([path]);
    },
  };
}

const APP_KEYS = {
  'runs.permission-mode': 'defaultPermissionMode',
  'runs.concurrent': 'maxConcurrentRuns',
  'spend-cap.daily': 'dailySpendCapUsd',
  'evals.phase-2': 'evalsPhase2',
} as const satisfies Partial<Record<FixedServerSettingId, keyof AppSettingValues>>;

const LESSON_PATHS = {
  'lessons.miner-model': ['miner', 'model'],
  'lessons.miner-effort': ['miner', 'effort'],
  'lessons.max-cost': ['miner', 'maxCostUsd'],
  'lessons.project-daily': ['caps', 'perProjectDailyUsd'],
  'lessons.global-daily': ['caps', 'globalDailyUsd'],
  'lessons.chat-minutes': ['caps', 'perChatMinMinutes'],
  'lessons.jobs-daily': ['caps', 'perProjectDailyJobs'],
  'lessons.approve-floor': ['confidence', 'approveFloor'],
  'lessons.deliver-at': ['confidence', 'deliverAt'],
  'lessons.budget': ['delivery', 'handoffBytes'],
  'lessons.loose-chats': ['delivery', 'looseChats'],
  'lessons.repeated-errors': ['signals', 'repeatedErrorsTrigger'],
  'lessons.manual-mining': ['manualMining'],
} as const satisfies Partial<Record<FixedServerSettingId, SettingPath>>;

const ENGINE_PATHS = {
  'engine.who-answers': ['provider'],
  'engine.cap': ['cli', 'maxCostUsd'],
  'engine.cli-model': ['cli', 'model'],
  'engine.cli-effort': ['cli', 'effort'],
  'engine.history-days': ['historyDays'],
} as const satisfies Partial<Record<FixedServerSettingId, SettingPath>>;

const TERMINAL_KEYS = {
  'terminal.max-terminals': 'maxTerminals',
  'terminal.idle-minutes': 'idleMinutes',
  'terminal.scrollback': 'scrollbackLines',
  'terminal.replay': 'replayLines',
  'terminal.shell': 'shell',
  'terminal.login-shell': 'loginShell',
} as const satisfies Partial<Record<FixedServerSettingId, keyof TerminalSettings>>;

const ACCOUNT_KEYS = {
  'accounts.rotate-on-limit': 'rotateOnLimit',
  'accounts.threshold': 'threshold',
  'accounts.hysteresis': 'hysteresis',
  'accounts.cooldown': 'cooldownSeconds',
  'accounts.strategy': 'strategy',
} as const satisfies Partial<Record<FixedServerSettingId, keyof AccountsSettings>>;

const COLLABORATOR_KEYS = {
  'collaborators.relay': 'relayUrl',
  'collaborators.assistant-reads': 'assistantReads',
} as const;

const GUARD_RULE_IDS = Object.keys(DEFAULT_GUARD_SETTINGS.rules) as GuardSwitchableRuleId[];

/** A store refusal keeps its words and its status; a fault of the machine (a disk error) stays a fault */
function refusal(error: unknown): unknown {
  if (!(error instanceof Error) || 'syscall' in error || error instanceof SettingsError) return error;
  const carried = error as Error & { statusCode?: unknown; status?: unknown; code?: unknown };
  const status = typeof carried.statusCode === 'number' ? carried.statusCode : typeof carried.status === 'number' ? carried.status : 400;
  return new SettingsError(error.message, status, typeof carried.code === 'string' ? carried.code : 'setting-refused');
}

export function createSettingsRegistry(deps: SettingsRegistryDeps): SettingsRegistry {
  const fixed = {} as Record<FixedServerSettingId, SettingEntry>;

  for (const [id, key] of Object.entries(APP_KEYS) as Array<[keyof typeof APP_KEYS, keyof AppSettingValues]>) {
    fixed[id] = {
      read: () => {
        const settings = deps.appSettings.get();
        const source = settings.sources[key];
        return { stored: source === 'file', value: settings[key], default: asDefault(DEFAULT_APP_SETTINGS[key]), source: sourceOf(source === 'env', source === 'file') };
      },
      reset: async () => {
        await deps.appSettings.resetKeys([[key]]);
      },
    };
  }

  const resetProviders = async (paths: readonly SettingPath[]) => {
    await deps.providers.resetKeys(paths);
    deps.providersChanged?.();
  };
  const providerIds = () => Object.keys(deps.providers.get().providers);
  fixed['provider.binary'] = {
    read: () => {
      const ids = providerIds();
      const current = deps.providers.get();
      const stored = deps.providers.stored();
      const isStored = ids.some((id) => storedAt(stored, ['providers', id, 'binaryPath']));
      return {
        stored: isStored,
        value: Object.fromEntries(ids.map((id) => [id, current.providers[id]?.binaryPath ?? null])),
        default: Object.fromEntries(ids.map((id) => [id, null])),
        source: sourceOf(false, isStored),
      };
    },
    reset: () => resetProviders(providerIds().map((id) => ['providers', id, 'binaryPath'])),
  };
  fixed['provider.limits'] = documentEntry(deps.providers, ['rotation', 'onLimit'], defaultRotationSettings(), resetProviders);

  for (const [id, path] of Object.entries(LESSON_PATHS) as Array<[keyof typeof LESSON_PATHS, SettingPath]>) {
    fixed[id] = documentEntry(deps.lessons, path, DEFAULT_LESSON_SETTINGS, (paths) => deps.lessons.resetKeys(paths));
  }
  for (const [id, path] of Object.entries(ENGINE_PATHS) as Array<[keyof typeof ENGINE_PATHS, SettingPath]>) {
    fixed[id] = documentEntry(deps.decisions, path, DEFAULT_DECISION_SETTINGS, (paths) => deps.decisions.resetKeys(paths));
  }

  fixed['guards.mode'] = documentEntry(deps.guards, ['mode'], DEFAULT_GUARD_SETTINGS, (paths) => deps.guards.resetKeys(paths));
  fixed['guards.automated'] = documentEntry(deps.guards, ['automated'], DEFAULT_GUARD_SETTINGS, (paths) => deps.guards.resetKeys(paths));

  for (const [id, key] of Object.entries(TERMINAL_KEYS) as Array<[keyof typeof TERMINAL_KEYS, keyof TerminalSettings]>) {
    fixed[id] = {
      read: () => {
        const status = deps.terminals.status();
        const source = status.sources[key];
        return { stored: source === 'file', value: status.settings[key], default: asDefault(deps.terminals.settingDefaults()[key]), source: sourceOf(source === 'env', source === 'file') };
      },
      reset: async () => {
        await deps.terminals.resetSettings([[key]]);
      },
    };
  }

  fixed['remote.tunnel'] = {
    read: () => {
      const stored = deps.tunnel.startStored();
      return { stored, value: deps.tunnel.status().settings.startWithClaudio, default: deps.tunnel.defaultSettings().startWithClaudio, source: sourceOf(false, stored) };
    },
    reset: async () => {
      await deps.tunnel.resetSettings();
    },
  };

  for (const [id, key] of Object.entries(ACCOUNT_KEYS) as Array<[keyof typeof ACCOUNT_KEYS, keyof AccountsSettings]>) {
    fixed[id] = {
      read: () => {
        const stored = deps.accounts.storedSettingKeys().has(key);
        return { stored, value: deps.accounts.settings()[key], default: asDefault(DEFAULT_ACCOUNTS_SETTINGS[key]), source: sourceOf(false, stored) };
      },
      reset: async () => {
        await deps.accounts.resetSettings([[key]]);
      },
    };
  }

  for (const [id, key] of Object.entries(COLLABORATOR_KEYS) as Array<[keyof typeof COLLABORATOR_KEYS, 'relayUrl' | 'assistantReads']>) {
    fixed[id] = documentEntry(
      { get: () => deps.collaborators.currentSettings(), stored: () => deps.collaborators.storedSettings() },
      [key],
      DEFAULT_COLLABORATORS_SETTINGS,
      (paths) => deps.collaborators.resetSettings(paths),
    );
  }

  const entries = new Map<ServerSettingId, SettingEntry>(Object.entries(fixed) as Array<[FixedServerSettingId, SettingEntry]>);

  for (const point of DECISION_POINT_IDS) {
    const threshold = decisionPoint(point)?.defaultThreshold ?? DEFAULT_THRESHOLD;
    const fields = ['mode', 'threshold'] as const;
    entries.set(pointSettingId(point), {
      read: () => {
        const stored = deps.decisions.stored();
        const isStored = fields.some((field) => storedAt(stored, ['points', point, field]));
        const current = deps.decisions.get().points[point];
        return {
          stored: isStored,
          value: { mode: current?.mode ?? 'off', threshold: current?.threshold ?? threshold },
          default: { mode: 'off', threshold },
          source: sourceOf(false, isStored),
        };
      },
      // The consent stays: it is the owner's grant, and it is withdrawn on its own
      reset: async () => {
        await deps.decisions.resetKeys(fields.map((field) => ['points', point, field]));
      },
    });
  }

  for (const rule of GUARD_RULE_IDS) {
    entries.set(guardRuleSettingId(rule), documentEntry(deps.guards, ['rules', rule], DEFAULT_GUARD_SETTINGS, (paths) => deps.guards.resetKeys(paths)));
  }

  // The compiler checks the fixed ids; the points and the rules are built, so they are checked here
  for (const id of SERVER_SETTING_IDS) if (!entries.has(id)) throw new Error(`setting ${id} has no entry in the registry`);

  const stateOf = (read: SettingRead): SettingState => ({
    changed: read.source === 'stored' && !isDeepStrictEqual(read.value, read.default),
    source: read.source,
    default: read.default,
  });

  const entryOf = (id: string): SettingEntry => {
    const entry = isServerSettingId(id) ? entries.get(id) : undefined;
    if (!entry) throw new SettingsError(`${id} is not a setting that can be reset`, 404, 'setting-unknown');
    return entry;
  };

  return {
    async state() {
      const reads = await Promise.all(SERVER_SETTING_IDS.map(async (id) => [id, stateOf(await entryOf(id).read())] as const));
      return { settings: Object.fromEntries(reads) };
    },

    async reset(id) {
      const entry = entryOf(id);
      const before = await entry.read();
      if (before.source === 'env') throw new SettingsError(`${id} is set by the environment and cannot be reset here`, 409, 'setting-from-env');
      try {
        await entry.reset();
      } catch (error) {
        throw refusal(error);
      }
      return stateOf(await entry.read());
    },

    async overrides() {
      const projects = [...(await deps.projects())].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const out: SettingOverrides = {};
      const add = (id: string, projectId: string) => {
        (out[id] ??= []).push(projectId);
      };
      for (const { id, settings } of projects) {
        if (!settings) continue;
        const decisions = settings.decisions;
        if (decisions?.provider !== undefined && decisions.provider !== 'inherit') add('engine.who-answers', id);
        for (const [point, override] of Object.entries(decisions?.points ?? {})) {
          if (!(DECISION_POINT_IDS as readonly string[]).includes(point) || !isObject(override)) continue;
          if (override.mode !== undefined || override.threshold !== undefined) add(pointSettingId(point as (typeof DECISION_POINT_IDS)[number]), id);
        }
        const onLimit = settings.providers?.onLimit;
        if (onLimit && Object.values(onLimit).some((value) => value !== undefined)) add('provider.limits', id);
        const stages = Object.values(settings.flow?.guards ?? {});
        for (const rule of GUARD_RULE_IDS) {
          if (stages.some((stage) => stage?.rules?.[rule] !== undefined)) add(guardRuleSettingId(rule), id);
        }
      }
      return out;
    },
  };
}
