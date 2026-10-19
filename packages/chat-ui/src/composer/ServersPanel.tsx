import type { Chat, ChatClaudioMcp, ChatMcpServers, LiveMcpServer } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Plug, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Switch } from '@claudio/ui/components/controls/Toggle';
import { BrandMark, ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import { chatKeys, useChatUi } from '../lib/context';

/** What each status reads as, in the design system's status colours. */
const TONE: Record<LiveMcpServer['status'], string> = { connected: 'ok', 'needs-auth': 'warn', failed: 'bad', pending: 'muted', disabled: 'muted', unknown: 'muted' };

/** How often the list is read again while a server is still connecting. */
const PENDING_POLL_MS = 2000;

export const mcpKey = (chatId: string) => [...chatKeys.chatScope(chatId), 'mcp'] as const;

/** The name Claudio's own server goes by in the CLI's list */
const CLAUDIO_SERVER = 'claudio';

/** Whether the chat offers Claudio's own server at all: the assistant has it already, and other agents never do. */
export function offersClaudio(state: ChatClaudioMcp | undefined): state is ChatClaudioMcp {
  return state !== undefined && state.unavailable !== 'assistant' && state.unavailable !== 'provider';
}

/**
 * The panel's rows: Claudio's own server apart (when the chat offers it), and the CLI's list without
 * its entry for it, so a server that is on is shown, and counted, once.
 */
function panelRows(data: Pick<ChatMcpServers, 'servers' | 'claudio'>) {
  const { servers, claudio } = data;
  const offered = offersClaudio(claudio);
  // Once on, the CLI lists it too: shown once, in its own row
  const ours = offered && claudio.on ? servers.find((s) => s.name === CLAUDIO_SERVER && s.scope === 'dynamic') : undefined;
  return { claudio: offered ? claudio : null, ours: ours ?? null, list: ours ? servers.filter((s) => s !== ours) : servers };
}

/**
 * How many of the panel's switches are on, for the one-line summaries (the "+" menu, the chip, the
 * options popover); null until they are read. Claudio's row counts as one, on when it is switched on,
 * so the summary and the panel never disagree.
 */
export function serversOn(data: Pick<ChatMcpServers, 'servers' | 'claudio'> | undefined): { on: number; total: number } | null {
  if (!data) return null;
  const { claudio, list } = panelRows(data);
  const on = list.filter((s) => s.status !== 'disabled').length + (claudio?.on ? 1 : 0);
  return { on, total: list.length + (claudio ? 1 : 0) };
}

/** The servers of the live process, read when `enabled` (the menu is open) and again while one connects. */
export function useLiveServers(chatId: string, enabled: boolean) {
  const { client } = useChatUi();
  return useQuery({
    queryKey: mcpKey(chatId),
    queryFn: () => client.chatMcp(chatId),
    enabled,
    // Opening the menu is asking what the servers are now
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.servers.some((s) => s.status === 'pending') ? PENDING_POLL_MS : false),
  });
}

/**
 * The servers and connectors list, with its switches: live controls do not belong inside a menu, so
 * the "+" menu opens this in a panel (a step of the phone's sheet).
 */
export function ServersPanel({ chat, live, onChooseTools, onDone }: { chat: Chat; live: boolean; onChooseTools: () => void; onDone: () => void }) {
  const { t } = useTranslation('chat');
  if (live) return <LiveServers chat={chat} />;
  return (
    <div className="composer-menu-note">
      <p className="small muted">{t('composerMenu.serversAtStart')}</p>
      <button
        type="button"
        className="btn btn-small"
        onClick={() => {
          onDone();
          onChooseTools();
        }}
      >
        <SlidersHorizontal {...ICON_SM} aria-hidden /> {t('composerMenu.chooseServers')}
      </button>
    </div>
  );
}

function LiveServers({ chat }: { chat: Chat }) {
  const chatId = chat.id;
  const { t } = useTranslation('chat');
  const { client, paths } = useChatUi();
  const queryClient = useQueryClient();
  const servers = useLiveServers(chatId, true);
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => client.toggleChatMcp(chatId, name, enabled),
    onSuccess: (data) => queryClient.setQueryData(mcpKey(chatId), data),
  });

  if (servers.isLoading) return <Skeleton rows={2} height={5} />;
  if (servers.error) return <ErrorBox error={servers.error} />;
  const { claudio, ours, list } = panelRows(servers.data ?? { servers: [] });
  return (
    <>
      {claudio && <ClaudioRow chat={chat} state={claudio} server={ours} />}
      {list.length === 0 ? (
        <p className="small muted">{t('composerMenu.noServers')}</p>
      ) : (
        <ul className="composer-servers">
          {list.map((server) => {
            const connector = server.kind === 'connector';
            const { label } = server;
            const on = server.status !== 'disabled';
            const Icon = connector ? Cloud : Plug;
            return (
              <li key={server.name} className={`composer-server ${on ? '' : 'is-off'}`.trimEnd()}>
                <Icon {...ICON_SM} className="composer-server-icon" aria-hidden />
                <div className="composer-server-body">
                  <span className="composer-server-name ellipsis">{label}</span>
                  <span className="composer-server-meta small">
                    <Tag tone={TONE[server.status]}>{t(`composerMenu.claudioStatus.${server.status}`)}</Tag>
                    {connector && <span className="muted">{t('composerMenu.connector')}</span>}
                    {server.tools.length > 0 && <span className="muted tnum">{t('composerMenu.tools', { count: server.tools.length })}</span>}
                    {server.status === 'needs-auth' && (
                      <Link to={paths.connectors} className="composer-server-link">
                        {t('composerMenu.authorise')}
                      </Link>
                    )}
                  </span>
                  {server.error && <span className="small composer-server-error">{server.error}</span>}
                </div>
                <Switch
                  checked={on}
                  onChange={(enabled) => toggle.mutate({ name: server.name, enabled })}
                  disabled={toggle.isPending}
                  aria-label={t(on ? 'composerMenu.turnOff' : 'composerMenu.turnOn', { name: label })}
                  className="composer-server-switch"
                />
              </li>
            );
          })}
        </ul>
      )}
      <ErrorBox error={toggle.error} />
      <p className="small muted composer-menu-foot">{t('composerMenu.serversPersist')}</p>
    </>
  );
}

/**
 * Claudio's own server, first in the panel: one switch for all its tools, which then ask as the
 * chat's permission mode says. The choice stays with the chat for its next processes.
 */
function ClaudioRow({ chat, state, server }: { chat: Chat; state: ChatClaudioMcp; server: LiveMcpServer | null }) {
  const { t } = useTranslation('chat');
  const { client } = useChatUi();
  const queryClient = useQueryClient();
  const turn = useMutation({
    mutationFn: (enabled: boolean) => client.setChatClaudioMcp(chat.id, enabled),
    onSuccess: (data) => {
      queryClient.setQueryData(mcpKey(chat.id), data);
      // The chat's tool record holds the choice: its options and start forms read it from there
      void queryClient.invalidateQueries({ queryKey: chatKeys.chatScope(chat.id) });
    },
  });
  const status = state.on ? server?.status : undefined;
  const refusal = state.error ?? (status === 'failed' ? server?.error : null) ?? null;
  const bypass = chat.execution?.permissionMode === 'bypassPermissions';
  // The row is not drawn for the assistant or another agent, so only these two can be the reason
  const reason = state.unavailable === 'clash' || state.unavailable === 'no-api' ? state.unavailable : null;
  return (
    <div className="composer-servers-claudio">
      <div className="composer-servers-claudio-row">
        <BrandMark size={16} />
        <div className="composer-server-body">
          <span className="composer-servers-claudio-name">{t('composerMenu.claudio')}</span>
          <span className="small muted">{t('composerMenu.claudioSummary')}</span>
          {/* Drawn while off too, empty: switching it on fills the line instead of pushing the list down */}
          <span className="composer-server-meta composer-servers-claudio-status small" aria-hidden={status ? undefined : true}>
            {status && (
              <>
                {server && server.tools.length > 0 && <span className="muted tnum">{t('composerMenu.tools', { count: server.tools.length })}</span>}
                {status === 'pending' && <Spinner />}
                <Tag tone={TONE[status]}>{t(`composerMenu.claudioStatus.${status}`)}</Tag>
              </>
            )}
          </span>
          {reason && <span className="small muted">{t(`composerMenu.claudioUnavailable.${reason}`)}</span>}
          {refusal && (
            <span className="small composer-server-error">
              {t('composerMenu.claudioRefused')} <code className="mono">{refusal}</code>
            </span>
          )}
        </div>
        <Switch
          checked={state.on}
          onChange={(enabled) => turn.mutate(enabled)}
          disabled={turn.isPending || state.unavailable !== null}
          aria-label={t(state.on ? 'composerMenu.turnOff' : 'composerMenu.turnOn', { name: t('composerMenu.claudio') })}
          className="composer-server-switch"
        />
      </div>
      {bypass && (
        <p className="small composer-servers-claudio-warn">
          <TriangleAlert {...ICON_SM} aria-hidden /> {t('composerMenu.claudioBypass')}
        </p>
      )}
      <ErrorBox error={turn.error} />
    </div>
  );
}
