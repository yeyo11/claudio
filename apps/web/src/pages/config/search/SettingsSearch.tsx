import { Search } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ICON_SM } from '@claudio/ui/components/icons';
import type { SettingEntry } from '../settingsIndex';
import { matchSettings, searchableSettings, translator, type SearchableSetting } from './match';
import { entryHref, revealState } from './reveal';

/** The query, its results and the one that ↑ ↓ move to: shared by the field and the list it fills. */
export function useSettingsSearch() {
  const { t, i18n } = useTranslation(['config', 'decisions']);
  const navigate = useNavigate();
  const [query, setQueryState] = useState('');
  const [active, setActive] = useState(0);
  // Built again only when the language changes: every key press searches the same list
  const items = useMemo(() => searchableSettings(translator(t)), [t, i18n.language]);
  const results = useMemo(() => matchSettings(items, query), [items, query]);

  const setQuery = (next: string) => {
    setQueryState(next);
    setActive(0);
  };
  const open = (entry: SettingEntry) => {
    setQuery('');
    navigate(entryHref(entry), { state: revealState(entry) });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape' && query) {
      event.preventDefault();
      // The field keeps the focus: Escape clears, it does not leave
      event.stopPropagation();
      setQuery('');
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length > 0) {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((at) => (at + step + results.length) % results.length);
    } else if (event.key === 'Enter') {
      const chosen = results[active];
      if (!chosen) return;
      event.preventDefault();
      open(chosen.entry);
    }
  };
  return { query, setQuery, results, active, setActive, open, onKeyDown };
}

export type SettingsSearchState = ReturnType<typeof useSettingsSearch>;

const optionId = (list: string, at: number) => `${list}-option-${at}`;

/** The field: a combobox over the results list, which is drawn where the groups were. */
export function SettingsSearchField({ search, listId, inputRef }: { search: SettingsSearchState; listId: string; inputRef?: RefObject<HTMLInputElement | null> }) {
  const { t } = useTranslation('config');
  const showing = search.query !== '' && search.results.length > 0;
  return (
    <label className="search-field settings-search">
      <Search {...ICON_SM} />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-label={t('settings.search.label')}
        placeholder={t('settings.search.placeholder')}
        aria-keyshortcuts="/"
        aria-autocomplete="list"
        aria-expanded={search.query !== ''}
        aria-controls={listId}
        {...(showing ? { 'aria-activedescendant': optionId(listId, search.active) } : {})}
        autoComplete="off"
        spellCheck={false}
        value={search.query}
        onChange={(event) => search.setQuery(event.target.value)}
        onKeyDown={search.onKeyDown}
      />
    </label>
  );
}

/** The results in place of the groups: the group above each label, at most twelve. */
export function SettingsSearchResults({ search, listId }: { search: SettingsSearchState; listId: string }) {
  const { t } = useTranslation('config');
  if (search.results.length === 0) {
    return (
      <p id={listId} className="settings-results-none" role="status">
        {t('settings.search.none', { query: search.query })}
      </p>
    );
  }
  return (
    <ul id={listId} className="settings-results" role="listbox" aria-label={t('settings.search.results')}>
      {search.results.map((item: SearchableSetting, at) => (
        <li
          key={item.entry.id}
          id={optionId(listId, at)}
          role="option"
          aria-selected={at === search.active}
          className={`settings-result ${at === search.active ? 'is-active' : ''}`.trim()}
          // The field keeps the focus while a pointer picks; the click opens
          onPointerDown={(event) => event.preventDefault()}
          onPointerEnter={() => search.setActive(at)}
          onClick={() => search.open(item.entry)}
        >
          <span className="settings-result-group">{item.group}</span>
          <span className="settings-result-label">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}
