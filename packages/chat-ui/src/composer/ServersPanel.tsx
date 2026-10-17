import type { Chat, LiveMcpServer } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Plug, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Switch } from '@claudio/ui/components/controls/Toggle';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import { chatKeys, useChatUi } from '../lib/context';

/** What each status reads as, in the design system's status colours. */
const TONE: Record<LiveMcpServer['status'], string> = { connected: 'ok', 'needs-auth': 'warn', failed: 'bad', pending: 'muted', disabled: 'muted', unknown: 'muted' };

/** How often the list is read again while a server is still connecting. */
const PENDING_POLL_MS = 2000;

export const mcpKey = (chatId: string) => [...chatKeys.chatScope(chatId), 'mcp'] as const;

/** How many of the servers are on, for the menu's one-line summary; null until they are read. */
export function serversOn(servers: readonly LiveMcpServer[] | undefined): { on: number; total: number } | null {
  if (!servers) return null;
  return { on: servers.filter((s) => s.status !== 'disabled').length, total: servers.length };
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
  if (live) return <LiveServers chatId={chat.id} />;
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

function LiveServers({ chatId }: { chatId: string }) {
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
  const list = servers.data?.servers ?? [];
  if (list.length === 0) return <p className="small muted">{t('composerMenu.noServers')}</p>;
  return (
    <>
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
                  <Tag tone={TONE[server.status]}>{server.status}</Tag>
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
      <ErrorBox error={toggle.error} />
      <p className="small muted composer-menu-foot">{t('composerMenu.serversPersist')}</p>
    </>
  );
}
