// Settings search's matching, pure so a test runs it in both languages (docs/plans/settings-ia.md §5).
import { groupLabel } from '../settingsGroups';
import { groupRank, SETTINGS_INDEX, type SettingEntry } from '../settingsIndex';

export const MAX_SETTING_RESULTS = 12;

/** Lower case and without diacritics, so "conexion" finds "Conexiones" and "CLAUDE" finds "claude". */
export const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const wordsOf = (text: string): string[] => fold(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * The registry's texts are keys of several namespaces held as plain strings, which the typed `t`
 * of a component does not take: this reads them through it all the same.
 */
export type Translate = (key: string) => string;
export const translator =
  (t: (key: never) => unknown): Translate =>
  (key) =>
    String((t as (key: string) => unknown)(key));

export interface SearchableSetting {
  entry: SettingEntry;
  label: string;
  group: string;
  labelWords: string[];
  keywordWords: string[];
  consequenceWords: string[];
}

/** The registry in the language being read: built once per language, searched on every key. */
export function searchableSettings(t: Translate, entries: readonly SettingEntry[] = SETTINGS_INDEX): SearchableSetting[] {
  return entries.map((entry) => {
    const label = t(entry.label);
    return {
      entry,
      label,
      group: t(groupLabel(entry.group)),
      labelWords: wordsOf(label),
      keywordWords: wordsOf(t(entry.keywords)),
      consequenceWords: entry.consequence ? wordsOf(t(entry.consequence)) : [],
    };
  });
}

const covers = (query: readonly string[], words: readonly string[]) => query.every((part) => words.some((word) => word.startsWith(part)));

/**
 * Every word of the query must be the start of some word of the label, the keywords or the
 * consequence. Label matches come first, then keywords, then consequence; ties by group order,
 * then by the registry's own order.
 */
export function matchSettings(items: readonly SearchableSetting[], query: string, limit = MAX_SETTING_RESULTS): SearchableSetting[] {
  const parts = wordsOf(query);
  if (parts.length === 0) return [];
  const ranked: Array<{ item: SearchableSetting; tier: number; at: number }> = [];
  items.forEach((item, at) => {
    const label = item.labelWords;
    const withKeywords = [...label, ...item.keywordWords];
    const tier = covers(parts, label) ? 0 : covers(parts, withKeywords) ? 1 : covers(parts, [...withKeywords, ...item.consequenceWords]) ? 2 : -1;
    if (tier >= 0) ranked.push({ item, tier, at });
  });
  ranked.sort((a, b) => a.tier - b.tier || groupRank(a.item.entry.group) - groupRank(b.item.entry.group) || a.at - b.at);
  // A section whose one row has its own name ("Skills", "Daily spend cap") would show twice: one
  // result, the row's when it opens a detail, the section's otherwise
  const unique: SearchableSetting[] = [];
  for (const { item } of ranked) {
    const twin = unique.findIndex((kept) => kept.entry.group === item.entry.group && kept.label === item.label);
    if (twin < 0) unique.push(item);
    else if (item.entry.detail && !unique[twin]?.entry.detail) unique[twin] = item;
  }
  return unique.slice(0, limit);
}
