import { useMemo, type ComponentProps } from 'react';
import type { ModelOption } from '@agentry/shared';
import { useOverview } from '../api';
import { Combobox, type ComboboxOption } from '@agentry/ui/components/controls/Combobox';

export const PERMISSION_MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] as const;

const NO_MODELS: ComboboxOption[] = [];

/**
 * One row per model: the CLI lists an alias (`fable`) and the id it resolves to (`claude-fable-5-1`)
 * as separate options on some versions, which showed the same model twice. Rows with the same
 * concrete model (and the same context window) collapse to the first, the alias.
 */
export function dedupeModels(models: ReadonlyArray<ModelOption>): ModelOption[] {
  const seen = new Set<string>();
  const kept: ModelOption[] = [];
  for (const model of models) {
    const id = (model.resolvedModel ?? model.ids?.[0] ?? '').toLowerCase();
    const key = id ? `${id}${/\[1m\]/i.test(model.value) ? '[1m]' : ''}` : `value:${model.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(model);
  }
  return kept;
}

const NO_CATALOG: ModelOption[] = [];

/**
 * The models to offer, with their descriptions and effort levels: what the CLI says this account
 * may run (`SystemInfo.models`, read from its `initialize` handshake), each once. The ones it
 * names but cannot run are left out — a suggestion nobody can pick is a trap. Nothing is offered
 * until the overview has been read.
 */
export function useModelCatalog(): ModelOption[] {
  const models = useOverview().data?.system.models;
  return useMemo(() => (models && models.length > 0 ? dedupeModels(models.filter((model) => !model.disabled)) : NO_CATALOG), [models]);
}

/** The catalogue as picker rows: the CLI's name for each and the line it shows under it. */
export function useModelOptions(): ComboboxOption[] {
  const catalog = useModelCatalog();
  return useMemo(
    () => (catalog.length > 0 ? catalog.map((model) => ({ value: model.value, label: model.label ?? model.value, hint: model.description })) : NO_MODELS),
    [catalog],
  );
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

/** A model <Combobox>, filled from what the CLI offers; everything else is the Combobox's own. */
export function ModelCombobox(props: Omit<ComponentProps<typeof Combobox>, 'options'>) {
  return <Combobox {...props} options={useModelOptions()} />;
}
