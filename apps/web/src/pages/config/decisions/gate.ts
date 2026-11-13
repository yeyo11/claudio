import type { DecisionGateInForce, DecisionGateReading, DecisionGateShortfall } from '@claudio/shared';
import type { TFunction } from 'i18next';
import { formatList, formatNumber, formatPercent } from '@claudio/ui/lib/format';

const share = (value: number | null) => formatPercent(Math.round((value ?? 0) * 100));

function phrase(t: TFunction<'decisions'>, shortfall: DecisionGateShortfall, gate: DecisionGateInForce, reading: DecisionGateReading): string {
  switch (shortfall) {
    case 'cases': {
      // At least one more: the shortfall says the count is short even if a stale reading shows it met
      const more = Math.max(1, gate.minCases - reading.cases);
      return t('gate.cases', { count: more, formatted: formatNumber(more) });
    }
    case 'break-even':
      return gate.breakEven === null ? t('gate.breakEvenNone') : t('gate.breakEven', { value: share(gate.breakEven) });
    case 'baseline':
      return t('gate.baseline');
    case 'precision':
      return t('gate.precision', { value: share(gate.minPrecision) });
    case 'flag-rate':
      return t('gate.flagRate', { value: share(gate.maxFlagRate) });
  }
}

/**
 * What a point still lacks to clear its gate, as one noun phrase ("30 more cases with a known
 * outcome and a precision above 70 %"), read from the numbers the server holds in force: the UI
 * never decides the thresholds, it words them.
 */
export function gateMissing(t: TFunction<'decisions'>, gate: DecisionGateInForce, reading: DecisionGateReading): string {
  // No shortfall named yet the point is not proven: the cases are what is short
  const shortfalls: DecisionGateShortfall[] = reading.shortfalls.length > 0 ? reading.shortfalls : ['cases'];
  return formatList(shortfalls.map((shortfall) => phrase(t, shortfall, gate, reading)));
}
