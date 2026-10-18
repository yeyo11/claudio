import type { Connector, ConnectorAction, ConnectorKind, ConnectorsOverview } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useContext, useEffect, useState } from 'react';
import { CalendarDays, ExternalLink, FileText, KeyRound, Mail, Plug, RefreshCw, Sparkles, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { api, keys, useConnectors } from '../../api';
import { Tooltip } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { StatusDot } from '@claudio/ui/components/motion';
import { Spinner } from '@claudio/ui/components/Spinner';
import { Empty, ErrorBox, Skeleton, StatusBadge, Tag } from '@claudio/ui/components/ui';
import { formatDateTime, timeAgo } from '@claudio/ui/lib/format';
import { intlLocale } from '@claudio/ui/i18n/language';
import { connectorActionLabel, connectorLimitName, localized } from '../../lib/server-strings';
import { useProjectScope } from '../../lib/project-scope';
import { SectionLevel } from './groups/Section';
import '../../insights.css';

// The person finishes the sign-in in their browser: ask the CLI again every few seconds, for two minutes
const AUTH_POLL_MS = 4_000;
const AUTH_WAIT_MS = 120_000;

const KIND_ICON: Record<ConnectorKind, LucideIcon> = { docs: FileText, gmail: Mail, calendar: CalendarDays, other: Plug };

function ConnectorStatus({ status }: { status: Connector['status'] }) {
  const { t } = useTranslation('connectors');
  if (status === 'connected') {
    return (
      <span className="connector-state">
        <StatusDot tone="ok" /> {t('status.connected')}
      </span>
    );
  }
  // Warn means a person has to act: the key says it next to the word, never colour alone
  if (status === 'needs-auth') {
    return (
      <Tag tone="warn">
        <KeyRound {...ICON_SM} aria-hidden /> {t('status.needsAuth')}
      </Tag>
    );
  }
  // What the CLI does not say is shown as unknown, with the shape and the word of that status
  return <StatusBadge status="unknown" />;
}

/** `claude`, `/mcp`: the literal a person types, in mono; the rest stays prose. */
function withCode(text: string) {
  return text.split(/`([^`]+)`/).map((part, index) => (index % 2 === 1 ? <code key={index}>{part}</code> : part));
}

/**
 * Authorising a connector happens in an interactive `claude` session or in claude.ai's settings:
 * there is no command that does it. The steps and links are the server's, so they stay true to what
 * the CLI actually offers.
 */
function AuthorisationSteps({ guide }: { guide: ConnectorsOverview['authorisation'] }) {
  return (
    <>
      <ol className="connector-steps">
        {guide.steps.map((step, index) => (
          <li key={step.code}>
            <span className="count">{index + 1}</span>
            <span>{withCode(localized(step))}</span>
          </li>
        ))}
      </ol>
      {guide.links.length > 0 && (
        <div className="connector-links">
          {guide.links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer" className="meta-icon">
              {localized(link.label)} <ExternalLink {...ICON_SM} />
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function ConnectorCard({
  connector,
  guide,
  pending,
  onAsk,
  waiting,
  authUrl,
  authBusy,
  onAuthorise,
  setting,
}: {
  connector: Connector;
  guide: ConnectorsOverview['authorisation'];
  pending: string | null;
  onAsk: (connector: Connector, action: ConnectorAction) => void;
  /** This connector's sign-in is open in the browser and the page is watching for it */
  waiting: boolean;
  authUrl: string | null;
  authBusy: boolean;
  onAuthorise: (connector: Connector) => void;
  /** The search entry the steps answer, on the first card that shows them */
  setting?: string | undefined;
}) {
  const { t } = useTranslation('connectors');
  const Icon = KIND_ICON[connector.kind];
  const Name = useContext(SectionLevel) === 2 ? 'h3' : 'h4';
  const actions = connector.actions ?? [];
  const tone = connector.status === 'connected' ? 'is-ok' : connector.status === 'needs-auth' ? 'is-warn' : 'is-muted';
  return (
    <li className={`connector-row ${tone}`}>
      <div className="connector-head">
        <span className="connector-mark" aria-hidden>
          <Icon size={18} strokeWidth={1.75} />
        </span>
        <div className="connector-main">
          <Name className="connector-name break">{connector.name}</Name>
          <ConnectorStatus status={connector.status} />
          {connector.toolCount !== undefined && <span className="small muted tnum connector-tools">{t('toolCount', { count: connector.toolCount })}</span>}
          {connector.detail && connector.status !== 'connected' && <span className="mono small muted break">{t('cliSays', { detail: connector.detail })}</span>}
        </div>
        {connector.status === 'needs-auth' && (
          <div className="task-actions connector-actions">
            <button type="button" className="btn btn-small" disabled={authBusy || waiting} onClick={() => onAuthorise(connector)} aria-label={authBusy ? undefined : t('authorise.named', { connector: connector.name })}>
              <ExternalLink {...ICON_SM} aria-hidden /> {authBusy ? t('authorise.starting') : t('authorise.action')}
            </button>
          </div>
        )}
        {actions.length > 0 && (
          <div className="task-actions connector-actions">
            {actions.map((action) => (
              <Tooltip key={action.id} content={t('ask.hint')}>
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={pending !== null}
                  onClick={() => onAsk(connector, action)}
                  // While it starts the button says so, and that word is its name
                  aria-label={pending === `${connector.id}:${action.id}` ? undefined : t('ask.named', { action: connectorActionLabel(action), connector: connector.name })}
                >
                  <Sparkles {...ICON_SM} /> {pending === `${connector.id}:${action.id}` ? t('ask.starting') : t('ask.try', { action: connectorActionLabel(action) })}
                </button>
              </Tooltip>
            ))}
          </div>
        )}
      </div>
      {connector.status === 'needs-auth' && waiting && (
        <p className="connector-waiting small" role="status">
          <Spinner /> <span>{t('authorise.waiting')}</span>
          {authUrl && (
            <a href={authUrl} target="_blank" rel="noreferrer" className="meta-icon">
              {t('authorise.again')} <ExternalLink {...ICON_SM} aria-hidden />
            </a>
          )}
        </p>
      )}
      {connector.status === 'needs-auth' && (
        <div className="connector-body" {...(setting ? { 'data-setting': setting } : {})}>
          <AuthorisationSteps guide={guide} />
        </div>
      )}
      {connector.status === 'connected' && actions.length === 0 && <p className="muted small connector-body">{t('ask.none')}</p>}
    </li>
  );
}

/**
 * Settings → Connections → Connectors (docs/plans/settings-ia.md §6.3): the claude.ai connectors the
 * CLI lists, each with its state, its sign-in and its prepared prompts. It was a page of its own; the
 * page's header is the section's heading now, and what is out of reach is one line under the list.
 */
export function ConnectorsSection() {
  const { t } = useTranslation(['connectors', 'common']);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { project } = useProjectScope();
  // The CLI connects to every server to answer, which takes seconds: the server caches it for a
  // minute, and the button asks again on purpose
  const { data, error, isLoading, isFetching } = useConnectors();
  const refresh = useMutation({
    mutationFn: () => api.connectors(true),
    onSuccess: (next) => queryClient.setQueryData(keys.connectors, next),
  });
  const ask = useMutation({
    mutationFn: ({ action }: { connector: Connector; action: ConnectorAction }) =>
      // Its permission prompts come to the panel: a connector's tools are not pre-approved
      api.createChat({ prompt: action.prompt, permissionPrompts: 'host', ...(project?.exists ? { cwd: project.path } : {}) }),
    onSuccess: (chat) => navigate(`/chats/${chat.id}`),
  });
  // One sign-in at a time: the id being watched, and its URL for a link if the browser blocked the tab
  const [watching, setWatching] = useState<{ id: string; authUrl: string } | null>(null);
  const [timedOut, setTimedOut] = useState<string | null>(null);
  const authorise = useMutation({
    mutationFn: (connector: Connector) => api.authoriseConnector(connector.id).then((auth) => ({ connector, auth })),
    onSuccess: ({ connector, auth }) => {
      // The URL goes to the person's browser and nowhere else
      window.open(auth.authUrl, '_blank', 'noopener,noreferrer');
      setTimedOut(null);
      setWatching({ id: connector.id, authUrl: auth.authUrl });
    },
  });
  const watchedId = watching?.id ?? null;
  useEffect(() => {
    if (!watchedId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + AUTH_WAIT_MS;
    const poll = async () => {
      try {
        const next = await api.connectors(true);
        if (stopped) return;
        queryClient.setQueryData(keys.connectors, next);
        if (next.connectors.find((c) => c.id === watchedId)?.status === 'connected') return setWatching(null);
      } catch {
        // A failed read is one missed tick: the next one asks again
      }
      if (stopped) return;
      if (Date.now() >= deadline) {
        setTimedOut(watchedId);
        return setWatching(null);
      }
      timer = setTimeout(poll, AUTH_POLL_MS);
    };
    timer = setTimeout(poll, AUTH_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [watchedId, queryClient]);
  const pending = ask.isPending && ask.variables ? `${ask.variables.connector.id}:${ask.variables.action.id}` : null;

  const connectors = data?.connectors ?? [];
  const needsAuth = connectors.filter((c) => c.status === 'needs-auth');
  // Nothing usable and every one waiting on a person: that is the section's news, so it leads; with
  // one connector its own card already says so
  const allBlocked = connectors.length > 1 && needsAuth.length === connectors.length;
  // The steps are said once: inside a card that needs them, or on their own when no card shows them
  const stepsInCard = needsAuth.length > 0;

  // Relative and short, as the code hosts say it; the full date is the hover title
  const checked = data ? t('checked', { when: timeAgo(data.checkedAt) }) : t('subtitleLoading');
  const notListed = data && data.notListed.length > 0 ? `${t('notListed', { kinds: data.notListed.map((kind) => t(`kinds.${kind}`)).join(', ') })}${stepsInCard ? ` ${t('notListedSame')}` : ''}` : null;
  const firstNeedsAuth = needsAuth[0]?.id ?? null;
  const GuideTitle = useContext(SectionLevel) === 2 ? 'h3' : 'h4';

  return (
    <div className="connectors">
      <p className="small muted">{t('line')}</p>
      <div className="prov-toolbar">
        <button type="button" className="btn btn-small" aria-busy={refresh.isPending || isFetching} onClick={() => !(refresh.isPending || isFetching) && refresh.mutate()}>
          {/* One icon and one label in every state, so the button keeps its width; the line beside it says it is asking */}
          <RefreshCw {...ICON_SM} aria-hidden /> {t('refresh')}
        </button>
        <span className="prov-checked tnum connectors-checked" title={data ? formatDateTime(data.checkedAt) : undefined} aria-live="polite">
          {refresh.isPending || isFetching ? t('refreshing') : checked}
        </span>
      </div>
      <ErrorBox error={error ?? refresh.error ?? ask.error ?? authorise.error} />

      {isLoading ? (
        <Skeleton rows={4} height={20} />
      ) : data ? (
        <>
          {data.error && (
            <div className="alert alert-warn" role="alert">
              <div className="alert-body">
                <div className="strong">{t('cliFailed')}</div>
                <div className="small break">{data.error}</div>
              </div>
            </div>
          )}
          {allBlocked && !data.error && (
            <div className="card connectors-lead">
              <Empty icon={KeyRound} title={t('blocked.title', { count: connectors.length, name: connectors[0]?.name ?? '' })}>
                {t('blocked.body')}
              </Empty>
            </div>
          )}
          {timedOut && (
            <div className="alert alert-warn" role="status">
              <div className="alert-body small">{t('authorise.timedOut', { connector: timedOut })}</div>
            </div>
          )}
          {connectors.length === 0 && !data.error ? (
            <div className="card connectors-lead">
              <Empty icon={Plug} title={t('none')}>
                {t('noneHint')}
              </Empty>
            </div>
          ) : (
            connectors.length > 0 && (
              <ul className="lrows connectors-list">
                {connectors.map((connector) => (
                  <ConnectorCard key={connector.id} connector={connector} guide={data.authorisation} pending={pending}
                    onAsk={(c, action) => ask.mutate({ connector: c, action })}
                    waiting={watching?.id === connector.id}
                    authUrl={watching?.id === connector.id ? watching.authUrl : null}
                    authBusy={authorise.isPending && authorise.variables?.id === connector.id}
                    onAuthorise={(c) => authorise.mutate(c)}
                    setting={connector.id === firstNeedsAuth ? 'connectors.authorise' : undefined}
                  />
                ))}
              </ul>
            )
          )}
          {!stepsInCard && !data.error && (connectors.length === 0 || data.notListed.length > 0) && (
            <section className="card connector-guide" data-setting="connectors.authorise">
              <GuideTitle className="connector-name">{t('authorise.title')}</GuideTitle>
              <AuthorisationSteps guide={data.authorisation} />
            </section>
          )}
          {/* What the CLI does not list and what is out of reach, as one quiet line under the cards */}
          <p className="connectors-footnote" role="note">
            {notListed && !data.error && `${notListed} `}
            {t('unavailable.short', { items: new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(data.unavailable.map((item) => connectorLimitName(item))) })}
          </p>
        </>
      ) : null}
    </div>
  );
}
