import type { AuditEntry } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { useFallbackInterval } from '../../../lib/events';
import { Combobox, Select, Tooltip, type SelectOption } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Card, Empty, ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import { formatDateTime, formatNumber, middleEllipsis, shortPath } from '@claudio/ui/lib/format';
import type { en } from '../../../i18n/resources';
import { GLOBAL_SCOPE, useListParams } from '../../../lib/list-params';
import { SettingsDetailRow } from '../groups/Section';
import { ActorName } from './ActorName';
import { settingsHref } from '../settingsGroups';

const AUDIT_PAGE = 25;
/** The newest writes the group's screen shows; the detail owns the rest and the filters */
export const AUDIT_LATEST = 5;
// Only writes are recorded, so a GET filter could never match
const AUDIT_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
type AuditMethod = '' | (typeof AUDIT_METHODS)[number];
const AUDIT_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;
// What the server accepts; anything else would come back as a 400, so it is held back and named
const STATUS_FILTER = /^[1-5](\d\d|xx)$/i;

/** What a status code means for the person reading the list; the number alone says little at a glance. */
function outcome(status: number): { tone: 'ok' | 'warn' | 'bad'; key: 'ok' | 'unauthorized' | 'readOnly' | 'rejected' | 'failed' } {
  if (status < 400) return { tone: 'ok', key: 'ok' };
  if (status === 401 || status === 403) return { tone: 'warn', key: 'unauthorized' };
  if (status === 405) return { tone: 'warn', key: 'readOnly' };
  if (status < 500) return { tone: 'warn', key: 'rejected' };
  return { tone: 'bad', key: 'failed' };
}

/** What the audit's filters keep until they are cleared, as typed */
const AUDIT_PARAMS = ['path', 'method', 'status'] as const;

/** Settings → Access & safety → Audit log: every write, newest first, with its filters and its pages. */
export function AuditCard() {
  const { t } = useTranslation(['config', 'common']);
  const { params, patch, reset } = useListParams('audit', AUDIT_PARAMS, GLOBAL_SCOPE);
  const filter = params.get('path') ?? '';
  const method = AUDIT_METHODS.find((m) => m === params.get('method')) ?? '';
  const statusText = params.get('status') ?? '';
  const statusTyped = statusText.trim();
  const statusInvalid = statusTyped !== '' && !STATUS_FILTER.test(statusTyped);
  // What the request asks for trails the fields by a pause in typing, but starts where they were left
  const [path, setPath] = useState(() => filter.trim());
  const [status, setStatus] = useState(() => (statusInvalid ? '' : statusTyped.toLowerCase()));
  const [from, setFrom] = useState(0);

  // One request per pause in typing, not per keystroke
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPath(filter.trim());
      if (!statusInvalid) setStatus(statusTyped.toLowerCase());
      setFrom(0);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [filter, statusTyped, statusInvalid]);

  const filtered = path !== '' || method !== '' || status !== '';
  const methodOptions: SelectOption<AuditMethod>[] = [
    { value: '', label: t('config:security.audit.anyMethod') },
    ...AUDIT_METHODS.map((value) => ({ value, label: value })),
  ];

  const fallback = useFallbackInterval();
  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: keys.audit({ from, path, method, status }),
    queryFn: () => api.audit({ limit: AUDIT_PAGE, from, path, method: method || undefined, status: status || undefined }),
    // Every event reads the log again at a slow pace (`ALWAYS` in lib/events)
    refetchInterval: fallback,
    placeholderData: (previous) => previous,
  });
  const entries: AuditEntry[] = data?.entries ?? [];
  const total = data?.total ?? 0;
  const last = from + entries.length;

  return (
    <Card
      actions={
        <button type="button" className="icon-btn" aria-label={t('config:shared.refresh')} disabled={isFetching} onClick={() => void refetch()}>
          <RefreshCw {...ICON_SM} />
        </button>
      }
    >
      <p className="small muted">{t('config:security.audit.intro')}</p>
      <div className="filter-bar">
        <div className="search-field grow">
          <Search {...ICON_SM} />
          <input
            type="search"
            placeholder={t('config:security.audit.filterPlaceholder')}
            aria-label={t('config:security.audit.filterLabel')}
            value={filter}
            onChange={(e) => patch({ path: e.target.value })}
          />
        </div>
        <Select
          aria-label={t('config:security.audit.methodLabel')}
          value={method}
          options={methodOptions}
          onChange={(next) => {
            patch({ method: next });
            setFrom(0);
          }}
        />
        <Combobox
          aria-label={t('config:security.audit.statusLabel')}
          placeholder={t('config:security.audit.statusPlaceholder')}
          className={`audit-status ${statusInvalid ? 'is-invalid' : ''}`}
          value={statusText}
          options={AUDIT_CLASSES.map((value) => ({ value, hint: t(`config:security.audit.statusClass.${value}`) }))}
          onChange={(next) => patch({ status: next })}
        />
        {(filter !== '' || method !== '' || statusText !== '') && (
          <button
            type="button"
            className="btn btn-small"
            onClick={reset}
          >
            {t('config:security.audit.clearFilters')}
          </button>
        )}
      </div>
      {statusInvalid && (
        <p className="field-hint text-err" role="status">
          {t('config:security.audit.statusInvalid')}
        </p>
      )}
      <ErrorBox error={error} />
      {isLoading ? (
        <Skeleton rows={5} />
      ) : entries.length === 0 ? (
        <Empty title={filtered ? t('config:security.audit.noMatch') : t('config:security.audit.none')}>
          {filtered ? t('config:security.audit.noMatchHint') : t('config:security.audit.noneHint')}
        </Empty>
      ) : (
        <>
          <AuditTable entries={entries} />
          <div className="form-actions">
            <button type="button" className="btn btn-small" disabled={from === 0} onClick={() => setFrom(Math.max(0, from - AUDIT_PAGE))}>
              <ChevronLeft {...ICON_SM} aria-hidden />
              {t('config:security.audit.newer')}
            </button>
            <span className="small muted" role="status">
              {t('config:security.audit.range', { first: formatNumber(from + 1), last: formatNumber(last), total: formatNumber(total) })}
            </span>
            <button type="button" className="btn btn-small" disabled={last >= total} onClick={() => setFrom(from + AUDIT_PAGE)}>
              {t('config:security.audit.older')}
              <ChevronRight {...ICON_SM} aria-hidden />
            </button>
          </div>
        </>
      )}
    </Card>
  );
}

/** How long a path may run on a phone row before it folds to its tail */
const PHONE_PATH = 40;
/** What the table's Request column holds of a path, on its own line under the method */
const TABLE_PATH = 20;

function Actor({ actor }: { actor: string }) {
  return <ActorName actor={actor} wordClassName="audit-actor" literalClassName="mono audit-literal" />;
}

/**
 * What a row did, in the reader's language: the route's line from `auditRoutes`, or the English
 * summary the server stored when the row has no route (older rows, the wrapper's own) or names one
 * this build does not know. A request no route matched has only its method and path for a summary,
 * which the request beside it already shows as a literal, so it says that in words instead.
 */
function useWhat(): (entry: AuditEntry) => string {
  const { t } = useTranslation(['auditRoutes', 'config']);
  return (entry) => {
    if (entry.route !== null) {
      // The keys hold `:` and `/`, so neither separator may split them
      return t(entry.route as keyof (typeof en)['auditRoutes'], { keySeparator: false, nsSeparator: false, defaultValue: entry.summary });
    }
    return entry.summary === `${entry.method} ${entry.path}` ? t('config:security.audit.noRoute') : entry.summary;
  };
}

function Result({ status }: { status: number }) {
  const { t } = useTranslation('config');
  const result = outcome(status);
  return (
    <Tag tone={result.tone}>
      {status} · {t(`security.audit.outcome.${result.key}`)}
    </Tag>
  );
}

/**
 * The table's path, cut in the middle so the end that tells two routes apart stays (every path
 * starts `/api/`); a cut one takes focus and shows the whole path in a tooltip, for a keyboard too.
 */
function TablePath({ path }: { path: string }) {
  const short = middleEllipsis(path, TABLE_PATH);
  if (short === path) return <span className="mono audit-literal audit-path">{path}</span>;
  return (
    <Tooltip content={path}>
      <span className="mono audit-literal audit-path" tabIndex={0}>
        {short}
      </span>
    </Tooltip>
  );
}

/** The method and path of a phone row: a long path folds to its tail, and a tap shows all of it in place */
function RequestLine({ entry }: { entry: AuditEntry }) {
  const { t } = useTranslation('config');
  const [open, setOpen] = useState(false);
  const short = shortPath(entry.path, PHONE_PATH);
  if (short === entry.path) {
    return (
      <span className="mono audit-row-request">
        {entry.method} {entry.path}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="mono audit-row-request audit-row-path"
      aria-expanded={open}
      aria-label={`${entry.method} ${open ? entry.path : short} · ${t(open ? 'security.audit.hidePath' : 'security.audit.showPath')}`}
      onClick={() => setOpen(!open)}
    >
      {entry.method} {open ? entry.path : short}
    </button>
  );
}

/**
 * The rows themselves: the same on the group's screen and in the detail, so the two never disagree.
 * A table where the card is wide enough and, below 560 px of it, the same entries as rows that wrap.
 * The stylesheet shows one of the two, so only one is ever in the accessibility tree.
 */
export function AuditTable({ entries }: { entries: readonly AuditEntry[] }) {
  const { t } = useTranslation(['config', 'common']);
  const what = useWhat();
  return (
    <div className="audit-log">
      {/* Paged, so it needs no cap on its height; a keyboard can still scroll it */}
      <div className="table-wrap is-paged" role="group" aria-label={t('config:security.audit.title')} tabIndex={0}>
        <table className="table audit-table" aria-label={t('config:security.audit.title')}>
          <thead>
            <tr>
              <th scope="col" className="audit-col-when">
                {t('config:security.audit.when')}
              </th>
              <th scope="col" className="audit-col-actor">
                {t('config:security.audit.actor')}
              </th>
              <th scope="col" className="audit-col-request">
                {t('config:security.audit.request')}
              </th>
              <th scope="col" className="audit-col-result">
                {t('config:security.audit.result')}
              </th>
              <th scope="col">{t('config:security.audit.what')}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="small muted tnum audit-when">{formatDateTime(entry.at)}</td>
                <td className="small audit-who">
                  <Actor actor={entry.actor} />
                </td>
                <td className="small audit-request">
                  <span className="mono audit-method">{entry.method}</span>{' '}
                  <TablePath path={entry.path} />
                </td>
                <td className="audit-result">
                  <Result status={entry.status} />
                </td>
                <td className="small audit-summary">{what(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="audit-rows" aria-label={t('config:security.audit.title')}>
        {entries.map((entry) => (
          <li key={entry.id} className="audit-row">
            <div className="audit-row-head">
              <span className="small muted tnum">{formatDateTime(entry.at)}</span>
              {/* The separator travels with the actor, so a wrap never leaves it alone at a line's end */}
              <span className="small audit-row-actor">
                <span className="muted" aria-hidden>
                  ·{' '}
                </span>
                <Actor actor={entry.actor} />
              </span>
              <Result status={entry.status} />
            </div>
            <p className="audit-row-what">{what(entry)}</p>
            <RequestLine entry={entry} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Access & safety's Audit log section: the latest writes, no filters (the detail owns them), and
 * the row that opens the whole log with how many entries it holds.
 */
export function AuditLatest() {
  const { t } = useTranslation(['config', 'common']);
  const fallback = useFallbackInterval();
  const { data, error, isLoading } = useQuery({
    // Its own entry under the audit's prefix: the detail's first page holds more rows than this
    queryKey: [...keys.audit({ from: 0 }), 'latest'],
    queryFn: () => api.audit({ limit: AUDIT_LATEST, from: 0 }),
    // Every event reads the log again at a slow pace (`ALWAYS` in lib/events)
    refetchInterval: fallback,
  });
  const entries = data?.entries ?? [];
  return (
    <>
      <p className="small muted">{t('config:security.audit.intro')}</p>
      <ErrorBox error={error} />
      {isLoading ? <Skeleton rows={AUDIT_LATEST} /> : entries.length === 0 ? !error && <p className="small muted">{t('config:security.audit.none')}</p> : <AuditTable entries={entries} />}
      <SettingsDetailRow
        to={settingsHref('access', { detail: 'audit' })}
        label={t('config:security.audit.openAll')}
        note={data ? t('config:security.audit.count', { count: data.total, formatted: formatNumber(data.total) }) : undefined}
      />
    </>
  );
}
