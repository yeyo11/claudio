import type { ClaudioServer } from '@claudio/shared';
import { ChevronDown, LayoutList, Plus, Server } from 'lucide-react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { MenuEntry } from '@claudio/ui/components/controls/Menu';
import { MoreActions } from '@claudio/ui/components/controls/MoreActions';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { activeServerId, LOCAL_SERVER_ID } from '@claudio/ui/lib/server-scope';
import { useServers, useServersFeatureOn } from '../lib/api/servers';
import { useServerScope } from '../lib/server-scope';
import { RECENT_SERVERS, recentServers } from '../lib/servers-model';
import { ServerMark, ServerStatusWord } from './ServerMark';

/**
 * The server scope, the crumb's first root, before the project's (docs/plans/claudio-servers.md
 * §12.1). It looks and opens like the project selector: a quiet button with the current server, then
 * This server pinned, the three servers used last with their status in words, and the way to the
 * page. A phone gets the same list as a sheet.
 *
 * It exists only while the hub has the feature on, and it is the hub's in either scope: inside a
 * remote it names that remote (on a phone, with no status bar, the button is what says which server
 * the page writes to) and switches from it, but the list is always the hub's own. A remote's own
 * servers are never listed (one hop, plan D7), and a hub with the feature off draws nothing, so a
 * person who never turns it on sees no change.
 */
export function ServerSelector() {
  const on = useServersFeatureOn();
  const servers = useServers({ enabled: on });
  if (!on) return null;
  return <SelectorView servers={servers.data ?? []} current={activeServerId()} />;
}

/** What the menu does besides drawing itself; the component fills them from the router and the scope */
export interface SelectorActions {
  /** A server was picked: not the one this page is on */
  switchTo: (serverId: string) => void;
  /** A way to a page of the app */
  go: (path: string) => void;
}

/**
 * The menu's entries (shared by the dropdown and the phone's sheet): This server pinned, the recent
 * servers after it, the one in use chosen, then the way to the page. With no server yet the way is
 * "Add a server", straight into the add dialog.
 */
export function selectorEntries(servers: readonly ClaudioServer[], t: TFunction<'shell'>, actions: SelectorActions, current: string = LOCAL_SERVER_ID): MenuEntry[] {
  // The server in use is listed even when three others were used after it (a reading of the hub's
  // list from before this visit), so the chosen one is always in the menu
  const recent = recentServers(servers);
  const inUse = servers.find((server) => server.id === current);
  const listed = inUse && !recent.includes(inUse) ? [inUse, ...recent.slice(0, RECENT_SERVERS - 1)] : recent;
  return [
    {
      id: 'servers',
      label: t('servers.selector.label'),
      radio: {
        // The scope this page is in is the one chosen; choosing it again reloads nothing
        value: current,
        onChange: (id) => {
          if (id !== current) actions.switchTo(id);
        },
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
        ...listed.map((server) => ({
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

/** The selector for a list of servers and the scope the page is in; a test draws it without the queries */
export function SelectorView({ servers, current = LOCAL_SERVER_ID }: { servers: readonly ClaudioServer[]; current?: string }) {
  const { t } = useTranslation('shell');
  const navigate = useNavigate();
  const toast = useToast();
  const { switchTo } = useServerScope();
  const entries = selectorEntries(
    servers,
    t,
    {
      // The hub refuses a server removed meanwhile or the feature just turned off: say so and stay
      switchTo: (id) => void switchTo(id).catch((error: unknown) => toast.error(t('servers.selector.switchFailed'), error)),
      // Inside a remote the router's paths are the remote's: the hub's own page is a full load away
      go: current === LOCAL_SERVER_ID ? navigate : (path) => window.location.assign(path),
    },
    current,
  );
  const remote = current === LOCAL_SERVER_ID ? null : (servers.find((server) => server.id === current) ?? null);
  // A remote the hub's list has not answered for yet is still not "This server": the button names nobody until it has
  const name = remote ? remote.name : current === LOCAL_SERVER_ID ? t('servers.local') : '';

  return (
    <>
      <span className="project-scope server-scope">
        <MoreActions
          entries={entries}
          label={t('servers.selector.label')}
          align="start"
          trigger={
            <button type="button" className="select-trigger project-selector server-selector" aria-label={`${t('servers.selector.label')}: ${name}`}>
              <span className="select-value server-selector-value">
                {remote ? <ServerMark server={remote} /> : <Server {...ICON_SM} className="server-local-icon" aria-hidden />}
                <span className="server-selector-name">{name}</span>
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
