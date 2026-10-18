import type { AuditEntry } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, RefreshCw, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { Combobox, Select, type SelectOption } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Card, Empty, ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import { FullText } from '@claudio/ui/components/FullText';
import { formatDateTime, formatNumber } from '@claudio/ui/lib/format';
import { GLOBAL_SCOPE, useListParams } from '../../../lib/list-params';
import { SettingsDetailRow } from '../groups/Section';
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

  const { data, error, isLoading, isFetching, refetch } = useQuery({
    queryKey: keys.audit({ from, path, method, status }),
    queryFn: () => api.audit({ limit: AUDIT_PAGE, from, path, method: method || undefined, status: status || undefined }),
    refetchInterval: 15_000,
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

/** The rows themselves: the same on the group's screen and in the detail, so the two never disagree. */
function AuditTable({ entries }: { entries: readonly AuditEntry[] }) {
  const { t } = useTranslation(['config', 'common']);
  return (
    // The log outgrows its box as requests pile up: a keyboard has to be able to scroll it
    <div className="table-wrap" role="group" aria-label={t('config:security.audit.title')} tabIndex={0}>
      <table className="table audit-table" aria-label={t('config:security.audit.title')}>
        <thead>
          <tr>
            <th scope="col">{t('config:security.audit.when')}</th>
            <th scope="col">{t('config:security.audit.actor')}</th>
            <th scope="col">{t('config:security.audit.request')}</th>
            <th scope="col">{t('config:security.audit.result')}</th>
            <th scope="col">{t('config:security.audit.what')}</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const result = outcome(entry.status);
            return (
              <tr key={entry.id}>
                <td className="small muted nowrap">{formatDateTime(entry.at)}</td>
                <td className="small"><FullText className="mono audit-literal">{entry.actor}</FullText></td>
                <td>
                  <span className="strong">{entry.method}</span> <FullText className="small mono audit-literal">{entry.path}</FullText>
                </td>
                <td className="nowrap">
                  <Tag tone={result.tone}>
                    {entry.status} · {t(`config:security.audit.outcome.${result.key}`)}
                  </Tag>
                </td>
                <td className="small audit-summary">{entry.summary}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Access & safety's Audit log section: the latest writes, no filters (the detail owns them), and
 * the row that opens the whole log with how many entries it holds.
 */
export function AuditLatest() {
  const { t } = useTranslation(['config', 'common']);
  const { data, error, isLoading } = useQuery({
    // Its own entry under the audit's prefix: the detail's first page holds more rows than this
    queryKey: [...keys.audit({ from: 0 }), 'latest'],
    queryFn: () => api.audit({ limit: AUDIT_LATEST, from: 0 }),
    refetchInterval: 15_000,
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
