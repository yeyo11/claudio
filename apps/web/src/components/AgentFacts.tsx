import type { ModelOption } from '@claudio/shared';
import { MiddleCut } from '@claudio/ui/components/MiddleCut';
import { useTranslation } from 'react-i18next';
import { effortLabel } from './EffortPicker';
import { useModelCatalog } from './ui';

/**
 * The catalogue row a model belongs to: matched on its alias, on the id it resolves to, or on any
 * id it was reported under. The `default` row is not a name for anything ("Default (recommended)"
 * says which row a picker pre-selects, not which model ran), so it never names a model.
 */
export function modelOptionFor(catalog: readonly ModelOption[], model: string): ModelOption | undefined {
  return catalog.find((option) => option.value !== 'default' && (option.value === model || option.resolvedModel === model || option.ids?.includes(model)));
}

/**
 * A model the way the CLI names it ("Opus 5"), in the interface's own type. A model the CLI's list
 * gives no name for stays what it is, an id the machine reads, and so is drawn in mono.
 */
export function ModelName({ model }: { model: string }) {
  const label = modelOptionFor(useModelCatalog(), model)?.label;
  return label ? <>{label}</> : <MiddleCut text={model} className="mono" />;
}

/**
 * An effort level as a word ("Medium", "Medio"). Beside a model on a card the bare word says
 * nothing to a screen reader, so it is named; under an "Effort" label (`named={false}`) it already is.
 */
export function EffortName({ effort, named = true }: { effort: string; named?: boolean }) {
  const { t } = useTranslation('components');
  return (
    <>
      {named && <span className="sr-only">{`${t('effort.label')}: `}</span>}
      {effortLabel(t, effort)}
    </>
  );
}
