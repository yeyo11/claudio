import type { AccountConfig, AccountConfigItem } from '@claudio/shared';
import { Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Tag } from '@claudio/ui/components/ui';

/** One tone per state, the status set only: ok in sync, warn waiting for repair, bad in conflict */
const TONE: Record<AccountConfig['state'], 'ok' | 'warn' | 'bad'> = { ok: 'ok', repair: 'warn', conflict: 'bad' };

/** The items a person has to act on; everything else (linked, own, absent, not in the default) is not said */
export function configProblems(config: AccountConfig): AccountConfigItem[] {
  return config.items.filter((item) => item.state === 'conflict' || item.state === 'missing');
}

/** What the account holds where the shared item should be, in words: a conflict is read, never diffed */
function holdsKey(item: AccountConfigItem) {
  switch (item.reason) {
    case 'real-file':
    case 'real-dir':
    case 'link-elsewhere':
    case 'aside-taken':
    case 'failed':
      return `config.holds.${item.reason}` as const;
    default:
      return 'config.holds.own' as const;
  }
}

/** What the shared side holds: the default account's file or folder, or the history every account uses */
const sharedKey = (item: AccountConfigItem) => (item.class === 'history' ? 'config.sharedHolds.history' : item.kind === 'dir' ? 'config.sharedHolds.dir' : 'config.sharedHolds.file') as `config.sharedHolds.${'history' | 'dir' | 'file'}`;

/**
 * An account's configuration on its card (docs/plans/account-configuration-and-project-rules.md
 * §6.5, the owner's T9 decisions): the mode and a state with its word and colour. Only problems are
 * listed: an item in conflict says what the account holds and what the shared one is, with "Use
 * shared"; items that wait for their link, or a switch left half-way, offer Repair once.
 */
export function AccountConfigLine({
  config,
  name,
  busy,
  onRepair,
  onUseShared,
}: {
  config: AccountConfig;
  /** The account's name, for the buttons' accessible names */
  name: string;
  busy: boolean;
  onRepair: () => void;
  onUseShared: (item: string) => void;
}) {
  const { t } = useTranslation('accountsConfig');
  const problems = configProblems(config);
  const conflicts = problems.filter((item) => item.state === 'conflict');
  const missing = problems.filter((item) => item.state === 'missing');
  // A half-way switch is finished by the same Repair as a missing link: applying the mode again
  const repairable = config.switching !== null || missing.length > 0;

  return (
    <div className="account-config" data-config-state={config.state}>
      <div className="account-config-head">
        <span className="account-config-label">{t('config.label')}</span>
        <span className="account-config-mode">{t(`config.mode.${config.mode}`)}</span>
        <Tag tone={TONE[config.state]}>{t(`config.state.${config.state}`)}</Tag>
        {repairable && (
          <button type="button" className="btn btn-small account-config-repair" onClick={onRepair} disabled={busy} aria-label={t('config.repairFor', { name })}>
            <Wrench {...ICON_SM} />
            {t('config.repair')}
          </button>
        )}
      </div>
      {(config.switching !== null || problems.length > 0) && (
        <ul className="account-config-items">
          {config.switching !== null && <li className="account-config-item small">{t(`config.halfway.${config.switching.to}`)}</li>}
          {conflicts.map((item) => (
            <li key={item.name} className="account-config-item is-conflict">
              <span className="account-config-item-name mono">{item.name}</span>
              <span className="account-config-item-holds small">
                <span>{t(holdsKey(item))}</span>
                <span>{t(sharedKey(item))}</span>
              </span>
              <button
                type="button"
                className="btn btn-small account-config-use"
                onClick={() => onUseShared(item.name)}
                disabled={busy}
                aria-label={t('config.useSharedFor', { item: item.name, name })}
              >
                {t('config.useShared')}
              </button>
            </li>
          ))}
          {missing.length > 0 && (
            <li className="account-config-item small">
              {t('config.missing', { count: missing.length })} <span className="mono">{missing.map((item) => item.name).join(', ')}</span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
