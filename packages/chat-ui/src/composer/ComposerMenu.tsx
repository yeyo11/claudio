import type { Chat, LiveMcpServer } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Paperclip, Plug, Plus, Slash, SlidersHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Switch } from '@claudio/ui/components/controls/Toggle';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import type { AttachmentsState } from '../components/Attachments';
import { useAgentName } from '../lib/agent';
import { chatKeys, useChatUi } from '../lib/context';
import { AccountPicker } from './AccountPicker';
import { OptionsPanel } from './OptionsPanel';

/** What each status reads as, in the design system's status colours. */
const TONE: Record<LiveMcpServer['status'], string> = { connected: 'ok', 'needs-auth': 'warn', failed: 'bad', pending: 'muted', disabled: 'muted', unknown: 'muted' };

/** How often the list is read again while a server is still connecting. */
const PENDING_POLL_MS = 2000;

export const mcpKey = (chatId: string) => [...chatKeys.chatScope(chatId), 'mcp'] as const;

/**
 * The "+" of the box: everything that goes into a message besides its words. Files to attach, the
 * commands and skills the CLI reported, and the MCP servers and the account's connectors the chat runs
 * with: switched on and off in the live process, or chosen for the next one.
 */
export function ComposerMenu({
  chat,
  live,
  files,
  disabled,
  hasCommands,
  onCommands,
  onChooseTools,
}: {
  chat: Chat;
  /** The chat's process is up: its servers can be read and switched now */
  live: boolean;
  files: AttachmentsState;
  disabled?: boolean;
  hasCommands: boolean;
  /** Starts a slash command in the box */
  onCommands: () => void;
  /** Opens the run options, where a resume or a fork chooses its preset and servers */
  onChooseTools: () => void;
}) {
  const { t } = useTranslation('chat');
  const agent = useAgentName();
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const close = (then: () => void) => {
    setOpen(false);
    then();
  };
  return (
    <>
      <OptionsPanel
        title={t('composerMenu.title')}
        open={open}
        onOpenChange={setOpen}
        trigger={
          <button type="button" className="icon-btn composer-plus" aria-label={t('composerMenu.open')} aria-expanded={open} disabled={disabled} onClick={() => setOpen(true)}>
            <Plus {...ICON_SM} />
          </button>
        }
      >
        <div className="composer-menu">
          <div className="composer-menu-actions">
            <button type="button" className="composer-menu-item" onClick={() => close(() => input.current?.click())} title={t('attachments.attachHint', { agent })}>
              <Paperclip {...ICON_SM} aria-hidden />
              <span>{t('attachments.attachFiles')}</span>
            </button>
            {hasCommands && (
              <button type="button" className="composer-menu-item" onClick={() => close(onCommands)}>
                <Slash {...ICON_SM} aria-hidden />
                <span>{t('composerMenu.commands')}</span>
              </button>
            )}
          </div>
          <AccountPicker chat={chat} />
          <section className="composer-menu-section" aria-labelledby={`servers-${chat.id}`}>
            <h3 id={`servers-${chat.id}`} className="section-label">
              {t('composerMenu.servers')}
            </h3>
            {live ? (
              <LiveServers chatId={chat.id} />
            ) : (
              <div className="composer-menu-note">
                <p className="small muted">{t('composerMenu.serversAtStart')}</p>
                <button type="button" className="btn btn-small" onClick={() => close(onChooseTools)}>
                  <SlidersHorizontal {...ICON_SM} aria-hidden /> {t('composerMenu.chooseServers')}
                </button>
              </div>
            )}
          </section>
        </div>
      </OptionsPanel>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          if (e.target.files) files.add(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}

/** The servers of the live process, each with a switch. */
function LiveServers({ chatId }: { chatId: string }) {
  const { t } = useTranslation('chat');
  const { client, paths } = useChatUi();
  const queryClient = useQueryClient();
  const key = mcpKey(chatId);
  const servers = useQuery({
    queryKey: key,
    queryFn: () => client.chatMcp(chatId),
    // Opening the menu is asking what the servers are now
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.servers.some((s) => s.status === 'pending') ? PENDING_POLL_MS : false),
  });
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => client.toggleChatMcp(chatId, name, enabled),
    onSuccess: (data) => queryClient.setQueryData(key, data),
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
                  {server.tools.length > 0 && <span className="muted mono">{t('composerMenu.tools', { count: server.tools.length })}</span>}
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
