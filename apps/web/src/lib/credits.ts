import type { AccountCredits } from '@claudio/shared';
import { intlLocale } from '@claudio/ui/i18n/language';

// Apart from `accounts.ts`, which reads the API: the notifications' words format amounts too, and
// are read where no API client is loaded (the push parity test)

/** An amount in minor units in its own currency and decimal places; a currency the CLI did not state is a plain number. */
export function formatCredits(minor: number, credits: Pick<AccountCredits, 'currency' | 'exponent'>): string {
  const value = minor / 10 ** credits.exponent;
  const digits = { minimumFractionDigits: credits.exponent, maximumFractionDigits: credits.exponent };
  try {
    return new Intl.NumberFormat(intlLocale(), credits.currency ? { style: 'currency', currency: credits.currency, ...digits } : digits).format(value);
  } catch {
    // A code Intl does not know: still the amount, with the code beside it
    return `${new Intl.NumberFormat(intlLocale(), digits).format(value)} ${credits.currency ?? ''}`.trim();
  }
}
