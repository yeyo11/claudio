import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, type ComponentType, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ICON } from '@claudio/ui/components/icons';
import { Segmented, usePageTitle, useTabGroup } from '@claudio/ui/components/ui';
import { PhoneHeader, useOwnPhoneHeader } from '../components/shell/PhoneHeader';
import { DirtyProvider, useDirtyKeys } from '../lib/dirty';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { setThemePreference, useThemePreference, type ThemePreference } from '../lib/theme';
import { Access } from './config/groups/Access';
import { ClaudeCode } from './config/groups/ClaudeCode';
import { Connections } from './config/groups/Connections';
import { Decisions } from './config/groups/Decisions';
import { Extensions } from './config/groups/Extensions';
import { General } from './config/groups/General';
import { Instructions } from './config/groups/Instructions';
import { Runs } from './config/groups/Runs';
import { SectionLevel, type GroupScreenProps } from './config/groups/Section';
import { useRevealSetting } from './config/search/reveal';
import { SettingsSearchField, SettingsSearchResults, useSettingsSearch, type SettingsSearchState } from './config/search/SettingsSearch';
import {
  detailLabel,
  GROUP_ORDER,
  groupLabel,
  isDetailOf,
  isGroupDirty,
  isSettingsGroup,
  resolveSettingsAddress,
  settingsHref,
  type SettingsDetailId,
  type SettingsGroupId,
} from './config/settingsGroups';

const THEMES: ThemePreference[] = ['system', 'light', 'dark'];

type AnyScreen = ComponentType<{ detail?: SettingsDetailId | undefined }>;
// Each group's screen takes the detail the address names; the shell has already checked it is one of the group's
const screen = <G extends SettingsGroupId>(component: ComponentType<GroupScreenProps<G>>) => component as AnyScreen;
const SCREENS: Record<SettingsGroupId, AnyScreen> = {
  general: screen(General),
  'claude-code': screen(ClaudeCode),
  connections: screen(Connections),
  instructions: screen(Instructions),
  extensions: screen(Extensions),
  decisions: screen(Decisions),
  runs: screen(Runs),
  access: screen(Access),
};

/** The group's screen, or one of its details. */
function Screen({ group, detail }: { group: SettingsGroupId; detail: SettingsDetailId | undefined }) {
  const Group = SCREENS[group];
  return <Group detail={detail} />;
}

function DirtyMark() {
  const { t } = useTranslation('primitives');
  return (
    <>
      <span className="tab-dirty" aria-hidden />
      <span className="sr-only"> ({t('ui.unsavedChangesLabel')})</span>
    </>
  );
}

/**
 * The desktop: the search, then the eight groups as one vertical tablist next to the group's screen
 * or a detail. While the search has a query its results take the groups' place.
 */
function DesktopSettings({
  group,
  detail,
  search,
  searchRef,
}: {
  group: SettingsGroupId;
  detail: SettingsDetailId | undefined;
  search: SettingsSearchState;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useTranslation(['home', 'config']);
  const navigate = useNavigate();
  const dirtyKeys = useDirtyKeys();
  const id = useTabGroup();
  const tabId = (item: SettingsGroupId) => `${id}-tab-${item}`;
  const panelId = `${id}-panel`;
  const listId = `${id}-results`;
  const searching = search.query !== '';

  // Group and detail changes are path changes: the page's leave guard asks before any of them
  const select = (next: SettingsGroupId) => navigate(settingsHref(next));

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = GROUP_ORDER.indexOf(group);
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const backward = event.key === 'ArrowUp' || event.key === 'ArrowLeft';
    let next: SettingsGroupId | undefined;
    if (event.key === 'Home') next = GROUP_ORDER[0];
    else if (event.key === 'End') next = GROUP_ORDER[GROUP_ORDER.length - 1];
    else if (forward || backward) next = GROUP_ORDER[(at + (forward ? 1 : -1) + GROUP_ORDER.length) % GROUP_ORDER.length];
    if (!next) return;
    event.preventDefault();
    document.getElementById(tabId(next))?.focus();
    select(next);
  };

  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-labelledby={`${id}-title`}>
        <h1 id={`${id}-title`} className="settings-title">
          {t('settings.title')}
        </h1>
        <SettingsSearchField search={search} listId={listId} inputRef={searchRef} />
        {searching && <SettingsSearchResults search={search} listId={listId} />}
        {/* Hidden, not unmounted, while searching: the panel stays named by its tab */}
        <div className="settings-nav-tabs" role="tablist" aria-orientation="vertical" aria-label={t('config:settings.nav')} hidden={searching}>
          {GROUP_ORDER.map((item) => {
            const on = item === group;
            return (
              <button
                key={item}
                id={tabId(item)}
                type="button"
                role="tab"
                aria-selected={on}
                aria-controls={panelId}
                tabIndex={on ? 0 : -1}
                className={`settings-nav-item ${on ? 'is-on' : ''}`}
                // On a detail, its own group's tab is the way back to the group
                onClick={() => (!on || detail) && select(item)}
                onKeyDown={onKeyDown}
              >
                <span className="settings-nav-name">{t(groupLabel(item))}</span>
                {isGroupDirty(dirtyKeys, item) && <DirtyMark />}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="settings-body" role="tabpanel" id={panelId} aria-labelledby={tabId(group)} key={`${group}/${detail ?? ''}`}>
        <header className="settings-head">
          {detail && (
            // Named in words: a screen reader would read the arrow of the visible label
            <Link className="settings-back" to={settingsHref(group)} aria-label={t('config:settings.backTo', { group: t(groupLabel(group)) })}>
              {t('config:settings.back', { group: t(groupLabel(group)) })}
            </Link>
          )}
          <h2 className="settings-head-title" tabIndex={-1} data-settings-title>{detail ? t(detailLabel(detail)) : t(groupLabel(group))}</h2>
        </header>
        <SectionLevel.Provider value={3}>
          <Screen group={group} detail={detail} />
        </SectionLevel.Provider>
      </div>
    </div>
  );
}

/** The phone's first screen: the search, the theme at hand, then the eight groups as cells of one card. */
function PhoneSettingsList({ search, searchRef }: { search: SettingsSearchState; searchRef: RefObject<HTMLInputElement | null> }) {
  const { t } = useTranslation(['home', 'config', 'shell']);
  const dirtyKeys = useDirtyKeys();
  const theme = useThemePreference();
  const ownHead = useOwnPhoneHeader();
  const listId = `${useTabGroup()}-results`;

  return (
    <div className="settings-phone">
      {/* MobileAjustes: reached from Más, so its back goes to where it was opened from */}
      {ownHead ? (
        <PhoneHeader title={t('settings.title')} />
      ) : (
        <header className="settings-phone-head">
          <h1 className="settings-phone-title">{t('settings.title')}</h1>
        </header>
      )}

      <SettingsSearchField search={search} listId={listId} inputRef={searchRef} />

      {search.query !== '' ? (
        <SettingsSearchResults search={search} listId={listId} />
      ) : (
        <>
          <section className="card settings-phone-theme" aria-labelledby="settings-phone-theme">
            <h2 id="settings-phone-theme" className="section-label">
              {t('shell:appearance.theme')}
            </h2>
            <Segmented
              label={t('shell:appearance.theme')}
              value={theme}
              onChange={setThemePreference}
              options={THEMES.map((value) => ({ value, label: t(`shell:appearance.themeOptions.${value}`) }))}
            />
          </section>

          <ul className="card settings-cells" aria-label={t('config:settings.nav')}>
            {GROUP_ORDER.map((item) => (
              <li key={item}>
                <Link className="settings-cell" to={settingsHref(item)}>
                  <span className="settings-cell-name">{t(groupLabel(item))}</span>
                  {isGroupDirty(dirtyKeys, item) && <DirtyMark />}
                  <ChevronRight className="settings-cell-chevron" {...ICON} />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** A group or a detail on a phone is a screen of its own, with the way one step up above it. */
function PhoneSettingsScreen({ group, detail }: { group: SettingsGroupId; detail: SettingsDetailId | undefined }) {
  const { t } = useTranslation(['home', 'config']);
  const navigate = useNavigate();
  const ownHead = useOwnPhoneHeader();
  const title = detail ? t(detailLabel(detail)) : t(groupLabel(group));
  // Back is a step up (detail → group → list), not through history: a deep link has nothing behind it
  const up = detail ? settingsHref(group) : '/settings';
  const backLabel = detail ? t('config:settings.backTo', { group: t(groupLabel(group)) }) : t('config:config.phone.back');
  const onBack = () => navigate(up);

  return (
    <div className="settings-phone">
      {ownHead ? (
        <PhoneHeader title={title} back={{ label: backLabel, onBack }} />
      ) : (
        <header className="settings-phone-head">
          <button type="button" className="icon-btn settings-phone-back" aria-label={backLabel} onClick={onBack}>
            <ChevronLeft {...ICON} />
          </button>
          <h1 className="settings-phone-title">{title}</h1>
        </header>
      )}
      <SectionLevel.Provider value={2}>
        <Screen group={group} detail={detail} />
      </SectionLevel.Provider>
    </div>
  );
}

/** `/` focuses the search while Settings is open, unless the person is typing somewhere. */
function useSlashToSearch(input: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role=textbox], .cm-editor')) return;
      if (!input.current) return;
      event.preventDefault();
      input.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [input]);
}

function SettingsInner() {
  const { t } = useTranslation('home');
  const location = useLocation();
  const params = useParams();
  const phone = useMediaQuery(NARROW);
  const search = useSettingsSearch();
  const searchRef = useRef<HTMLInputElement>(null);
  usePageTitle(t('settings.title'));
  useRevealSetting();
  useSlashToSearch(searchRef);

  // An old `?tab=` address (a bookmark, a doc, a notification) lands where its tab went
  const legacy = resolveSettingsAddress(location.search, location.hash);
  if (legacy !== null) return <Navigate to={legacy} replace />;

  const asked = params.group;
  const detailAsked = params.detail;
  if (asked !== undefined && !isSettingsGroup(asked)) return <Navigate to="/settings" replace />;
  const group = asked;
  const detail = group && isDetailOf(group, detailAsked) ? (detailAsked as SettingsDetailId) : undefined;
  if (detailAsked !== undefined && detail === undefined) return <Navigate to="/settings" replace />;

  if (phone) {
    if (!group) return <PhoneSettingsList search={search} searchRef={searchRef} />;
    return <PhoneSettingsScreen group={group} detail={detail} />;
  }
  return <DesktopSettings group={group ?? 'general'} detail={detail} search={search} searchRef={searchRef} />;
}

export function Settings() {
  return (
    <DirtyProvider>
      <SettingsInner />
    </DirtyProvider>
  );
}
