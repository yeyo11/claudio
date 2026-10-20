import type { SettingDefault, SettingSource } from '@claudio/shared';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useProjects, useSettingOverrides, useSettingsState } from '../../api';
import { Tooltip } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { errorMessage, formatNumber } from '@claudio/ui/lib/format';

/**
 * What can take focus in a row's control column; the change cell itself is left out. A button out of
 * the tab order is skipped: a number field's steppers, and the options a roving radio group does not
 * have selected (the theme's cards), come before the control a keyboard reaches.
 */
const CONTROL = 'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]):not([tabindex="-1"]), [role="combobox"], [role="switch"], [role="radio"][tabindex="0"]';

/** Puts focus on the row's control, so a Reset that hides its own button does not leave it on `<body>`. */
export function focusSettingControl(setting: string): void {
  const row = document.querySelector<HTMLElement>(`[data-setting="${setting}"]`);
  // The slot sits beside its own control: where `data-setting` marks a whole block (the tunnel's,
  // whose first buttons start and stop it), the slot's parent is the narrower scope
  const scope = row?.querySelector<HTMLElement>('.pref-row-change')?.parentElement ?? row;
  const control = Array.from(scope?.querySelectorAll<HTMLElement>(CONTROL) ?? []).find((el) => !el.closest('.pref-row-change'));
  control?.focus();
}

/** How a default reads in the Reset tooltip when the row has no worded options of its own. */
export function useDefaultWording(): (value: SettingDefault) => string {
  const { t } = useTranslation('config');
  return (value) => {
    if (value === null) return t('settings.changeSlot.noCap');
    if (typeof value === 'boolean') return t(value ? 'settings.changeSlot.on' : 'settings.changeSlot.off');
    if (typeof value === 'number') return formatNumber(value);
    if (typeof value === 'string') return value;
    return t('settings.changeSlot.composite');
  };
}

/**
 * The `[● Changed · Reset]` slot of a settings row (settings-patterns.md, "Anatomy of a row"). The
 * dot is neutral: a change is not a status. The cell keeps its room while nothing is changed, hidden
 * with `visibility`, so nothing shifts when it appears. A value the environment sets is read-only
 * here, so it never offers Reset.
 */
export function SettingChange({
  setting,
  label,
  state,
  defaultText,
  onReset,
}: {
  /** The row's `data-setting`: where focus goes once the button hides */
  setting: string;
  /** The row's name, for the button's accessible name */
  label: string;
  state: { changed: boolean; source: SettingSource } | undefined;
  /** The default as the row's control words it */
  defaultText: string;
  onReset: () => Promise<void> | void;
}) {
  const { t } = useTranslation('config');
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [pending, setPending] = useState(false);
  const shown = state?.changed === true && state.source !== 'env';

  const reset = async () => {
    setPending(true);
    setError(null);
    // A second Reset on the same row says the same words: the region must change to be read again
    setSaid('');
    try {
      await onReset();
      setSaid(t('settings.changeSlot.restored'));
      // After the row has re-rendered with the default, which can remount the whole section
      requestAnimationFrame(() => requestAnimationFrame(() => focusSettingControl(setting)));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="pref-row-change" data-shown={shown}>
      <span className={shown ? 'pref-row-change-line' : 'pref-row-change-line is-hidden'} aria-hidden={shown ? undefined : true}>
        <span className="pref-row-change-dot" aria-hidden />
        <span className="pref-row-change-word">{t('settings.changeSlot.changed')}</span>
        <span aria-hidden>·</span>
        <Tooltip content={t('settings.changeSlot.default', { value: defaultText })}>
          <button
            type="button"
            className="link-btn small pref-row-change-reset"
            disabled={pending}
            tabIndex={shown ? undefined : -1}
            aria-label={t('settings.changeSlot.resetLabel', { setting: label, value: defaultText })}
            onClick={() => void reset()}
          >
            {t('shared.reset')}
          </button>
        </Tooltip>
      </span>
      {error !== null && (
        <span className="pref-row-change-error small" role="alert">
          <CircleAlert {...ICON_SM} aria-hidden />
          {error}
        </span>
      )}
      <span className="sr-only" role="status">
        {said}
      </span>
    </div>
  );
}

/**
 * A row's change slot, read from `GET /settings/state` and reset through `DELETE
 * /settings/state/:setting`. `invalidate` lists the store's own queries, read again once the value
 * is back to the default; `onReset` runs once those reads hold the default, so a draft screen can take it into its field.
 */
export function ServerSettingChange({
  id,
  label,
  wording,
  invalidate = [],
  onReset,
}: {
  id: string;
  label: string;
  /** The default as the row's control words it; the generic wording when absent */
  wording?: (value: SettingDefault) => string;
  invalidate?: readonly QueryKey[];
  onReset?: (value: SettingDefault) => void;
}) {
  const queryClient = useQueryClient();
  const generic = useDefaultWording();
  const state = useSettingsState().data?.settings[id];
  return (
    <SettingChange
      setting={id}
      label={label}
      state={state}
      defaultText={state ? (wording ?? generic)(state.default) : ''}
      onReset={async () => {
        const next = await api.resetSetting(id);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: keys.settingsState }),
          queryClient.invalidateQueries({ queryKey: keys.settingOverrides }),
          ...invalidate.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
        ]);
        // After the store's query holds the default, so a draft reads it from there
        onReset?.(next.default);
      }}
    />
  );
}

/** At most this many project names in the tooltip, then "and N more". */
const NAMES_SHOWN = 5;

/** The projects that override a setting, for the line under the row: a link to the first one's settings. */
export function overriddenLine(
  projectIds: readonly string[] | undefined,
  names: ReadonlyMap<string, string>,
): { count: number; href: string; names: string[]; more: number } | null {
  const first = projectIds?.[0];
  if (!projectIds || first === undefined) return null;
  const listed = projectIds.map((id) => names.get(id) ?? id);
  return {
    count: projectIds.length,
    href: `/?project=${encodeURIComponent(first)}&view=settings`,
    names: listed.slice(0, NAMES_SHOWN),
    more: Math.max(0, listed.length - NAMES_SHOWN),
  };
}

/** "Overridden in 2 projects": neutral text (`bare`: no separator, for a line that draws its own), a link to the first project's settings, the names in a tooltip. Nothing when none does. */
export function Overridden({ id, bare = false }: { id: string; bare?: boolean }) {
  const { t } = useTranslation('config');
  const overrides = useSettingOverrides().data;
  const projects = useProjects(false).data;
  const line = overriddenLine(overrides?.[id], new Map((projects ?? []).map((project) => [project.id, project.name])));
  if (!line) return null;
  const names = line.names.join(', ');
  return (
    <>
      {!bare && <span aria-hidden> · </span>}
      <Tooltip content={line.more > 0 ? `${names} ${t('settings.changeSlot.more', { count: line.more })}` : names}>
        <Link className="pref-row-overridden" to={line.href}>
          {t('settings.overridden', { count: line.count })}
        </Link>
      </Tooltip>
    </>
  );
}
