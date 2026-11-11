import type { ClaudioReleaseInfo, ClaudioServer, ServersSettings } from '@claudio/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Server } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, Empty, ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { formatNumber } from '@claudio/ui/lib/format';
import { ApiRequestError } from '../api';
import { PageHeader } from '../components/PageHeader';
import { remoteUpdateApi, serversApi, serversKeys, useServers, useServersMutation, useServersSettings } from '../lib/api/servers';
import { useHubOnlyHidden, useServerScope } from '../lib/server-scope';
import { sortServers } from '../lib/servers-model';
import { AddServerDialog } from './servers/AddDialog';
import { ConnectCard, HubsCard } from './servers/Connect';
import { LocalNameCard } from './servers/LocalName';
import { EditServerDialog } from './servers/EditDialog';
import { PairAgainDialog } from './servers/PairAgainDialog';
import { ServerRow, type RowActions } from './servers/ServerRow';
import { TestServerDialog } from './servers/TestDialog';

type Open = { kind: 'add' } | { kind: 'edit'; server: ClaudioServer } | { kind: 'test'; server: ClaudioServer } | { kind: 'pair'; server: ClaudioServer } | null;

/**
 * Servers (docs/plans/claudio-servers.md §12.1): the other Claudios this one drives, and the way to
 * let another one drive this. Hub-only: inside a remote scope the page is not drawn (one hop, D7).
 * Off until the person turns it on, like Collaborators; the page's one gradient is Add a server
 * (Turn on Servers while it is off, which `Empty` draws as the state's own action).
 */
export function Servers() {
  const { t } = useTranslation('serversPage');
  const hidden = useHubOnlyHidden('/servers');
  const scope = useServerScope();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const settings = useServersSettings();
  const enabled = settings.data?.enabled === true;
  const list = useServers({ enabled });
  const turnOn = useServersMutation((on: boolean) => serversApi.setEnabled(on));

  // The selector's "Add a server" lands here with ?add=1, once, so a reload does not reopen it
  const addAsked = params.get('add') === '1' && enabled;
  const clearAdd = useCallback(() => {
    if (params.get('add') === null) return;
    const next = new URLSearchParams(params);
    next.delete('add');
    setParams(next, { replace: true });
  }, [params, setParams]);

  if (hidden) return <Navigate to="/" replace />;
  if (settings.isLoading) return <Skeleton rows={6} height={20} />;
  if (settings.error) return <ErrorBox error={settings.error} />;
  if (!settings.data) return null;

  return (
    <ServersView
      settings={settings.data}
      servers={list.data}
      serversError={list.error}
      busy={turnOn.isPending}
      addAsked={addAsked}
      onAddClosed={clearAdd}
      onTurnOn={() => turnOn.mutate(true, { onSuccess: () => toast.success(t('toast.on')), onError: (err) => toast.error(t('toast.onFailed'), err) })}
      onOpen={(server) => scope.switchTo(server.id).catch((err: unknown) => toast.error(t('toast.openFailed', { name: server.name }), err))}
    />
  );
}

/** The page from its data, so every state renders in a test without a server */
export function ServersView({
  settings,
  servers,
  serversError,
  busy,
  addAsked = false,
  onAddClosed = () => {},
  onTurnOn,
  onOpen,
}: {
  settings: ServersSettings;
  servers: readonly ClaudioServer[] | undefined;
  serversError?: unknown;
  busy: boolean;
  addAsked?: boolean;
  onAddClosed?: () => void;
  onTurnOn: () => void;
  onOpen: (server: ClaudioServer) => void;
}) {
  const { t } = useTranslation('serversPage');
  const toast = useToast();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<Open>(addAsked ? { kind: 'add' } : null);
  // A dialog refocuses whenever its onClose changes, so it gets the same function every render
  const close = useCallback(() => {
    setOpen(null);
    onAddClosed();
  }, [onAddClosed]);
  const remove = useServersMutation((vars: { server: ClaudioServer; force: boolean }) => serversApi.remove(vars.server.id, vars.force));
  const update = useServersMutation((server: ClaudioServer) => remoteUpdateApi.startDesktopUpdate(server.id));

  if (!settings.enabled) {
    return (
      <div className="stack servers-page">
        <PageHeader title={t('page.title')} />
        <Empty
          illustration="collaborators"
          size="lg"
          title={t('off.title')}
          action={
            <button type="button" className="btn btn-primary" onClick={onTurnOn} disabled={busy} data-testid="servers-turn-on">
              {t('off.turnOn')}
            </button>
          }
        >
          <span className="servers-empty-text">{t('off.body')}</span>
        </Empty>
      </div>
    );
  }

  const sorted = servers ? sortServers(servers) : [];

  // The token is given back on the remote first. If that fails the person decides: removing anyway
  // leaves a token there that may still work, which the second question says in so many words
  const removeServer = (server: ClaudioServer) => {
    void confirm({ title: t('remove.title', { name: server.name }), body: t('remove.body', { name: server.name }), confirmLabel: t('remove.confirm'), danger: true }).then((ok) => {
      if (!ok) return;
      const finish = (revoked: boolean) => (revoked ? toast.success(t('remove.done', { name: server.name })) : toast.info(t('remove.doneUnrevoked', { name: server.name })));
      remove.mutate(
        { server, force: false },
        {
          onSuccess: (result) => finish(result.revoked),
          onError: (err) => {
            if (!(err instanceof ApiRequestError) || err.code !== 'servers.revoke-failed') return toast.error(t('remove.failed', { name: server.name }), err);
            void confirm({ title: t('remove.forceTitle', { name: server.name }), body: t('remove.forceBody', { name: server.name }), confirmLabel: t('remove.forceConfirm'), danger: true }).then((again) => {
              if (again) remove.mutate({ server, force: true }, { onSuccess: (result) => finish(result.revoked), onError: (e) => toast.error(t('remove.failed', { name: server.name }), e) });
            });
          },
        },
      );
    });
  };

  const updateServer = (server: ClaudioServer, release: ClaudioReleaseInfo) => {
    void confirm({
      title: t('update.title', { name: server.name }),
      body: (
        <>
          <p>{t('update.body', { name: server.name })}</p>
          {release.latest && <p className="small muted tnum">{t('update.from', { from: release.current, to: release.latest })}</p>}
        </>
      ),
      confirmLabel: t('update.confirm'),
    }).then((ok) => {
      if (!ok) return;
      update.mutate(server, {
        onSuccess: () => {
          toast.success(t('update.started', { name: server.name }));
          void queryClient.invalidateQueries({ queryKey: serversKeys.update(server.id) });
        },
        onError: (err) => toast.error(t('update.failed', { name: server.name }), err),
      });
    });
  };

  const actions: RowActions = {
    onOpen: onOpen,
    onTest: (server) => setOpen({ kind: 'test', server }),
    onEdit: (server) => setOpen({ kind: 'edit', server }),
    onRemove: removeServer,
    onPairAgain: (server) => setOpen({ kind: 'pair', server }),
    onUpdate: updateServer,
  };
  const working = busy || remove.isPending || update.isPending;
  const subtitle = servers && servers.length > 0 ? t('page.subtitle', { count: servers.length, formatted: formatNumber(servers.length) }) : t('page.subtitleNone');

  return (
    <div className="stack servers-page">
      <PageHeader
        title={t('page.title')}
        subtitle={subtitle}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setOpen({ kind: 'add' })} data-testid="servers-add">
            <Plus {...ICON_SM} /> {t('page.add')}
          </button>
        }
      />

      <section className="servers-list" aria-label={t('page.list')}>
        {serversError ? <ErrorBox error={serversError} /> : null}
        {!servers && !serversError && <Skeleton rows={3} height={18} />}
        {servers && sorted.length === 0 && (
          <Card>
            <Empty
              icon={Server}
              title={t('none.title')}
              action={
                <button type="button" className="btn" onClick={() => setOpen({ kind: 'add' })} data-testid="servers-add-empty">
                  <Plus {...ICON_SM} /> {t('page.add')}
                </button>
              }
            >
              <span className="servers-empty-text">{t('none.body')}</span>
            </Empty>
          </Card>
        )}
        {sorted.length > 0 && (
          <Card className="servers-card">
            <ul className="server-rows" data-testid="server-rows">
              {sorted.map((server) => (
                <ServerRow key={server.id} server={server} busy={working} actions={actions} />
              ))}
            </ul>
          </Card>
        )}
      </section>

      <ConnectCard />
      <HubsCard />
      <LocalNameCard />

      {open?.kind === 'add' && <AddServerDialog servers={servers ?? []} onClose={close} onAdded={() => {}} />}
      {open?.kind === 'edit' && <EditServerDialog server={open.server} onClose={close} />}
      {open?.kind === 'test' && <TestServerDialog server={open.server} onClose={close} />}
      {open?.kind === 'pair' && <PairAgainDialog server={open.server} onClose={close} />}
    </div>
  );
}
