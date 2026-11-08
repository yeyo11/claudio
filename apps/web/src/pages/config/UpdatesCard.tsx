import type { ClaudioReleaseInfo, DesktopUpdateStatus, LiveWork, RestartRequest, RestartResult, ServerUpdateApplyRequest, ServerUpdateStatus, StorageKind, StorageLocation } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, ExternalLink, Info, RotateCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { reachability } from '../../lib/reachability';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { CopyButton, ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import type { DesktopUpdatesBridge } from '../../lib/desktop';
import { formatDate, formatPercent, timeAgo } from '@claudio/ui/lib/format';
import {
  canRetryUpdate,
  DOCKER_REPLACE_COMMAND,
  DOCKER_RUN_COMMAND,
  DOCKER_UPDATE_WAYS,
  desktopUnitErrorCode,
  dismissedRollback,
  dismissRollback,
  liveWorkOf,
  parseInstallAnswer,
  parseSwitchState,
  parseUpdateState,
  payloadActionsVia,
  payloadHasPrimary,
  refusalStatus,
  REMOVE_DEB_COMMAND,
  serverUpdateRefetchMs,
  SOURCE_UPDATE_COMMAND,
  updateErrorCode,
  updateRoute,
  type DesktopUpdateState,
  type PayloadActions,
  type SwitchState,
  type UpdateHow,
} from '../../lib/updates';
import { PrefRow, ReservedLabel } from './PrefRow';

const apiActions: PayloadActions = {
  download: () => api.downloadServerUpdate(),
  apply: (body) => api.applyServerUpdate(body),
  revert: (body) => api.revertServerUpdate(body),
  cancel: () => api.cancelServerUpdate(),
};

/**
 * Which Claudio this is and whether a newer release is out, with the way to take it that fits this
 * install. Two zones in the desktop app: Claudio (the payload, which most releases change and which
 * installs without a password) and the Desktop app (the shell). Reading is free: GitHub is only
 * asked by the button and once a day by the server.
 */
export function UpdatesCard() {
  const { t } = useTranslation('config');
  const { t: tProviders } = useTranslation('providers');
  const queryClient = useQueryClient();
  const { data: info, error, isLoading } = useQuery({ queryKey: keys.release, queryFn: () => api.release() });
  const check = useMutation({
    mutationFn: api.checkRelease,
    onSuccess: (fresh) => queryClient.setQueryData(keys.release, fresh),
  });
  const bridge = typeof window !== 'undefined' ? window.claudioDesktop?.updates : undefined;
  const route = info && updateRoute({ distribution: info.distribution, desktopUpdates: Boolean(bridge), hostname: window.location.hostname });
  // Claudio may update itself in a container and under a desktop server, whether this page is the
  // desktop window or a browser or phone reaching it; where it cannot, the status says why and the steps stay
  const desktopServer = info?.distribution === 'appimage' || info?.distribution === 'deb';
  const asksServer = Boolean(bridge) || info?.distribution === 'docker' || desktopServer;
  const server = useQuery({
    queryKey: keys.serverUpdate,
    queryFn: ({ signal }) => api.serverUpdate({ signal }),
    enabled: asksServer,
    refetchInterval: (query) => serverUpdateRefetchMs(query.state.data),
    // Mid-restart the API is down for a moment: keep what was shown instead of an error
    retry: false,
  });
  const status = asksServer ? server.data : undefined;
  // The desktop app's own update unit (a `.deb`), reachable from any device that reaches the server. The
  // AppImage in its own window updates through the shell, so only a page elsewhere asks about it
  const asksUnit = info?.distribution === 'deb' || (!bridge && info?.distribution === 'appimage');
  // A restart asked for from this card, kept to say it is scheduled until the new process reports itself
  const [restartAsked, setRestartAsked] = useState<RestartResult['scheduled'] | null>(null);
  const unit = useQuery({
    queryKey: keys.desktopUpdate,
    queryFn: ({ signal }) => api.desktopUpdate({ signal }),
    enabled: asksUnit,
    // One read on mount: `desktop-update.changed` (events.ts) refetches it when the unit or a restart moves it
    // Mid-restart the API is down for a moment: keep what was shown instead of an error
    retry: false,
  });
  const unitStatus = asksUnit ? unit.data : undefined;
  // An AppImage has no unit and is told nothing about it; a `.deb` without one is told how to get it
  const showUnit = unitStatus !== undefined && !(unitStatus.state === 'unavailable' && info?.distribution === 'appimage');
  // Where the unit works, the shell's apt-managed and shell-replaced notes would say the same twice, with a second Restart
  const unitActive = unitStatus !== undefined && unitStatus.state !== 'unavailable';

  const facts = info && (
    <span className="update-facts">
      <span>
        {t('updates.version')} <span className="tnum">{status?.running ?? info.current}</span>
        {status && status.image !== status.running && (
          <> · {status.base === 'shell' ? t('updates.shellVersion', { shell: status.shell?.version ?? status.image }) : t('updates.imageVersion', { image: status.image })}</>
        )}
      </span>
      <span>
        {t('updates.latest')} <span className="tnum">{info.latest ?? t('updates.never')}</span>
        {info.publishedAt && <> · {t('updates.published', { date: formatDate(info.publishedAt) })}</>}
      </span>
      {info.latest && (info.updateAvailable ? <Tag tone="warn">{t('updates.availableTag')}</Tag> : <Tag tone="ok">{t('updates.upToDateTag')}</Tag>)}
      {info.url && (
        <a href={info.url} target="_blank" rel="noopener noreferrer" className="meta-icon">
          {t('updates.notes')} <ExternalLink {...ICON_SM} />
          <span className="sr-only"> ({tProviders('row.opensNewTab')})</span>
        </a>
      )}
    </span>
  );

  // A shell that cannot act for the page (an older one) leaves the Claudio zone to read-only facts
  const desktopActions = bridge?.payload ? payloadActionsVia(bridge.payload) : null;
  // Under auth `none` the page's own read says `needs-auth`, but the shell's requests are accepted (D8), as its menu reads it
  const shellStatus = status?.unsupportedReason === 'needs-auth' && desktopActions ? { ...status, unsupportedReason: null } : status;

  return (
    <div className="stack update-zone" data-testid="updates-card">
      <PrefRow id="updates-claudio" setting="updates.claudio" title={t('updates.title')} hint={isLoading ? <Skeleton rows={1} /> : facts}>
        <div className="pref-actions">
          <button className="btn" disabled={check.isPending} onClick={() => check.mutate()}>
            <ReservedLabel states={[t('updates.check'), t('updates.checking')]} shown={check.isPending ? 1 : 0} />
          </button>
          {/* Always rendered so a screen reader is told when the answer lands */}
          <span className="small muted" role="status">
            {info?.checkedAt && t('updates.checked', { when: timeAgo(info.checkedAt) })}
          </span>
        </div>
      </PrefRow>
      <ErrorBox error={error} />
      <ErrorBox title={t('updates.checkFailed')} error={check.error ?? (info?.error ? new Error(info.error) : null)} />

      {info?.distribution === 'docker' && <StorageWarning />}
      {info && route?.kind === 'desktop' && bridge && (
        <>
          {shellStatus && desktopActions && <ServerUpdate status={shellStatus} info={info} actions={desktopActions} steps={null} />}
          <DesktopUpdate bridge={bridge} info={info} primary={!payloadHasPrimary(desktopActions ? shellStatus : undefined, info.updateAvailable)} unitActive={unitActive} />
          {showUnit && unitStatus && (
            <DesktopUnitUpdate status={unitStatus} info={info} titled={false} primary={!payloadHasPrimary(desktopActions ? shellStatus : undefined, info.updateAvailable)} restartAsked={restartAsked} onRestartAsked={setRestartAsked} />
          )}
        </>
      )}
      {info && route?.kind === 'steps' && status && (
        <>
          <ServerUpdate
            status={status}
            info={info}
            actions={apiActions}
            steps={desktopServer ? null : info.updateAvailable || status.needsImage ? <UpdateSteps how={route.how} remote={route.remote} /> : null}
          />
          {desktopServer && showUnit && unitStatus && (
            <DesktopUnitUpdate
              status={unitStatus}
              info={info}
              titled
              primary={!payloadHasPrimary(status, info.updateAvailable)}
              restartAsked={restartAsked}
              onRestartAsked={setRestartAsked}
            />
          )}
        </>
      )}
      {info?.updateAvailable && route?.kind === 'steps' && !status && <UpdateSteps how={route.how} remote={route.remote} />}
    </div>
  );
}

/** The command to run, with a button that copies it */
function Command({ command }: { command: string }) {
  const { t } = useTranslation('config');
  return (
    <div className="update-command">
      <code className="mono">{command}</code>
      <CopyButton text={command} label={t('updates.copyCommand')} />
    </div>
  );
}

/**
 * A container whose folders are not on a volume with a name loses them when it is replaced, which is
 * what an update is. Said as soon as it is known, before anyone presses a command: after is too late.
 */
function StorageWarning() {
  const { t } = useTranslation('config');
  const { data } = useQuery({ queryKey: keys.storage, queryFn: () => api.storage() });
  if (!data?.atRisk) return null;
  const lost = data.locations.filter((location): location is StorageLocation & { kind: Exclude<StorageKind, 'persistent' | 'unknown'> } => location.kind !== 'persistent' && location.kind !== 'unknown');
  return (
    <div className="alert alert-warn" role="alert" data-testid="storage-warning">
      <AlertTriangle className="alert-icon" {...ICON_SM} />
      <div className="alert-body stack">
        <strong>{t('updates.storage.title')}</strong>
        <span className="small">{t('updates.storage.body')}</span>
        <ul className="small">
          {lost.map((location) => (
            <li key={location.id}>
              {t(`updates.storage.${location.id}`)} <code className="mono">{location.path}</code> · {t(`updates.storage.kind.${location.kind}`)}
            </li>
          ))}
        </ul>
        <span className="small">{t('updates.storage.fix')}</span>
        <Command command={DOCKER_RUN_COMMAND} />
        <span className="small">{t('updates.storage.move')}</span>
      </div>
    </div>
  );
}

/** Everywhere but the desktop window: what to run, and who runs it */
function UpdateSteps({ how, remote }: { how: UpdateHow; remote: boolean }) {
  const { t } = useTranslation('config');
  return (
    <div className="stack" data-testid={`update-steps-${how}`}>
      {remote && (
        <p className="alert small">
          <Info className="alert-icon" {...ICON_SM} />
          <span className="alert-body">{t('updates.remote', { host: window.location.host })}</span>
        </p>
      )}
      {how === 'docker' && (
        <>
          <p className="small">{t('updates.docker.intro')}</p>
          {DOCKER_UPDATE_WAYS.map(({ way, command }) => (
            <div key={way} className="stack" data-testid={`update-docker-${way}`}>
              <p className="small">{t(`updates.docker.${way}`)}</p>
              <Command command={command} />
              {way === 'run' && (
                <>
                  <p className="small">{t('updates.docker.replace')}</p>
                  <Command command={DOCKER_REPLACE_COMMAND} />
                </>
              )}
            </div>
          ))}
          <p className="small">{t('updates.docker.helm')}</p>
        </>
      )}
      {how === 'source' && (
        <>
          <p className="small">{t('updates.source')}</p>
          <Command command={SOURCE_UPDATE_COMMAND} />
        </>
      )}
      {how === 'desktop-app' && <p className="small">{remote ? t('updates.desktopAppRemote') : t('updates.desktopApp')}</p>}
    </div>
  );
}

/** The shell's updater state, kept current through its events */
function useDesktopUpdateState(bridge: DesktopUpdatesBridge): DesktopUpdateState | null {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    let alive = true;
    const unsubscribe = bridge.onState((raw) => {
      const next = parseUpdateState(raw);
      if (next) setState(next);
    });
    void bridge.state().then((raw) => {
      const next = parseUpdateState(raw);
      if (alive && next) setState((current) => current ?? next);
    });
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);
  return state;
}

/** Whether the `.deb` can become the AppImage here; null until the shell answers, or from a shell with no switch */
function useSwitchState(bridge: DesktopUpdatesBridge): SwitchState | null {
  const [state, setState] = useState<SwitchState | null>(null);
  useEffect(() => {
    let alive = true;
    void bridge
      .switchState?.()
      .then((raw) => {
        if (alive) setState(parseSwitchState(raw));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [bridge]);
  return state;
}

/** "2 chats are working, 1 orchestration is running": what a restart now would stop */
function useLiveSentence(): (live: LiveWork) => string {
  const { t } = useTranslation('config');
  return (live) =>
    [
      live.working ? t('updates.live.working', { count: live.working }) : null,
      live.waiting ? t('updates.live.waiting', { count: live.waiting }) : null,
      live.running ? t('updates.live.running', { count: live.running }) : null,
      live.terminals ? t('updates.live.terminals', { count: live.terminals }) : null,
    ]
      .filter(Boolean)
      .join(', ');
}


/**
 * The Desktop app zone: the shell's own update. Download with its progress and a restart that asks
 * first when work is live (AppImage); a line for the system's updates (`.deb` with the apt source); the
 * command to copy (a `.deb` without it); the restart that finishes what apt installed. It never
 * installs anything that needs a password.
 */
function DesktopUpdate({ bridge, info, primary, unitActive }: { bridge: DesktopUpdatesBridge; info: ClaudioReleaseInfo; primary: boolean; unitActive: boolean }) {
  const { t } = useTranslation('config');
  const state = useDesktopUpdateState(bridge);
  const switchState = useSwitchState(bridge);
  const liveSentence = useLiveSentence();
  const [busy, setBusy] = useState<{ version: string; live: LiveWork; switching: boolean } | null>(null);
  const [scheduled, setScheduled] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [switching, setSwitching] = useState(false);
  const shellVersion = window.claudioDesktop?.version ?? info.current;

  const download = useMutation({ mutationFn: () => bridge.download(), onError: setFailure });
  const install = useMutation({
    mutationFn: async (options: { whenIdle?: boolean; force?: boolean }) => parseInstallAnswer(await bridge.install(options)),
    onSuccess: (answer) => {
      setBusy(null);
      if (answer?.status === 'busy') setBusy({ version: answer.version, live: answer.live, switching: false });
      else if (answer?.status === 'scheduled') setScheduled(answer.version);
    },
    onError: (err) => {
      setBusy(null);
      setFailure(err);
    },
  });
  const switchToAppImage = useMutation({
    mutationFn: async (options: { force?: boolean }) => parseInstallAnswer(await bridge.switchToAppImage?.(options)),
    onSuccess: (answer) => {
      setBusy(null);
      if (answer?.status === 'busy') {
        setSwitching(false);
        setBusy({ version: answer.version, live: answer.live, switching: true });
      }
    },
    onError: (err) => {
      setBusy(null);
      setSwitching(false);
      setFailure(err);
    },
  });

  if (!state) return null;

  const action = (label: ReactNode, icon: ReactNode, onClick: () => void, pending: boolean) => (
    <div>
      <button type="button" className={primary ? 'btn btn-primary' : 'btn'} disabled={pending} onClick={onClick}>
        {icon} {label}
      </button>
    </div>
  );
  const tag =
    state.status === 'idle' ? (
      <Tag tone="ok">{t('updates.upToDateTag')}</Tag>
    ) : state.status === 'available' || state.status === 'downloading' || state.status === 'verifying' || state.status === 'ready' ? (
      <Tag tone="warn">{t('updates.availableTag')}</Tag>
    ) : state.status === 'shell-replaced' && !unitActive ? (
      <Tag tone="idle">{t('updates.installedTag')}</Tag>
    ) : null;

  return (
    <div className="stack" data-testid="update-desktop" data-state={state.status}>
      <div className="update-facts">
        <span className="pref-row-title">{t('updates.desktopTitle')}</span>
        <span>
          {t('updates.version')} <span className="tnum">{shellVersion}</span>
        </span>
        {tag}
      </div>

      {state.status === 'unsupported' && (
        <p className="alert alert-warn small" role="status">
          <Info className="alert-icon" {...ICON_SM} />
          <span className="alert-body">
            {state.reason === 'development'
              ? t('updates.unsupported.development')
              : state.reason === 'read-only'
                ? t('updates.shellUnsupported.read-only')
                : state.reason === 'unknown-package'
                  ? t('updates.shellUnsupported.unknown-package')
                  : t('updates.shellUnsupported.other')}{' '}
            {info.url && (
              <a href={info.url} target="_blank" rel="noopener noreferrer">
                {t('updates.desktopManual')}
              </a>
            )}
          </span>
        </p>
      )}

      {state.status === 'available' && (
        <>
          <p className="small">{t('updates.desktopAvailable', { version: state.version })}</p>
          {action(t('updates.downloadDesktop', { version: state.version }), <Download {...ICON} />, () => download.mutate(), download.isPending)}
        </>
      )}

      {state.status === 'error' && (
        <div className="alert alert-bad" role="alert" data-testid="update-desktop-failed">
          <AlertTriangle className="alert-icon" {...ICON_SM} />
          <div className="alert-body stack">
            <span>{state.code === 'bad-signature' ? t('updates.errors.bad-signature') : t('updates.desktopFailed')}</span>
            <div>
              <button type="button" className="btn btn-small" disabled={download.isPending} onClick={() => download.mutate()}>
                {t('updates.tryAgain')}
              </button>
            </div>
          </div>
        </div>
      )}

      {state.status === 'checking' && (
        <p className="small muted" role="status">
          {t('updates.looking')}
        </p>
      )}

      {state.status === 'downloading' && (
        <div className="stack">
          <p className="small" role="status">
            {t('updates.downloadingShell', { version: state.version, percent: formatPercent(state.percent) })}
          </p>
          <span
            className="progress"
            role="progressbar"
            aria-label={t('updates.downloadShellProgress', { version: state.version })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state.percent}
          >
            <span className="progress-seg is-running" style={{ width: `${state.percent}%` }} aria-hidden />
          </span>
        </div>
      )}

      {state.status === 'verifying' && (
        <p className="small" role="status">
          <Spinner /> {t('updates.verifying')}
        </p>
      )}

      {state.status === 'ready' &&
        (scheduled === state.version ? (
          <p className="small" role="status">
            {t('updates.scheduled', { version: state.version })}
          </p>
        ) : (
          action(t('updates.restart', { version: state.version }), <RotateCw {...ICON} />, () => install.mutate({}), install.isPending)
        ))}

      {state.status === 'apt-managed' && !unitActive && (
        <div className="stack">
          <p className="small">{t('updates.aptManaged')}</p>
          {state.latest && <p className="small muted">{t('updates.aptLatest', { version: state.latest })}</p>}
        </div>
      )}

      {state.status === 'copy-command' && (
        <div className="stack" data-testid="update-copy-command">
          <p className="small">{t('updates.copyIntro')}</p>
          <Command command={state.command} />
          <p className="small muted">{t('updates.copyAfter')}</p>
        </div>
      )}

      {state.status === 'shell-replaced' && !unitActive && (
        <div className="stack">
          <p className="small" role="status">
            {t('updates.shellReplaced', { version: state.version })}
          </p>
          {action(t('updates.restartClaudio'), <RotateCw {...ICON} />, () => install.mutate({}), install.isPending)}
        </div>
      )}

      {failure !== null && failure !== undefined && <UpdateFailure code={updateErrorCode(failure)} retry={null} pending={false} testId="update-desktop-refused" />}

      {switchState?.available && (
        <div>
          <button type="button" className="btn btn-small" onClick={() => setSwitching(true)}>
            {t('updates.switchLink')}
          </button>
        </div>
      )}
      {switchState?.debStillInstalled && (
        <div className="stack" data-testid="update-deb-still">
          <p className="small">{t('updates.debStillInstalled')}</p>
          <Command command={REMOVE_DEB_COMMAND} />
        </div>
      )}

      {switching && (
        <Dialog
          title={t('updates.switchTitle')}
          onClose={() => setSwitching(false)}
          width={460}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setSwitching(false)}>
                {t('updates.cancel')}
              </button>
              <button type="button" className="btn btn-primary" data-autofocus disabled={switchToAppImage.isPending} onClick={() => switchToAppImage.mutate({ force: false })}>
                {t('updates.switchConfirm')}
              </button>
            </>
          }
        >
          <p>{t('updates.switchBody')}</p>
        </Dialog>
      )}

      {busy && (
        <Dialog
          title={busy.switching ? t('updates.switchTitle') : t('updates.busyTitle', { version: busy.version })}
          onClose={() => setBusy(null)}
          width={460}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setBusy(null)}>
                {t('updates.cancel')}
              </button>
              {!busy.switching && (
                <button type="button" className="btn" data-autofocus disabled={install.isPending} onClick={() => install.mutate({ whenIdle: true })}>
                  {t('updates.whenQuit')}
                </button>
              )}
              <button
                type="button"
                className="btn btn-danger-solid"
                disabled={install.isPending || switchToAppImage.isPending}
                onClick={() => (busy.switching ? switchToAppImage.mutate({ force: true }) : install.mutate({ force: true }))}
              >
                {busy.switching ? t('updates.switchConfirm') : t('updates.restartNow')}
              </button>
            </>
          }
        >
          <p>{busy.switching ? t('updates.switchBusyBody', { live: liveSentence(busy.live) }) : t('updates.busyBody', { live: liveSentence(busy.live) })}</p>
        </Dialog>
      )}
    </div>
  );
}

/**
 * The desktop app's update from any device (docs/plans/remote-updates.md): the server starts its root
 * update unit and reports `DesktopUpdateStatus`, and the restart it asks for finishes the upgrade. The
 * card holds no password and no credential of its own, so a phone does exactly what the desktop window does.
 */
function DesktopUnitUpdate({
  status,
  info,
  titled,
  primary,
  restartAsked,
  onRestartAsked,
}: {
  status: DesktopUpdateStatus;
  info: ClaudioReleaseInfo;
  /** The browser and the phone have no other heading for the zone; the desktop window has the shell's */
  titled: boolean;
  primary: boolean;
  restartAsked: RestartResult['scheduled'] | null;
  onRestartAsked: (asked: RestartResult['scheduled'] | null) => void;
}) {
  const queryClient = useQueryClient();
  const liveSentence = useLiveSentence();
  // Open with `live: null` it is the confirmation; with the counts of a 409 it asks to wait for idleness instead
  const [dialog, setDialog] = useState<{ live: LiveWork | null } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [restartFailure, setRestartFailure] = useState<unknown>(null);

  const start = useMutation({
    mutationFn: () => api.startDesktopUpdate(),
    onMutate: () => setFailure(null),
    onError: setFailure,
    // A refusal because one already runs is answered by reading the status again, as is a start
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.desktopUpdate }),
  });
  const restart = useMutation({
    mutationFn: (body: RestartRequest) => api.restartDesktop(body),
    onMutate: () => setRestartFailure(null),
    onSuccess: (result, body) => {
      setDialog(null);
      const scheduled = result?.scheduled ?? (body.whenIdle ? 'when-idle' : 'now');
      onRestartAsked(scheduled);
      // Only a restart that starts now takes the server down while the person is looking; a scheduled one waits for idleness
      if (scheduled === 'now') reachability.expectRestart();
    },
    onError: (error) => {
      const live = liveWorkOf(error);
      if (live) setDialog({ live });
      else {
        setDialog(null);
        setRestartFailure(error);
      }
    },
  });

  // The new process answers with `installed === running`: what was asked is done
  useEffect(() => {
    if (!status.restartNeeded && restartAsked) onRestartAsked(null);
  }, [status.restartNeeded, restartAsked, onRestartAsked]);

  return (
    <DesktopUnitView
      status={status}
      titled={titled}
      primary={primary}
      updateAvailable={info.updateAvailable}
      releaseUrl={info.url ?? null}
      pending={start.isPending || restart.isPending}
      failure={failure}
      restartFailure={restartFailure}
      restartAsked={restartAsked}
      dialog={dialog}
      liveSentence={liveSentence}
      onUpdate={() => start.mutate()}
      onAskRestart={() => {
        setRestartFailure(null);
        setDialog({ live: null });
      }}
      onRestart={(options) => restart.mutate(options)}
      onCloseDialog={() => setDialog(null)}
    />
  );
}

export interface DesktopUnitViewProps {
  status: DesktopUpdateStatus;
  titled: boolean;
  /** Whether this zone may carry the card's one primary action; the Claudio zone above takes it when it has an action of its own */
  primary: boolean;
  /** A newer Claudio is out: only then is Update the step worth a primary, otherwise it is a plain button */
  updateAvailable: boolean;
  releaseUrl: string | null;
  pending: boolean;
  /** What the refused start threw */
  failure: unknown;
  /** What the refused restart threw (a 409 for live work opens the dialog instead) */
  restartFailure: unknown;
  restartAsked: RestartResult['scheduled'] | null;
  dialog: { live: LiveWork | null } | null;
  liveSentence: (live: LiveWork) => string;
  onUpdate: () => void;
  onAskRestart: () => void;
  onRestart: (options: RestartRequest) => void;
  onCloseDialog: () => void;
}

/** A refusal or a failure of the unit in words from its code, never from the server's text */
function UnitNotice({ code, tone, testId }: { code: string | null; tone: 'bad' | 'warn'; testId: string }) {
  const { t } = useTranslation('config');
  const known = desktopUnitErrorCode(code);
  return (
    <div className={tone === 'bad' ? 'alert alert-bad' : 'alert alert-warn'} role={tone === 'bad' ? 'alert' : 'status'} data-testid={testId}>
      {tone === 'bad' ? <AlertTriangle className="alert-icon" {...ICON_SM} /> : <Info className="alert-icon" {...ICON_SM} />}
      <span className="alert-body">{t(`updates.unit.errors.${known ?? 'other'}`)}</span>
    </div>
  );
}

/** The desktop app zone for a server that runs it, state by state; the unit's own words, so the same on every device */
export function DesktopUnitView(props: DesktopUnitViewProps) {
  const { t } = useTranslation('config');
  const { status, titled, pending, restartAsked, dialog } = props;
  const { state } = status;
  const installing = state === 'installing';
  const restartPending = status.restartNeeded && !installing;
  const reason = status.reason?.code ?? null;
  // `installed` without a restart to make is the end of a run, and the next update starts from it; "up to date"
  // offers the button only when a newer Claudio is out, never beside its own green tag for nothing
  const canUpdate = !restartPending && (state === 'idle' || state === 'installed' || (state === 'up-to-date' && props.updateAvailable));
  // A refused start says why under the button; a status that failed says it in the card's own alert
  const refused = props.failure !== null && props.failure !== undefined;
  const startRefusal = refused ? desktopUnitErrorCode(props.failure) : null;

  const tag = restartPending ? (
    <Tag tone="idle">{t('updates.unit.restartTag')}</Tag>
  ) : state === 'failed' ? (
    <Tag tone="bad">{t('updates.unit.failedTag')}</Tag>
  ) : state === 'needs-login' ? (
    <Tag tone="warn">{t('updates.unit.needsLoginTag')}</Tag>
  ) : state === 'up-to-date' && !props.updateAvailable ? (
    <Tag tone="ok">{t('updates.upToDateTag')}</Tag>
  ) : null;

  return (
    <div className="stack" data-testid="update-desktop-unit" data-state={state} data-restart-needed={status.restartNeeded}>
      <div className="update-facts">
        {titled && <span className="pref-row-title">{t('updates.desktopTitle')}</span>}
        {state !== 'unavailable' && (
          <span>
            {t('updates.unit.installed')} <span className="tnum">{status.installed}</span>
          </span>
        )}
        {tag}
      </div>

      {state === 'unavailable' && (
        <p className="alert alert-info small" role="status" data-testid="update-desktop-unavailable">
          <Info className="alert-icon" {...ICON_SM} />
          <span className="alert-body">
            {t('updates.unit.unavailable')}{' '}
            {props.releaseUrl && (
              <a href={props.releaseUrl} target="_blank" rel="noopener noreferrer">
                {t('updates.desktopManual')}
              </a>
            )}
          </span>
        </p>
      )}

      {state === 'needs-login' && <UnitNotice code="needs-login" tone="warn" testId="update-desktop-needs-login" />}

      {installing && (
        <p className="small" role="status" data-testid="update-desktop-installing">
          <Spinner /> {t('updates.unit.updating')}
        </p>
      )}

      {state === 'failed' && (
        <div className="stack">
          <UnitNotice code={reason} tone="bad" testId="update-desktop-unit-failed" />
          <div>
            <button type="button" className="btn btn-small" disabled={pending} onClick={props.onUpdate}>
              {t('updates.tryAgain')}
            </button>
          </div>
        </div>
      )}

      {canUpdate && (
        <div>
          <button type="button" className={props.primary && props.updateAvailable ? 'btn btn-primary' : 'btn'} disabled={pending} onClick={props.onUpdate}>
            <Download {...ICON} /> {t('updates.unit.update')}
          </button>
        </div>
      )}

      {refused && !(state === 'needs-login' && startRefusal === 'needs-login') && (
        <UnitNotice code={startRefusal} tone={startRefusal === 'needs-login' || startRefusal === 'busy' ? 'warn' : 'bad'} testId="update-desktop-unit-refused" />
      )}

      {restartPending && (
        <div className="stack" data-testid="update-desktop-restart">
          <p className="small" role="status">
            {restartAsked === 'now' ? (
              <>
                <Spinner /> {t('updates.unit.restarting')}
              </>
            ) : restartAsked === 'when-idle' ? (
              t('updates.unit.restartScheduled')
            ) : (
              t('updates.unit.restartNeeded', { installed: status.installed, running: status.running })
            )}
          </p>
          {restartAsked === null && (
            <div>
              <button type="button" className={props.primary ? 'btn btn-primary' : 'btn'} disabled={pending} onClick={props.onAskRestart}>
                <RotateCw {...ICON} /> {t('updates.unit.restart')}
              </button>
            </div>
          )}
        </div>
      )}

      {props.restartFailure !== null && props.restartFailure !== undefined && (
        <div className="alert alert-bad" role="alert" data-testid="update-desktop-restart-failed">
          <AlertTriangle className="alert-icon" {...ICON_SM} />
          <span className="alert-body">{refusalStatus(props.restartFailure) === 412 ? t('updates.unit.restartUnavailable') : t('updates.unit.restartFailed')}</span>
        </div>
      )}

      {dialog && (
        <Dialog
          title={dialog.live ? t('updates.unit.busyTitle') : t('updates.unit.confirmTitle')}
          onClose={props.onCloseDialog}
          width={460}
          footer={<UnitDialogFooter live={dialog.live} pending={pending} onCancel={props.onCloseDialog} onRestart={props.onRestart} />}
        >
          <UnitDialogBody live={dialog.live} installed={status.installed} liveSentence={props.liveSentence} />
        </Dialog>
      )}
    </div>
  );
}

/** Exported apart from the dialog because a portal cannot be rendered to markup in a test */
export function UnitDialogBody({ live, installed, liveSentence }: { live: LiveWork | null; installed: string; liveSentence: (live: LiveWork) => string }) {
  const { t } = useTranslation('config');
  return <p>{live ? t('updates.unit.busyBody', { live: liveSentence(live) }) : t('updates.unit.confirmBody', { version: installed })}</p>;
}

/** Confirming restarts at once; with live work it can only wait for idleness (the request has no way to force) */
export function UnitDialogFooter({ live, pending, onCancel, onRestart }: { live: LiveWork | null; pending: boolean; onCancel: () => void; onRestart: (options: RestartRequest) => void }) {
  const { t } = useTranslation('config');
  return (
    <>
      <button type="button" className="btn" onClick={onCancel}>
        {t('updates.cancel')}
      </button>
      {live ? (
        <button type="button" className="btn btn-primary" data-autofocus disabled={pending} onClick={() => onRestart({ whenIdle: true })}>
          {t('updates.whenIdle')}
        </button>
      ) : (
        <button type="button" className="btn btn-primary" data-autofocus disabled={pending} onClick={() => onRestart({})}>
          {t('updates.unit.restart')}
        </button>
      )}
    </>
  );
}

/** Claudio's own update (the payload): the server's state, and the calls that move it on */
function ServerUpdate({ status, info, steps, actions }: { status: ServerUpdateStatus; info: ClaudioReleaseInfo; steps: ReactNode; actions: PayloadActions }) {
  const queryClient = useQueryClient();
  const liveSentence = useLiveSentence();
  const [busy, setBusy] = useState<{ revert: boolean; live: LiveWork } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [dismissed, setDismissed] = useState<string | null>(dismissedRollback);
  // The version running when the restart began: the page reloads once the server reports another
  const [before, setBefore] = useState<string | null>(null);

  const take = (next: ServerUpdateStatus) => queryClient.setQueryData(keys.serverUpdate, next);
  // A refusal says the offer the card judged from has changed (a 412 after a newer check): ask again
  const refused = (error: unknown) => {
    setFailure(error);
    void queryClient.invalidateQueries({ queryKey: keys.serverUpdate });
  };
  const download = useMutation({ mutationFn: () => actions.download(), onSuccess: take, onError: refused });
  const cancel = useMutation({ mutationFn: () => actions.cancel(), onSuccess: take, onError: refused });
  // Applying and going back ask the same question of a person when work is live
  const restart = useMutation({
    mutationFn: ({ revert, ...body }: ServerUpdateApplyRequest & { revert?: boolean }) => (revert ? actions.revert(body) : actions.apply(body)),
    onMutate: () => setFailure(null),
    onSuccess: (next) => {
      setBusy(null);
      setBefore(status.running);
      take(next);
    },
    onError: (error, vars) => {
      const live = liveWorkOf(error);
      setBusy(live ? { revert: Boolean(vars.revert), live } : null);
      if (!live) refused(error);
    },
  });

  useEffect(() => {
    if (status.state === 'restarting' && before === null) setBefore(status.running);
    if (before !== null && status.running !== before && status.state !== 'restarting') window.location.reload();
  }, [status.state, status.running, before]);

  return (
    <ServerUpdateView
      status={status}
      latest={info.latest}
      updateAvailable={info.updateAvailable}
      steps={steps}
      pending={download.isPending || cancel.isPending || restart.isPending}
      failure={failure}
      busy={busy}
      liveSentence={liveSentence}
      rollbackDismissed={dismissed === status.lastRollback?.at}
      onDismissRollback={() => {
        const at = status.lastRollback?.at;
        if (!at) return;
        dismissRollback(at);
        setDismissed(at);
      }}
      onDownload={() => {
        setFailure(null);
        download.mutate();
      }}
      onRestart={(options) => restart.mutate(options)}
      onRevert={(options) => restart.mutate({ ...options, revert: true })}
      onCancel={() => cancel.mutate()}
      onCloseBusy={() => setBusy(null)}
    />
  );
}

export interface ServerUpdateViewProps {
  status: ServerUpdateStatus;
  latest: string | null;
  updateAvailable: boolean;
  /** The host commands, for where Claudio cannot update itself (a container) */
  steps: ReactNode;
  pending: boolean;
  failure: unknown;
  busy: { revert: boolean; live: LiveWork } | null;
  liveSentence: (live: LiveWork) => string;
  rollbackDismissed: boolean;
  onDismissRollback: () => void;
  onDownload: () => void;
  onRestart: (options: ServerUpdateApplyRequest) => void;
  onRevert: (options: ServerUpdateApplyRequest) => void;
  onCancel: () => void;
  onCloseBusy: () => void;
}

/** A failure of the update in words, from its code and never from the server's text; the way out is a button or the sentence itself */
function UpdateFailure({ code, retry, pending, testId }: { code: string | null; retry: (() => void) | null; pending: boolean; testId: string }) {
  const { t } = useTranslation('config');
  const known = updateErrorCode(code);
  return (
    <div className="alert alert-bad" role="alert" data-testid={testId}>
      <AlertTriangle className="alert-icon" {...ICON_SM} />
      <div className="alert-body stack">
        <span>{known ? <Trans t={t} i18nKey={`updates.errors.${known}`} components={{ mono: <span className="mono" /> }} /> : t('updates.desktopFailed')}</span>
        {retry && canRetryUpdate(known) && (
          <div>
            <button type="button" className="btn btn-small" disabled={pending} onClick={retry}>
              {t('updates.tryAgain')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** The Claudio zone, state by state; one `btn-primary` at most (docs/plans/container-polish.md and unified-updates.md, Design) */
export function ServerUpdateView(props: ServerUpdateViewProps) {
  const { t } = useTranslation('config');
  const { status, latest, updateAvailable, steps, pending, failure, busy, liveSentence } = props;
  const { state } = status;
  const version = status.target ?? latest ?? '';
  const onShell = status.base === 'shell';

  if (status.unsupportedReason) {
    // `not-docker` cannot reach here (the card asked because it is a container or a desktop app); the steps stand alone
    const reason = status.unsupportedReason;
    const ownWords = onShell && (reason === 'no-launcher' || reason === 'no-keys');
    return (
      <div className="stack" data-testid="server-update-unsupported">
        {reason !== 'not-docker' && (
          <p className="alert alert-warn small" role="status">
            <Info className="alert-icon" {...ICON_SM} />
            <span className="alert-body">{ownWords ? t(`updates.unsupportedDesktop.${reason}`) : t(`updates.unsupported.${reason}`)}</span>
          </p>
        )}
        {steps}
      </div>
    );
  }

  const percent = Math.round((status.progress ?? 0) * 100);
  const { needsImage, needsShell } = status;
  const rolledBack = status.lastRollback;
  const offer = status.offer;
  // The newest release cannot be installed here, known before any download: no button for what would fail
  const blocked = updateAvailable && offer && !offer.installable ? offer.blocked : null;
  const otherBlock = blocked === 'no-bundle' || blocked === 'unverified' || blocked === 'failed-before' ? blocked : null;
  const notInstallable = needsImage !== null || needsShell !== null || blocked !== null;
  const errorCode = status.error;
  // The alerts above already say a release needs a newer image or desktop app
  const failed = state === 'failed' && errorCode !== null && !(errorCode === 'needs-image' && needsImage) && !(errorCode === 'needs-shell' && needsShell);
  const idleOrFailed = state === 'idle' || state === 'failed';

  return (
    <div className="stack" data-testid="server-update" data-state={state}>
      {rolledBack && !props.rollbackDismissed && (
        <div className="alert alert-warn" role="status" data-testid="server-update-rollback">
          <AlertTriangle className="alert-icon" {...ICON_SM} />
          <div className="alert-body stack">
            <span>{t(onShell ? 'updates.rolledBackShell' : 'updates.rolledBack', { from: rolledBack.from, to: rolledBack.to })}</span>
            <div>
              <button type="button" className="btn btn-small" onClick={props.onDismissRollback}>
                {t('updates.dismiss')}
              </button>
            </div>
          </div>
        </div>
      )}

      {needsImage && idleOrFailed && (
        <>
          <div className="alert alert-warn" role="status" data-testid="server-update-needs-image">
            <AlertTriangle className="alert-icon" {...ICON_SM} />
            <span className="alert-body">{t('updates.needsImage', needsImage)}</span>
          </div>
          {steps}
        </>
      )}

      {/* The Desktop app zone under it carries the action */}
      {needsShell && idleOrFailed && (
        <div className="alert alert-warn" role="status" data-testid="server-update-needs-shell">
          <AlertTriangle className="alert-icon" {...ICON_SM} />
          <span className="alert-body">{t('updates.needsShell', needsShell)}</span>
        </div>
      )}

      {otherBlock && idleOrFailed && !needsImage && !needsShell && (
        <>
          <div className="alert alert-warn" role="status" data-testid="server-update-blocked" data-blocked={otherBlock}>
            <AlertTriangle className="alert-icon" {...ICON_SM} />
            <span className="alert-body">{t(`updates.blocked.${otherBlock}`, { version: offer?.version ?? latest ?? '' })}</span>
          </div>
          {otherBlock === 'no-bundle' && steps}
        </>
      )}

      {/* After a failure the alert's Try again is the way forward: a second button for the same call would be two primaries */}
      {!notInstallable && state === 'idle' && updateAvailable && (
        <div>
          <button type="button" className="btn btn-primary" disabled={pending} onClick={props.onDownload}>
            <Download {...ICON} /> {t('updates.download', { version: latest })}
          </button>
        </div>
      )}

      {state === 'downloading' && (
        <div className="stack">
          <p className="small" role="status">
            {t('updates.downloading', { version, percent: formatPercent(percent) })}
          </p>
          <span className="progress" role="progressbar" aria-label={t('updates.downloadProgress', { version })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
            <span className="progress-seg is-running" style={{ width: `${percent}%` }} aria-hidden />
          </span>
        </div>
      )}

      {state === 'verifying' && (
        <p className="small" role="status">
          <Spinner /> {t('updates.verifying')}
        </p>
      )}

      {state === 'ready' && (
        <div>
          <button type="button" className="btn btn-primary" disabled={pending} onClick={() => props.onRestart({})}>
            <RotateCw {...ICON} /> {t('updates.restart', { version })}
          </button>
        </div>
      )}

      {state === 'scheduled' && (
        <div className="stack">
          <p className="small" role="status">
            {t('updates.scheduledServer', { version })}
          </p>
          <div>
            <button type="button" className="btn btn-small" disabled={pending} onClick={props.onCancel}>
              {t('updates.cancel')}
            </button>
          </div>
        </div>
      )}

      {state === 'restarting' && (
        <p className="small" role="status">
          <Spinner /> {t(onShell ? 'updates.restartingShell' : 'updates.restarting')}
        </p>
      )}

      {failed && <UpdateFailure code={errorCode} retry={props.onDownload} pending={pending} testId="server-update-failed" />}
      {failure !== null && failure !== undefined && (
        <UpdateFailure code={updateErrorCode(failure)} retry={null} pending={pending} testId="server-update-refused" />
      )}

      {status.source === 'overlay' && (state === 'idle' || state === 'failed' || state === 'ready') && (
        <div>
          <button type="button" className="btn btn-small" disabled={pending} onClick={() => props.onRevert({})}>
            {onShell ? t('updates.revertShell', { shell: status.shell?.version ?? status.image }) : t('updates.revert', { image: status.image })}
          </button>
        </div>
      )}

      {busy && (
        <Dialog
          title={busy.revert ? (onShell ? t('updates.revertShell', { shell: status.shell?.version ?? status.image }) : t('updates.revert', { image: status.image })) : t('updates.busyTitle', { version })}
          onClose={props.onCloseBusy}
          width={460}
          footer={
            <>
              <button type="button" className="btn" onClick={props.onCloseBusy}>
                {t('updates.cancel')}
              </button>
              <button type="button" className="btn" data-autofocus disabled={pending} onClick={() => (busy.revert ? props.onRevert({ whenIdle: true }) : props.onRestart({ whenIdle: true }))}>
                {t('updates.whenIdle')}
              </button>
              <button type="button" className="btn btn-danger-solid" disabled={pending} onClick={() => (busy.revert ? props.onRevert({ force: true }) : props.onRestart({ force: true }))}>
                {t('updates.restartNow')}
              </button>
            </>
          }
        >
          <p>{t('updates.busyBodyServer', { live: liveSentence(busy.live) })}</p>
        </Dialog>
      )}
    </div>
  );
}
