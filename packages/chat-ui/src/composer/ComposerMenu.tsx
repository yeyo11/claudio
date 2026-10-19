import type { Chat } from '@claudio/shared';
import { Paperclip, Plug, Plus, Slash } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MenuEntry } from '@claudio/ui/components/controls/Menu';
import { MoreActions } from '@claudio/ui/components/controls/MoreActions';
import { Sheet } from '@claudio/ui/components/controls/Sheet';
import type { AttachmentsState } from '../components/Attachments';
import { accountItem, useLooseT } from './account-menu';
import { AccountPicker, useChatAccounts } from './AccountPicker';
import { mcpKey, serversOn, ServersPanel, useLiveServers } from './ServersPanel';

export { mcpKey };

/** Which panel the menu opened beside itself on a desktop; a phone shows them as steps of its sheet. */
type Panel = 'servers' | 'accounts';

/**
 * The "+" of the box: everything that goes into a message besides its words, as a real menu in
 * three groups. Add (files to attach, the commands and skills the CLI reported), Account (the chat's
 * own, and the choice of another one) and Servers (the MCP servers and the account's connectors the
 * chat runs with, switched on and off in the live process or chosen for the next one). The
 * account's choices are a submenu, or a picker beyond a handful; the servers are a panel, because
 * live switches do not belong inside a menu.
 */
export function ComposerMenu({
  chat,
  live,
  files,
  disabled,
  hasCommands,
  onCommands,
  onChooseTools,
  requestServers,
  onServersRequested,
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
  /** Set by the options popover to open the Servers panel from outside, as choosing the menu's row does */
  requestServers?: boolean;
  /** The request was taken: the owner clears it */
  onServersRequested?: () => void;
}) {
  const { t } = useTranslation('chat');
  const input = useRef<HTMLInputElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const accounts = useChatAccounts(chat, accountsOpen || panel === 'accounts');
  const servers = useLiveServers(chat.id, live && (menuOpen || panel === 'servers'));
  const count = serversOn(servers.data?.servers);

  // The menu closes itself on a choice; the panel opens after it has handed the focus back
  const openPanel = (next: Panel) => setTimeout(() => setPanel(next), 0);
  const tr = useLooseT();
  useEffect(() => {
    if (!requestServers) return;
    setPanel('servers');
    onServersRequested?.();
  }, [requestServers, onServersRequested]);

  const account = accountItem({
    rows: accounts.rows,
    model: chat.model,
    pending: accounts.pending,
    t: tr,
    onChoose: (id) => accounts.choose(id),
    onCancel: () => {
      const current = accounts.rows.find((row) => row.state === 'current');
      if (current) accounts.choose(current.account.id);
    },
    onOpenChange: setAccountsOpen,
    onPicker: () => openPanel('accounts'),
    picker: ({ close }) => <AccountPicker chat={chat} state={accounts} onDone={close} />,
  });

  const entries: MenuEntry[] = [
    {
      id: 'add',
      label: t('composerMenu.groups.add'),
      items: [
        { id: 'attach', icon: Paperclip, label: t('attachments.attachFiles'), onSelect: () => input.current?.click() },
        { id: 'commands', icon: Slash, label: t('composerMenu.commands'), text: t('composerMenu.commands'), disabled: !hasCommands, disabledReason: t('composerMenu.noCommands'), onSelect: onCommands },
      ],
    },
    ...(account ? [{ id: 'account', label: t('composerMenu.groups.account'), items: [account] }] : []),
    {
      id: 'servers',
      label: t('composerMenu.groups.servers'),
      items: [
        {
          id: 'servers',
          icon: Plug,
          text: t('composerMenu.servers'),
          label: count ? `${t('composerMenu.servers')} · ${t('composerMenu.serversOn', { on: count.on, total: count.total })}` : t('composerMenu.servers'),
          meta: live ? undefined : t('composerMenu.serversAtStartShort'),
          onSelect: () => openPanel('servers'),
          detail: ({ close }) => <ServersPanel chat={chat} live={live} onChooseTools={onChooseTools} onDone={close} />,
        },
      ],
    },
  ];

  return (
    <>
      <MoreActions
        entries={entries}
        label={t('composerMenu.open')}
        title={t('composerMenu.title')}
        backLabel={t('composerMenu.back')}
        icon={Plus}
        className="composer-plus"
        side="top"
        align="start"
        disabled={disabled}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) accounts.refresh();
        }}
      />
      <Sheet
        open={panel !== null}
        onOpenChange={(open) => {
          if (!open) setPanel(null);
        }}
        title={panel === 'accounts' ? t('composerMenu.account.title') : t('composerMenu.servers')}
        side="auto"
      >
        {panel === 'servers' && <ServersPanel chat={chat} live={live} onChooseTools={onChooseTools} onDone={() => setPanel(null)} />}
        {panel === 'accounts' && <AccountPicker chat={chat} state={accounts} onDone={() => setPanel(null)} />}
      </Sheet>
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
