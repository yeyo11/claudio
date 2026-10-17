import type { Chat, ChatContextUsage, CompactRefusal, ContextBreakdown, ContextCategory, ContextDetail, LiveMcpServer } from '@claudio/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minimize2 } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { mcpKey } from '@claudio/chat-ui/composer/ComposerMenu';
import { useAgentName } from '@claudio/chat-ui/lib/agent';
import { formatTokens } from '@claudio/chat-ui/lib/chat-model';
import { Collapsible } from '@claudio/ui/components/controls/Collapsible';
import { Sheet } from '@claudio/ui/components/controls/Sheet';
import { Switch } from '@claudio/ui/components/controls/Toggle';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { usageTone } from '@claudio/ui/components/motion';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { CopyButton, ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import { formatNumber, formatPercent } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { api, keys } from '../../api';
import { CompactDialog } from './CompactDialog';
import { categoryGroups, compactState, MCP_SERVERS_SHOWN, middleCut, shareText, windowOf } from './context-model';

// ---------- the controls the chat page shares ----------

interface ContextControls {
  openPanel(): void;
  openCompact(): void;
}

const NOTHING: ContextControls = { openPanel: () => undefined, openCompact: () => undefined };
const ControlsContext = createContext<ContextControls>(NOTHING);

/** The breakdown panel and the compact confirmation open from the inspector, the header and the health card: one place holds them. */
export function useContextControls(): ContextControls {
  return useContext(ControlsContext);
}

/**
 * Holds the two overlays of context control for one chat, and says when a compaction ends badly:
 * a failed one is a toast here and a notice row in the transcript.
 */
export function ContextControlProvider({ chat, children }: { chat: Chat; children: ReactNode }) {
  const { t } = useTranslation('chats');
  const toast = useToast();
  const queryClient = useQueryClient();
  const [panel, setPanel] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const value = useMemo<ContextControls>(() => ({ openPanel: () => setPanel(true), openCompact: () => setConfirm(true) }), []);

  const openId = chat.compact?.open?.id ?? null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    const previous = seen.current;
    seen.current = openId;
    if (!previous || openId === previous) return;
    // It closed: the notes and the list of compactions are read again, and a failure is said
    void queryClient.invalidateQueries({ queryKey: keys.chatNotes(chat.id) });
    void queryClient
      .fetchQuery({ queryKey: keys.chatCompactions(chat.id), queryFn: () => api.chatCompactions(chat.id), staleTime: 0 })
      .then((rows) => {
        const row = rows.find((r) => r.id === previous);
        if (row?.state === 'failed') toast.error(t('context.failed'), row.error ? new Error(row.error) : undefined);
      })
      .catch(() => undefined);
  }, [openId, chat.id, queryClient, toast, t]);

  return (
    <ControlsContext.Provider value={value}>
      {children}
      {panel && <ContextPanel chat={chat} onClose={() => setPanel(false)} onCompact={() => setConfirm(true)} />}
      {confirm && <CompactDialog chat={chat} onClose={() => setConfirm(false)} />}
    </ControlsContext.Provider>
  );
}

// ---------- the compact button ----------

/** The sentence that says why Compact now is not offered. */
export function useRefusalText(chat: Pick<Chat, 'control'>): (refusal: CompactRefusal) => string {
  const { t } = useTranslation('chats');
  const agent = useAgentName();
  return (refusal) => (refusal === 'read-only' && chat.control.mode === 'readOnly' ? chat.control.reason : t(`context.refusal.${refusal}`, { agent }));
}

/**
 * Compact now, neutral: it is a paid turn and not what the screen is about, so it is never the
 * gradient. A button that cannot be used stays focusable (`aria-disabled`) so its reason can be read.
 */
export function CompactButton({ chat, className = 'btn btn-small', onClick }: { chat: Chat; className?: string; onClick: () => void }) {
  const { t } = useTranslation('chats');
  const why = useRefusalText(chat);
  const { available, refusal, running } = compactState(chat);
  if (running) {
    return (
      <button type="button" className={`${className} ctx-action`} aria-disabled="true">
        <Spinner /> {t('context.actions.compacting')}
      </button>
    );
  }
  const reason = !available && refusal ? why(refusal) : null;
  const button = (
    <button
      type="button"
      className={`${className} ctx-action`}
      aria-disabled={available ? undefined : 'true'}
      aria-description={reason ?? undefined}
      onClick={() => available && onClick()}
    >
      <Minimize2 {...ICON_SM} aria-hidden /> {t('context.actions.compactNow')}
    </button>
  );
  return reason ? <Tooltip content={reason}>{button}</Tooltip> : button;
}

// ---------- the panel ----------

/** The panel: a dialog on a desktop, a sheet on a phone. It reads on open and again when the chat's run changes, never on a timer. */
export function ContextPanel({ chat, onClose, onCompact }: { chat: Chat; onClose: () => void; onCompact: () => void }) {
  const { t } = useTranslation('chats');
  const narrow = useMediaQuery(NARROW);
  const queryClient = useQueryClient();
  const [detail, setDetail] = useState<ContextDetail>('summary');
  const usage = useQuery({
    queryKey: keys.chatContext(chat.id, detail),
    queryFn: () => api.chatContext(chat.id, detail),
    staleTime: 0,
    retry: false,
    placeholderData: keepPreviousData,
  });
  const live = usage.data?.live === true;
  const serversKey = mcpKey(chat.id);
  const servers = useQuery({ queryKey: serversKey, queryFn: () => api.chatMcp(chat.id), enabled: live, staleTime: 0 });
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => api.toggleChatMcp(chat.id, name, enabled),
    onSuccess: (data) => {
      queryClient.setQueryData(serversKey, data);
      // The switch changes what the window holds
      void queryClient.invalidateQueries({ queryKey: ['chat', chat.id, 'context'] });
    },
  });

  const body = (
    <ContextPanelBody
      chat={chat}
      usage={usage.data}
      loading={usage.isPending}
      error={usage.error}
      detail={detail}
      servers={live ? servers.data?.servers : undefined}
      switching={toggle.isPending}
      switchError={toggle.error}
      onToggle={(name, enabled) => toggle.mutate({ name, enabled })}
      onExact={() => setDetail('full')}
      onRetry={() => void usage.refetch()}
    />
  );
  const foot = <PanelFoot chat={chat} onCompact={onCompact} />;
  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} title={t('context.panel.title')} footer={foot} className="ctx-sheet">
        {body}
      </Sheet>
    );
  }
  return (
    <Dialog title={t('context.panel.title')} onClose={onClose} width={720} footer={foot}>
      {body}
    </Dialog>
  );
}

function PanelFoot({ chat, onCompact }: { chat: Chat; onCompact: () => void }) {
  return (
    <div className="ctx-foot">
      <CompactButton chat={chat} className="btn btn-strong" onClick={onCompact} />
    </div>
  );
}

// ---------- the body, from data ----------

export interface ContextPanelBodyProps {
  chat: Chat;
  usage: ChatContextUsage | undefined;
  loading: boolean;
  error: unknown;
  /** The detail asked for; what the CLI answered is `usage.detail` */
  detail: ContextDetail;
  /** The live process's MCP servers, for the switches; undefined while there is no process or it has not answered */
  servers: LiveMcpServer[] | undefined;
  switching: boolean;
  switchError?: unknown;
  onToggle(name: string, enabled: boolean): void;
  onExact(): void;
  onRetry(): void;
}

export function ContextPanelBody(props: ContextPanelBodyProps) {
  const { t } = useTranslation('chats');
  const agent = useAgentName();
  const { chat, usage, loading, error } = props;
  if (!chat.context && !usage?.breakdown) {
    // Nothing has answered yet: the panel is not offered, and a link to it says so
    return <p className="small muted">{t('context.panel.neverAnswered')}</p>;
  }
  if (loading && !usage) return <Skeleton rows={6} height={12} />;
  if (error && !usage) {
    return (
      <div className="stack-tight">
        <ErrorBox error={error} />
        <div>
          <button type="button" className="btn btn-small" onClick={props.onRetry}>
            {t('context.actions.retry')}
          </button>
        </div>
      </div>
    );
  }
  if (!usage) return null;
  const { breakdown } = usage;
  return (
    <div className="ctx-breakdown">
      {breakdown ? <Head breakdown={breakdown} agent={agent} /> : <SnapshotHead usage={usage} />}
      {!breakdown && usage.unreported && (
        <div className="stack-tight">
          <p className="small muted">{t(`context.panel.unreported.${usage.unreported}`, { agent })}</p>
          {/* An agent that cannot report will not on a second try; a slow one may */}
          {usage.unreported === 'timeout' && (
            <div>
              <button type="button" className="btn btn-small" onClick={props.onRetry}>
                {t('context.actions.retry')}
              </button>
            </div>
          )}
        </div>
      )}
      {breakdown && <BreakdownBody {...props} usage={usage} breakdown={breakdown} />}
    </div>
  );
}

/** The bar and the words around it. Nothing here moves: a figure that changes on a refetch does not animate. */
function Meter({ used, window, mark, label }: { used: number; window: number | null; mark: number | null; label: string }) {
  const { t } = useTranslation('chats');
  if (window === null) return <p className="small muted">{t('context.panel.unknownWindow')}</p>;
  const share = used / window;
  const percent = Math.min(100, Math.round(share * 100));
  const tone = usageTone(Math.round(share * 100));
  return (
    <div className="ctx-bar">
      <div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={`${formatNumber(used)} / ${formatNumber(window)}`}>
        <span className={tone === 'neutral' ? 'meter-fill' : `meter-fill is-${tone}`} style={{ width: `${percent}%` }} />
      </div>
      {mark !== null && <span className="bar-mark" aria-hidden style={{ left: `${Math.min(100, Math.max(0, mark * 100))}%` }} />}
    </div>
  );
}

function SnapshotHead({ usage }: { usage: ChatContextUsage }) {
  const { t } = useTranslation('chats');
  const { snapshot } = usage;
  if (!snapshot) return <p className="small muted">{t('context.panel.neverAnswered')}</p>;
  return (
    <div className="ctx-head">
      <p className="small">
        <span className="ctx-figure">{snapshot.window === null ? t('context.panel.tokensOnly', { used: formatNumber(snapshot.used) }) : t('context.panel.tokensOf', { used: formatNumber(snapshot.used), window: formatNumber(snapshot.window) })}</span>
      </p>
      <Meter used={snapshot.compactedSince?.postTokens ?? snapshot.used} window={snapshot.window} mark={null} label={t('badges.context.inUse', { ns: 'chat' })} />
    </div>
  );
}

function Head({ breakdown, agent }: { breakdown: ContextBreakdown; agent: string }) {
  const { t } = useTranslation('chats');
  const window = windowOf(breakdown);
  const { autoCompact } = breakdown;
  const mark = autoCompact.enabled && autoCompact.thresholdTokens !== null && window !== null ? autoCompact.thresholdTokens / window : null;
  return (
    <div className="ctx-head">
      <div className="ctx-head-line">
        <span className="mono small">{breakdown.model}</span>
        <span className="small ctx-figure">
          {window === null
            ? t('context.panel.tokensOnly', { used: formatNumber(breakdown.totalTokens) })
            : t('context.panel.tokensOf', { used: formatNumber(breakdown.totalTokens), window: formatNumber(window) })}
        </span>
      </div>
      {/* Over the window the bar is full and bad, and the words say by how much */}
      <Meter used={breakdown.overBy !== null && window !== null ? window : breakdown.totalTokens} window={window} mark={mark} label={t('badges.context.inUse', { ns: 'chat' })} />
      {breakdown.overBy !== null && <p className="small ctx-over">{t('context.panel.over', { n: formatNumber(breakdown.overBy) })}</p>}
      <p className="small muted">
        {autoCompact.enabled
          ? mark !== null
            ? t('context.panel.autoAt', { agent, percent: formatPercent(Math.round(mark * 100)) })
            : t('context.panel.autoOn', { agent })
          : t('context.panel.autoOff')}
      </p>
    </div>
  );
}

function BreakdownBody({ chat, usage, breakdown, servers, switching, switchError, onToggle, onExact }: ContextPanelBodyProps & { usage: ChatContextUsage; breakdown: ContextBreakdown }) {
  const { t } = useTranslation('chats');
  const working = chat.state === 'working';
  const exact = usage.detail === 'full';
  return (
    <>
      <Categories breakdown={breakdown} />
      <McpSection breakdown={breakdown} servers={servers} switching={switching} switchError={switchError} onToggle={onToggle} />
      <Facts breakdown={breakdown} />
      <div className="ctx-count">
        <span className="small muted">{exact ? t('context.panel.exact') : t('context.panel.estimated')}</span>
        {!exact && (
          <button type="button" className="btn btn-small ctx-action" aria-disabled={working ? 'true' : undefined} aria-description={working ? t('context.panel.exactBusy') : undefined} onClick={() => !working && onExact()}>
            {t('context.actions.exact')}
          </button>
        )}
        {working && !exact && <span className="small muted">{t('context.panel.exactBusy')}</span>}
      </div>
    </>
  );
}

function CategoryName({ category }: { category: ContextCategory }) {
  const { t } = useTranslation('chats');
  // A name Claudio has no key for is shown as the CLI wrote it, in mono (D11)
  return category.key ? <>{t(`context.category.${category.key}`)}</> : <span className="mono">{category.name}</span>;
}

function Categories({ breakdown }: { breakdown: ContextBreakdown }) {
  const { t } = useTranslation('chats');
  const window = windowOf(breakdown);
  const { used, spare, deferred } = categoryGroups(breakdown.categories);
  const row = (category: ContextCategory, muted: boolean) => (
    <tr key={`${category.kind}-${category.name}`} className={muted ? 'is-muted' : undefined}>
      <th scope="row">
        <CategoryName category={category} />
      </th>
      <td className="num">{formatNumber(category.tokens)}</td>
      <td className="num">{(category.kind === 'deferred' ? null : shareText(category.tokens, window, t('context.panel.lessThanOne', { percent: formatPercent(1) }))) ?? '—'}</td>
    </tr>
  );
  return (
    <section className="ctx-section" aria-label={t('context.panel.categories')}>
      <h3 className="dialog-section">{t('context.panel.categories')}</h3>
      <table className="ctx-table">
        <caption className="sr-only">{t('context.panel.categoriesCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('context.panel.colName')}</th>
            <th scope="col" className="num">
              {t('context.panel.colTokens')}
            </th>
            <th scope="col" className="num">
              {t('context.panel.colShare')}
            </th>
          </tr>
        </thead>
        <tbody>
          {used.map((c) => row(c, false))}
          {spare.map((c) => row(c, true))}
        </tbody>
      </table>
      {deferred.length > 0 && (
        <div className="ctx-deferred">
          <h4 className="ctx-subhead">{t('context.panel.outside')}</h4>
          <p className="small muted">{t('context.panel.outsideHint')}</p>
          <table className="ctx-table">
            <caption className="sr-only">{t('context.panel.outside')}</caption>
            <tbody>{deferred.map((c) => row(c, true))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ServerRow({ server, live, switching, onToggle }: { server: ContextBreakdown['mcp']['servers'][number]; live: LiveMcpServer | undefined; switching: boolean; onToggle(name: string, enabled: boolean): void }) {
  const { t } = useTranslation('chats');
  const on = live ? live.status !== 'disabled' : true;
  const name = live?.label ?? server.server;
  return (
    <li className="ctx-server">
      <div className="ctx-server-body">
        <span className="ctx-server-name ellipsis">{name}</span>
        <span className="small muted tnum">{t('context.panel.mcpTools', { loaded: server.loadedTools, total: server.tools, tokens: formatNumber(server.tokens) })}</span>
      </div>
      {live && (
        <Switch
          checked={on}
          onChange={(enabled) => onToggle(live.name, enabled)}
          disabled={switching}
          aria-label={t(on ? 'composerMenu.turnOff' : 'composerMenu.turnOn', { ns: 'chat', name })}
          className="composer-server-switch"
        />
      )}
    </li>
  );
}

function McpSection({ breakdown, servers, switching, switchError, onToggle }: { breakdown: ContextBreakdown; servers: LiveMcpServer[] | undefined; switching: boolean; switchError?: unknown; onToggle(name: string, enabled: boolean): void }) {
  const { t } = useTranslation('chats');
  const { mcp } = breakdown;
  const byName = new Map((servers ?? []).map((s) => [s.name, s]));
  const rows = mcp.servers.map((server) => <ServerRow key={server.server} server={server} live={byName.get(server.server)} switching={switching} onToggle={onToggle} />);
  const shown = rows.slice(0, MCP_SERVERS_SHOWN);
  const rest = rows.slice(MCP_SERVERS_SHOWN);
  return (
    <section className="ctx-section" aria-label={t('context.panel.mcp')}>
      <h3 className="dialog-section">{t('context.panel.mcp')}</h3>
      {mcp.warnings.length > 0 && (
        <ul className="ctx-warnings list-plain">
          {mcp.warnings.map((warning) => (
            <li key={warning}>
              <Tag tone="warn">{warning === 'many-tools' ? t('context.panel.warn.many-tools', { count: mcp.loadedTools }) : t('context.panel.warn.large-share', { percent: formatPercent(Math.round(mcp.share * 100)) })}</Tag>
            </li>
          ))}
        </ul>
      )}
      {rows.length === 0 ? (
        <p className="small muted">{t('context.panel.mcpNone')}</p>
      ) : (
        <>
          <ul className="ctx-servers list-plain">{shown}</ul>
          {rest.length > 0 && (
            <Collapsible className="fold" title={<span className="small">{t('context.panel.mcpMore', { count: rest.length })}</span>}>
              <ul className="ctx-servers list-plain">{rest}</ul>
            </Collapsible>
          )}
          {servers && <p className="small muted">{t('composerMenu.serversPersist', { ns: 'chat' })}</p>}
        </>
      )}
      <ErrorBox error={switchError} />
    </section>
  );
}

function Facts({ breakdown }: { breakdown: ContextBreakdown }) {
  const { t } = useTranslation('chats');
  const { memoryFiles, agents, skills, slashCommands, messages } = breakdown;
  const counted = (c: { total: number; included: number; tokens: number }) => t('context.panel.counted', { included: c.included, total: c.total, tokens: formatNumber(c.tokens) });
  return (
    <>
      {memoryFiles.length > 0 && (
        <section className="ctx-section" aria-label={t('context.panel.memory')}>
          <h3 className="dialog-section">{t('context.panel.memory')}</h3>
          <ul className="ctx-files list-plain">
            {memoryFiles.map((file) => (
              <li key={file.path} className="ctx-file">
                <span className="mono small ctx-file-path" title={file.path}>
                  {middleCut(file.path)}
                </span>
                <span className="small muted num">{formatNumber(file.tokens)}</span>
                <CopyButton text={file.path} label={t('context.panel.copyPath', { path: file.path })} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {(agents.length > 0 || skills || slashCommands || messages) && (
        <section className="ctx-section" aria-label={t('context.panel.other')}>
          <h3 className="dialog-section">{t('context.panel.other')}</h3>
          <dl className="kv ctx-kv">
            {agents.length > 0 && (
              <>
                <dt>{t('context.panel.agents')}</dt>
                <dd className="tnum">{t('context.panel.agentsValue', { count: agents.length, tokens: formatNumber(agents.reduce((n, a) => n + a.tokens, 0)) })}</dd>
              </>
            )}
            {skills && (
              <>
                <dt>{t('context.panel.skills')}</dt>
                <dd className="tnum">{counted(skills)}</dd>
              </>
            )}
            {slashCommands && (
              <>
                <dt>{t('context.panel.commands')}</dt>
                <dd className="tnum">{counted(slashCommands)}</dd>
              </>
            )}
            {messages &&
              (['toolCalls', 'toolResults', 'attachments', 'assistant', 'user', 'other'] as const).map((part) =>
                messages[part] > 0 ? (
                  <MessagePart key={part} label={t(`context.panel.messages.${part}`)} tokens={messages[part]} />
                ) : null,
              )}
          </dl>
        </section>
      )}
    </>
  );
}

function MessagePart({ label, tokens }: { label: string; tokens: number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd className="tnum">{formatTokens(tokens)}</dd>
    </>
  );
}
