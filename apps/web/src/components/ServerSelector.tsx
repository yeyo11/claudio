import type { ClaudioServer } from '@claudio/shared';
import { ChevronDown, LayoutList, Plus, Server } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { MenuEntry } from '@claudio/ui/components/controls/Menu';
import { MoreActions } from '@claudio/ui/components/controls/MoreActions';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { LOCAL_SERVER_ID } from '@claudio/ui/lib/server-scope';
import { useServers, useServersOn } from '../lib/api/servers';
import { useServerScope } from '../lib/server-scope';
import { recentServers } from '../lib/servers-model';
import { ServerMark, ServerStatusWord } from './ServerMark';

/**
 * The server scope, the crumb's first root, before the project's (docs/plans/claudio-servers.md
 * §12.1). It looks and opens like the project selector: a quiet button, then This server pinned,
 * the three servers used last with their status in words, and the way to the page. A phone gets
 * the same list as a sheet.
 *
 * It exists only while the feature is on and only on the hub: inside a remote's scope nothing lists
 * that remote's own servers (one hop, plan D7), and a hub with the feature off draws nothing, so a
 * person who never turns it on sees no change.
 */
export function ServerSelector() {
  const on = useServersOn();
  const servers = useServers({ enabled: on });
  if (!on) return null;
  return <SelectorView servers={servers.data ?? []} />;
}

/** What the menu does besides drawing itself; the component fills them from the router and the scope */
export interface SelectorActions {
  /** A server was picked: not the one this page is on */
  switchTo: (serverId: string) => void;
  /** A way to a page of the app */
  go: (path: string) => void;
}

/**
 * The menu's entries (shared by the dropdown and the phone's sheet): This server pinned and chosen,
 * the recent servers after it, then the way to the page. With no server yet the way is "Add a
 * server", straight into the add dialog.
 */
export function selectorEntries(servers: readonly ClaudioServer[], t: TFunction<'shell'>, actions: SelectorActions): MenuEntry[] {
  return [
    {
      id: 'servers',
      label: t('servers.selector.label'),
      radio: {
        // The hub is the scope this page is in, so it is the one that is chosen
        value: LOCAL_SERVER_ID,
        onChange: actions.switchTo,
      },
      items: [
        {
          id: LOCAL_SERVER_ID,
          text: t('servers.local'),
          label: (
            <span className="server-item">
              <Server {...ICON_SM} className="server-local-icon" aria-hidden />
              {t('servers.local')}
            </span>
          ),
        },
        ...recentServers(servers).map((server) => ({
          id: server.id,
          text: server.name,
          label: (
            <span className="server-item">
              <ServerMark server={server} />
              <span className="server-item-name">{server.name}</span>
            </span>
          ),
          meta: <ServerStatusWord server={server} />,
        })),
      ],
    },
    { id: 'sep', separator: true },
    servers.length === 0
      ? { id: 'add', label: t('servers.selector.add'), icon: Plus, onSelect: () => actions.go('/servers?add=1') }
      : { id: 'all', label: t('servers.selector.all'), icon: LayoutList, onSelect: () => actions.go('/servers') },
  ];
}

/** The selector for a list of servers; a test draws it without the queries */
export function SelectorView({ servers }: { servers: readonly ClaudioServer[] }) {
  const { t } = useTranslation('shell');
  const navigate = useNavigate();
  const toast = useToast();
  const { switchTo } = useServerScope();
  const entries = selectorEntries(servers, t, {
    // The hub refuses a server removed meanwhile or the feature just turned off: say so and stay
    switchTo: (id) => void switchTo(id).catch((error: unknown) => toast.error(t('servers.selector.switchFailed'), error)),
    go: navigate,
  });

  return (
    <>
      <span className="project-scope server-scope">
        <MoreActions
          entries={entries}
          label={t('servers.selector.label')}
          align="start"
          trigger={
            <button type="button" className="select-trigger project-selector server-selector" aria-label={`${t('servers.selector.label')}: ${t('servers.local')}`}>
              <span className="select-value server-selector-value">
                <Server {...ICON_SM} className="server-local-icon" aria-hidden />
                <span className="server-selector-name">{t('servers.local')}</span>
              </span>
              <ChevronDown {...ICON_SM} className="select-chevron" aria-hidden />
            </button>
          }
        />
      </span>
      <span className="crumb-sep" aria-hidden>
        /
      </span>
    </>
  );
}
