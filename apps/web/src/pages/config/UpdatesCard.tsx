import type { ClaudioReleaseInfo, ServerUpdateApplyRequest, ServerUpdateStatus, StorageKind, StorageLocation } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Download, ExternalLink, Info, RotateCw } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { CopyButton, ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import type { DesktopUpdatesBridge } from '../../lib/desktop';
import { formatDate, formatPercent, timeAgo } from '@claudio/ui/lib/format';
import {
  DOCKER_REPLACE_COMMAND,
  DOCKER_RUN_COMMAND,
  DOCKER_UPDATE_WAYS,
  dismissedRollback,
  dismissRollback,
  liveWorkOf,
  parseInstallAnswer,
  parseUpdateState,
  serverUpdateRefetchMs,
  SOURCE_UPDATE_COMMAND,
  updateRoute,
  type DesktopUpdateState,
  type LiveWork,
  type UpdateHow,
} from '../../lib/updates';
import { PrefRow, ReservedLabel } from './PrefRow';

/**
 * Which Claudio this is and whether a newer release is out, with the way to take it that fits this
 * install. Reading is free: GitHub is only asked by the button and once a day by the server.
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
  // In a container Claudio may update itself; where it cannot, the status says why and the steps stay
  const inContainer = info?.distribution === 'docker' && !bridge;
  const server = useQuery({
    queryKey: keys.serverUpdate,
    queryFn: ({ signal }) => api.serverUpdate({ signal }),
    enabled: inContainer,
    refetchInterval: (query) => serverUpdateRefetchMs(query.state.data),
    // Mid-restart the API is down for a moment: keep what was shown instead of an error
    retry: false,
  });
  const status = inContainer ? server.data : undefined;

  const facts = info && (
    <span className="update-facts">
      <span>
        {t('updates.version')} <span className="tnum">{status?.running ?? info.current}</span>
        {status && status.image !== status.running && <> · {t('updates.imageVersion', { image: status.image })}</>}
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
      {info && route?.kind === 'desktop' && bridge && <DesktopUpdate bridge={bridge} info={info} />}
      {info && route?.kind === 'steps' && status && (
        <ServerUpdate
          status={status}
          info={info}
          steps={info.updateAvailable || status.needsImage ? <UpdateSteps how={route.how} remote={route.remote} /> : null}
        />
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

/** "2 chats are working, 1 orchestration is running": what a restart now would stop */
function useLiveSentence(): (live: LiveWork) => string {
  const { t } = useTranslation('config');
  return (live) =>
    [
      live.working ? t('updates.live.working', { count: live.working }) : null,
      live.waiting ? t('updates.live.waiting', { count: live.waiting }) : null,
      live.running ? t('updates.live.running', { count: live.running }) : null,
    ]
      .filter(Boolean)
      .join(', ');
}

/** The desktop window: download with its progress, then a restart that asks first when work is live */
function DesktopUpdate({ bridge, info }: { bridge: DesktopUpdatesBridge; info: ClaudioReleaseInfo }) {
  const { t } = useTranslation('config');
  const state = useDesktopUpdateState(bridge);
  const liveSentence = useLiveSentence();
  const [busy, setBusy] = useState<{ version: string; live: LiveWork } | null>(null);
  const [scheduled, setScheduled] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);

  const download = useMutation({ mutationFn: () => bridge.download(), onError: setFailure });
  const install = useMutation({
    mutationFn: async (options: { whenIdle?: boolean; force?: boolean }) => parseInstallAnswer(await bridge.install(options)),
    onSuccess: (answer) => {
      setBusy(null);
      if (answer?.status === 'busy') setBusy({ version: answer.version, live: answer.live });
      else if (answer?.status === 'scheduled') setScheduled(answer.version);
    },
    onError: (err) => {
      setBusy(null);
      setFailure(err);
    },
  });

  if (!state) return null;
  // Nothing to say while there is nothing newer and the shell is not in the middle of something
  const inFlight = state.status === 'downloading' || state.status === 'ready' || state.status === 'available';
  if (!info.updateAvailable && !inFlight) return null;

  return (
    <div className="stack" data-testid="update-desktop">
      {state.status === 'unsupported' && (
        <p className="alert alert-warn small" role="status">
          <Info className="alert-icon" {...ICON_SM} />
          <span className="alert-body">
            {state.message}{' '}
            {info.url && (
              <a href={info.url} target="_blank" rel="noopener noreferrer">
                {t('updates.desktopManual')}
              </a>
            )}
          </span>
        </p>
      )}

      {(state.status === 'idle' || state.status === 'available' || state.status === 'error') && (
        <div>
          <button type="button" className="btn btn-primary" disabled={download.isPending} onClick={() => download.mutate()}>
            <Download {...ICON} /> {t('updates.download', { version: state.status === 'available' ? state.version : info.latest })}
          </button>
        </div>
      )}
      {state.status === 'error' && <ErrorBox title={t('updates.desktopFailed')} error={new Error(state.message || t('updates.desktopFailed'))} />}

      {state.status === 'checking' && (
        <p className="small muted" role="status">
          {t('updates.looking')}
        </p>
      )}

      {state.status === 'downloading' && (
        <div className="stack">
          <p className="small" role="status">
            {t('updates.downloading', { version: state.version, percent: formatPercent(state.percent) })}
          </p>
          <span
            className="progress"
            role="progressbar"
            aria-label={t('updates.downloadProgress', { version: state.version })}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state.percent}
          >
            <span className="progress-seg is-running" style={{ width: `${state.percent}%` }} aria-hidden />
          </span>
        </div>
      )}

      {state.status === 'ready' &&
        (scheduled === state.version ? (
          <p className="small" role="status">
            {t('updates.scheduled', { version: state.version })}
          </p>
        ) : (
          <div>
            <button type="button" className="btn btn-primary" disabled={install.isPending} onClick={() => install.mutate({})}>
              <RotateCw {...ICON} /> {t('updates.restart', { version: state.version })}
            </button>
          </div>
        ))}
      <ErrorBox title={t('updates.desktopFailed')} error={failure} />

      {busy && (
        <Dialog
          title={t('updates.busyTitle', { version: busy.version })}
          onClose={() => setBusy(null)}
          width={460}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setBusy(null)}>
                {t('updates.cancel')}
              </button>
              <button type="button" className="btn" data-autofocus disabled={install.isPending} onClick={() => install.mutate({ whenIdle: true })}>
                {t('updates.whenQuit')}
              </button>
              <button type="button" className="btn btn-danger-solid" disabled={install.isPending} onClick={() => install.mutate({ force: true })}>
                {t('updates.restartNow')}
              </button>
            </>
          }
        >
          <p>{t('updates.busyBody', { live: liveSentence(busy.live) })}</p>
        </Dialog>
      )}
    </div>
  );
}

/** Claudio's own update inside its container: the server's state, and the calls that move it on */
function ServerUpdate({ status, info, steps }: { status: ServerUpdateStatus; info: ClaudioReleaseInfo; steps: ReactNode }) {
  const queryClient = useQueryClient();
  const liveSentence = useLiveSentence();
  const [busy, setBusy] = useState<{ revert: boolean; live: LiveWork } | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [dismissed, setDismissed] = useState<string | null>(dismissedRollback);
  // The version running when the restart began: the page reloads once the server reports another
  const [before, setBefore] = useState<string | null>(null);

  const take = (next: ServerUpdateStatus) => queryClient.setQueryData(keys.serverUpdate, next);
  const download = useMutation({ mutationFn: () => api.downloadServerUpdate(), onSuccess: take, onError: setFailure });
  const cancel = useMutation({ mutationFn: api.cancelServerUpdate, onSuccess: take, onError: setFailure });
  // Applying and going back ask the same question of a person when work is live
  const restart = useMutation({
    mutationFn: ({ revert, ...body }: ServerUpdateApplyRequest & { revert?: boolean }) => (revert ? api.revertServerUpdate(body) : api.applyServerUpdate(body)),
    onMutate: () => setFailure(null),
    onSuccess: (next) => {
      setBusy(null);
      setBefore(status.running);
      take(next);
    },
    onError: (error, vars) => {
      const live = liveWorkOf(error);
      setBusy(live ? { revert: Boolean(vars.revert), live } : null);
      if (!live) setFailure(error);
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
  /** The host commands, for where the container cannot update itself */
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

/** The container's own update, state by state; one `btn-primary` at most (docs/plans/container-polish.md, Design) */
export function ServerUpdateView(props: ServerUpdateViewProps) {
  const { t } = useTranslation('config');
  const { status, latest, updateAvailable, steps, pending, failure, busy, liveSentence } = props;
  const { state } = status;
  const version = status.target ?? latest ?? '';

  if (status.unsupportedReason) {
    // `not-docker` cannot reach here (the card asked because it is a container); the steps stand alone
    const reason = status.unsupportedReason;
    return (
      <div className="stack" data-testid="server-update-unsupported">
        {reason !== 'not-docker' && (
          <p className="alert alert-warn small" role="status">
            <Info className="alert-icon" {...ICON_SM} />
            <span className="alert-body">{t(`updates.unsupported.${reason}`)}</span>
          </p>
        )}
        {steps}
      </div>
    );
  }

  const percent = Math.round((status.progress ?? 0) * 100);
  const failed = state === 'failed' && status.error !== null && status.error !== 'needs-image';
  const needsImage = status.needsImage;
  const rolledBack = status.lastRollback;

  return (
    <div className="stack" data-testid="server-update" data-state={state}>
      {rolledBack && !props.rollbackDismissed && (
        <div className="alert alert-warn" role="status" data-testid="server-update-rollback">
          <AlertTriangle className="alert-icon" {...ICON_SM} />
          <div className="alert-body stack">
            <span>{t('updates.rolledBack', { from: rolledBack.from, to: rolledBack.to })}</span>
            <div>
              <button type="button" className="btn btn-small" onClick={props.onDismissRollback}>
                {t('updates.dismiss')}
              </button>
            </div>
          </div>
        </div>
      )}

      {needsImage && (state === 'idle' || state === 'failed') && (
        <>
          <div className="alert alert-warn" role="status" data-testid="server-update-needs-image">
            <AlertTriangle className="alert-icon" {...ICON_SM} />
            <span className="alert-body">{t('updates.needsImage', needsImage)}</span>
          </div>
          {steps}
        </>
      )}

      {/* After a failure the alert's Try again is the way forward: a second button for the same call would be two primaries */}
      {!needsImage && state === 'idle' && updateAvailable && (
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
          <Spinner /> {t('updates.restarting')}
        </p>
      )}

      {failed && status.error && (
        <div className="alert alert-bad" role="alert" data-testid="server-update-failed">
          <AlertTriangle className="alert-icon" {...ICON_SM} />
          <div className="alert-body stack">
            <span>
              <Trans t={t} i18nKey={`updates.serverError.${status.error}`} components={{ mono: <span className="mono" /> }} />
            </span>
            <div>
              <button type="button" className="btn btn-small" disabled={pending} onClick={props.onDownload}>
                {t('updates.tryAgain')}
              </button>
            </div>
          </div>
        </div>
      )}
      <ErrorBox title={t('updates.desktopFailed')} error={failure} />

      {status.source === 'overlay' && (state === 'idle' || state === 'failed' || state === 'ready') && (
        <div>
          <button type="button" className="btn btn-small" disabled={pending} onClick={() => props.onRevert({})}>
            {t('updates.revert', { image: status.image })}
          </button>
        </div>
      )}

      {busy && (
        <Dialog
          title={busy.revert ? t('updates.revert', { image: status.image }) : t('updates.busyTitle', { version })}
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
