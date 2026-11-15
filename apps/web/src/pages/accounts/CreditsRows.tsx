import type { Account, AccountCreditsSetting, AccountCreditsUse, AccountsSettings } from '@claudio/shared';
import { useTranslation } from 'react-i18next';
import { NumberInput, Select } from '@claudio/ui/components/controls';
import { accountName, creditsView } from '../../lib/accounts';
import { formatCredits } from '../../lib/credits';

const USES: readonly AccountCreditsUse[] = ['never', 'last-resort', 'allow'];
const NEVER: AccountCreditsSetting = { use: 'never', capMinor: null };

/** The accounts whose credits can be spent at all: set up once at claude.ai, or with a setting already kept. */
export function creditsAccounts(accounts: readonly Account[], credits: AccountsSettings['credits']): Account[] {
  return accounts.filter((a) => creditsView(a.limits?.cli?.credits) !== null || credits[a.id] !== undefined);
}

/**
 * Whether Claudio's work may spend each account's usage credits once its plan is spent, and up to
 * what a month (docs/accounts.md, the credits setting). Part of the rotation card's draft: nothing
 * applies until Save. Only accounts whose credits were ever set up are listed, since for any other
 * the setting changes nothing.
 */
export function CreditsRows({ accounts, value, onChange, labelledBy }: { accounts: readonly Account[]; value: AccountsSettings['credits']; onChange: (next: AccountsSettings['credits']) => void; labelledBy: string }) {
  const { t } = useTranslation('accountsConfig');
  const set = (id: string, next: AccountCreditsSetting) => {
    const { [id]: _old, ...rest } = value;
    // The default is no entry: an account the settings do not name never spends
    onChange(next.use === 'never' && next.capMinor === null ? rest : { ...rest, [id]: next });
  };
  return (
    <ul className="rotation-credits-list" aria-labelledby={labelledBy}>
      {accounts.map((account) => {
        const setting = value[account.id] ?? NEVER;
        const credits = account.limits?.cli?.credits ?? null;
        const unit = { currency: credits?.currency ?? null, exponent: credits?.exponent ?? 2 };
        const scale = 10 ** unit.exponent;
        const name = accountName(account);
        const cap = setting.capMinor !== null ? formatCredits(setting.capMinor, unit) : null;
        const consequence = [t(`rotation.credits.consequence.${setting.use}`), setting.use !== 'never' ? (cap ? t('rotation.credits.capAt', { cap }) : t('rotation.credits.noCapHint')) : null].filter(Boolean).join(' · ');
        return (
          <li key={account.id} className="rotation-credits-row">
            <span className="rotation-credits-name ellipsis">{name}</span>
            <Select<AccountCreditsUse>
              aria-label={t('rotation.credits.useFor', { name })}
              value={setting.use}
              onChange={(use) => set(account.id, { use, capMinor: use === 'never' ? null : setting.capMinor })}
              options={USES.map((use) => ({ value: use, label: t(`rotation.credits.use.${use}`) }))}
            />
            {/* Kept, hidden and disabled, when it does not apply: the row never changes height as the use changes */}
            <span className={`rotation-credits-cap${setting.use === 'never' ? ' is-unused' : ''}`} aria-hidden={setting.use === 'never'}>
              <NumberInput
                compact
                decimal
                disabled={setting.use === 'never'}
                aria-label={t('rotation.credits.capFor', { name })}
                placeholder={t('rotation.credits.noCap')}
                min={0}
                step={1}
                value={setting.capMinor === null ? undefined : setting.capMinor / scale}
                onChange={(major) => set(account.id, { use: setting.use, capMinor: major === undefined ? null : Math.max(0, Math.round(major * scale)) })}
              />
            </span>
            <span className="field-hint rotation-credits-hint tnum">{consequence}</span>
          </li>
        );
      })}
    </ul>
  );
}
