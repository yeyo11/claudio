import { useMemo, type ComponentProps } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { CircleAlert } from 'lucide-react';
import type { ModelOption } from '@claudio/shared';
import { api, keys, useOverview } from '../api';
import { Combobox, type ComboboxOption } from '@claudio/ui/components/controls/Combobox';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;

const NO_MODELS: ComboboxOption[] = [];

/** The account whose list the overview carries (`SystemInfo.models`): the one a new chat starts on. */
const DEFAULT_ACCOUNT = 'default';

/**
 * Each option once, as `/model` lists it: only an identical `value` is a repeat. Two values that
 * resolve to the same model (`default` and `haiku`, say) are two rows there and stay two rows here,
 * in the CLI's order, with its names and descriptions.
 */
export function dedupeModels(models: ReadonlyArray<ModelOption>): ModelOption[] {
  const seen = new Set<string>();
  const kept: ModelOption[] = [];
  for (const model of models) {
    if (seen.has(model.value)) continue;
    seen.add(model.value);
    kept.push(model);
  }
  return kept;
}

const NO_CATALOG: ModelOption[] = [];

/** The list a picker shows, and whether it is there yet. */
export interface ModelList {
  /** What the CLI lists for the account, each once and only the ones it can run */
  models: ModelOption[];
  /** `loading` until the CLI's `initialize` list arrives; `failed` when it could not be read, or came back empty */
  state: 'ready' | 'loading' | 'failed';
  /** Asks the CLI again (`?refresh=1`) */
  retry: () => void;
}

/**
 * The models the CLI's `initialize` lists for an account (no turn, no tokens), which is the only
 * list there is: never a guess while it loads. With no account, the default one, which the overview
 * already carries; while the overview has none yet, the account's own route waits for the read in
 * progress and says whether it failed. The ones the CLI names but cannot run are left out: a
 * suggestion nobody can pick is a trap.
 */
export function useModelList(account?: string | null): ModelList {
  const queryClient = useQueryClient();
  const overview = useOverview();
  const id = account || DEFAULT_ACCOUNT;
  const fromOverview = account ? undefined : overview.data?.system.models;
  const ask = !!account || (overview.isSuccess && !fromOverview?.length);
  const read = useQuery({
    queryKey: keys.accountModels(id),
    queryFn: ({ signal }) => api.accountModels(id, { signal }),
    enabled: ask,
    staleTime: 60_000,
    retry: 1,
  });
  const again = useMutation({
    mutationFn: () => api.refreshAccountModels(id),
    onSuccess: (models) => {
      queryClient.setQueryData(keys.accountModels(id), models);
      if (id === DEFAULT_ACCOUNT) void queryClient.invalidateQueries({ queryKey: keys.overview });
    },
  });
  const listed = fromOverview?.length ? fromOverview : read.data;
  const models = useMemo(() => (listed?.length ? dedupeModels(listed.filter((model) => !model.disabled)) : NO_CATALOG), [listed]);
  // An overview that failed would leave the spinner turning with nothing at work: that is a failed read too
  const overviewFailed = !account && overview.isError && !fromOverview?.length;
  const failed = !again.isPending && (again.isError || overviewFailed || (ask && (read.isError || (read.isSuccess && !read.data.length && !again.data?.length))));
  const state = models.length > 0 ? 'ready' : failed ? 'failed' : 'loading';
  return { models, state, retry: () => again.mutate() };
}

/** The models to offer, with their descriptions and effort levels; empty while the list loads. */
export function useModelCatalog(account?: string | null): ModelOption[] {
  return useModelList(account).models;
}

/** The catalogue as picker rows: the CLI's name for each and the line it shows under it. */
function optionsOf(catalog: ReadonlyArray<ModelOption>): ComboboxOption[] {
  if (!catalog.length) return NO_MODELS;
  // A row the CLI gave no name shows its value, which is an id: that one is literal, so mono
  return catalog.map((model) => ({ value: model.value, label: model.label ?? <span className="mono">{model.value}</span>, hint: model.description }));
}

export function useModelOptions(account?: string | null): ComboboxOption[] {
  const catalog = useModelCatalog(account);
  return useMemo(() => optionsOf(catalog), [catalog]);
}

/**
 * The effort levels a model takes, from the CLI's own list for it; null where the CLI said nothing
 * (an alias not in the catalogue, an older CLI), so every level stays on offer. An empty list is
 * a model with no effort at all.
 */
export function effortLevelsOf(catalog: ReadonlyArray<ModelOption>, model: string | null | undefined): string[] | null {
  const wanted = model?.trim().toLowerCase();
  if (!wanted) return null;
  const found = catalog.find((m) => m.value.toLowerCase() === wanted || m.resolvedModel?.toLowerCase() === wanted || m.ids?.some((id) => id.toLowerCase() === wanted));
  if (!found) return null;
  if (found.supportsEffort === false) return [];
  return found.supportedEffortLevels ?? null;
}

/** What the list says while it has no models: loading, or a failed read with a way to ask again. */
export function ModelListStatus({ list }: { list: ModelList }) {
  const { t } = useTranslation('components');
  if (list.state === 'ready') return null;
  if (list.state === 'loading')
    return (
      <>
        <Spinner />
        <span>{t('models.loading')}</span>
      </>
    );
  return (
    <>
      <CircleAlert {...ICON_SM} className="is-bad" />
      <span>{t('models.failed')}</span>
      <button type="button" className="link-btn" onClick={list.retry}>
        {t('models.retry')}
      </button>
    </>
  );
}

/**
 * A model <Combobox>, filled from what the CLI offers `account` (the default account when none is
 * named); everything else is the Combobox's own, a typed model id included.
 */
export function ModelCombobox({ account, ...props }: Omit<ComponentProps<typeof Combobox>, 'options' | 'status' | 'onStatusAction'> & { account?: string | null }) {
  const list = useModelList(account);
  const options = useMemo(() => optionsOf(list.models), [list.models]);
  return <Combobox {...props} options={options} status={<ModelListStatus list={list} />} onStatusAction={list.state === 'failed' ? list.retry : undefined} />;
}
