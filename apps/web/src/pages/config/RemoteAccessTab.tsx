import type { AuthMode, LanState, LanStatus, SettingDefault, TailscaleReadiness, TunnelState, TunnelStatus, UpdateLanSettingsRequest } from '@claudio/shared';
import { useIsFetching, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, QrCode as QrIcon, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, keys, useSettingsState } from '../../api';
import { Checkbox, NumberInput, Sheet, Switch } from '@claudio/ui/components/controls';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { QrCode } from '../../components/QrCode';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, CopyButton, Empty, ErrorBox, Field, Segmented, Skeleton, Tag } from '@claudio/ui/components/ui';
import { timeAgo } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { localized } from '../../lib/server-strings';
import { tailscaleActions } from '../../lib/setup';
import { SignInPanel } from '../../components/setup/SignInPanel';
import { SignOutButton } from '../../components/setup/SignOutButton';
import { focusSettingControl, ServerSettingChange } from './SettingChange';
import { settingsHref } from './settingsGroups';

/** Where Tailscale is downloaded, and where a tailnet turns MagicDNS and HTTPS certificates on. */
export const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
export const TAILSCALE_DNS_ADMIN_URL = 'https://login.tailscale.com/admin/dns';

/** The state as a colour, always beside its word: ok is open, warn is on its way or leaving, idle waits for the person. */
export const TUNNEL_TONE: Record<TunnelState, 'ok' | 'warn' | 'bad' | 'idle'> = {
  active: 'ok',
  starting: 'warn',
  verifying: 'warn',
  stopping: 'warn',
  failed: 'bad',
  stopped: 'idle',
};

/** The ports the server's setting accepts (`MIN_TUNNEL_PORT`, `MAX_TUNNEL_PORT` in core's tunnel.ts) */
export const TUNNEL_PORT_RANGE = { min: 1024, max: 65535 } as const;

/** Whether the tunnel is open or on its way: what a Stop button can act on. */
export const tunnelBusy = (state: TunnelState) => state === 'starting' || state === 'verifying' || state === 'active';

/** Whether this page itself arrived through the tunnel, so closing it would cut the page off. */
export function reachedThrough(url: string | null, host: string): boolean {
  if (!url) return false;
  try {
    return new URL(url).host === host;
  } catch {
    return false;
  }
}

/**
 * Settings → Access & safety → Remote access: this Claudio on the person's tailnet, through `tailscale serve`. The
 * status comes whole with every `tunnel.changed` (lib/events.ts), so the page follows the tunnel
 * through its states without polling; reading it again also asks the CLI again, which is how a
 * `tailscale up` run in a terminal shows up.
 */
export function RemoteAccessTab() {
  const tunnel = useQuery({ queryKey: keys.tunnel, queryFn: api.tunnel });
  const lan = useQuery({ queryKey: keys.lan, queryFn: api.lan });
  const auth = useQuery({ queryKey: keys.securityAuth, queryFn: api.securityAuth });
  const status = tunnel.data;

  return (
    <>
      <ErrorBox error={tunnel.error ?? lan.error ?? auth.error} />
      {/* The local network first: it needs nothing installed, and the tunnel below is what a phone should use. Its rows are marked `lan.*` inside */}
      {lan.data && auth.data && (
        <div className="settings-block">
          <LanCard status={lan.data} authMode={auth.data.mode} />
        </div>
      )}
      {/* Marked while it loads too, so a search that takes the person here finds the row */}
      <div className="settings-block" data-setting="remote.tunnel">
        {(tunnel.isLoading || lan.isLoading || auth.isLoading) && (
          <Card>
            <Skeleton rows={5} />
          </Card>
        )}
        {status && auth.data && <TunnelCard status={status} authMode={auth.data.mode} />}
      </div>
    </>
  );
}

/** The state as a colour, always beside its word: ok is open to the network, warn waits for a sign-in method, bad is what the person must fix, idle is off. */
export const LAN_TONE: Record<LanState, 'ok' | 'warn' | 'bad' | 'idle'> = {
  listening: 'ok',
  off: 'idle',
  refused: 'warn',
  'port-in-use': 'bad',
  failed: 'bad',
};

/** The ports the server's setting accepts (`MIN_LAN_PORT`, `MAX_LAN_PORT` in core's lan.ts) */
export const LAN_PORT_RANGE = { min: 1024, max: 65535 } as const;

/** What the environment fixes, so the card shows it and never sends it (`CLAUDIO_LAN`, `CLAUDIO_LAN_PORT`, `CLAUDIO_LAN_BIND`). */
export interface LanFromEnv {
  enabled?: boolean;
  port?: boolean;
  bind?: boolean;
}

/**
 * Settings → Access & safety → Remote access, first card: Claudio on the person's own network, from a
 * second listener of the server (docs/plans/lan-access.md). Like the tunnel's, the status comes whole
 * with every `lan.changed`, so the card follows the listener without polling. The switch, the port
 * and the interfaces are the three settings the registry resets.
 */
function LanCard({ status, authMode }: { status: LanStatus; authMode: AuthMode }) {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const toast = useToast();
  const states = useSettingsState().data?.settings;
  const onStatus = (next: LanStatus) => queryClient.setQueryData(keys.lan, next);
  const save = useMutation({
    mutationFn: (patch: UpdateLanSettingsRequest) => api.updateLanSettings(patch),
    onSuccess: onStatus,
    onError: (err) => toast.error(t('lan.saveFailed'), err),
  });
  const retry = useMutation({ mutationFn: api.startLan, onSuccess: onStatus, onError: (err) => toast.error(t('lan.startFailed'), err) });
  const fromEnv: LanFromEnv = {
    enabled: states?.['lan.enabled']?.source === 'env',
    port: states?.['lan.port']?.source === 'env',
    bind: states?.['lan.bind']?.source === 'env',
  };
  return (
    <LanPanel
      status={status}
      authMode={authMode}
      fromEnv={fromEnv}
      pending={save.isPending || retry.isPending}
      onSettings={(patch) => save.mutate(patch)}
      onRetry={() => retry.mutate()}
      onChanged={() => void queryClient.invalidateQueries({ queryKey: keys.lan })}
    />
  );
}

/**
 * What the LAN card shows for a status, kept apart from the queries so a test can draw every state.
 * The five states are Listening, Off, Needs a sign-in method (the switch is disabled and the card
 * links to Security, as the tunnel's does), Port in use (the port field takes focus, and the next
 * free port is one press away) and Failed (the error as the system wrote it, in mono). One QR is
 * open at a time: below the addresses on a desktop, in a sheet on a phone. The notice about plain HTTP
 * is never behind a click: it is on screen for as long as anything listens or is meant to.
 */
export function LanPanel({
  status,
  authMode,
  fromEnv = {},
  pending = false,
  onSettings,
  onRetry = () => {},
  onChanged = () => {},
}: {
  status: LanStatus;
  authMode: AuthMode;
  fromEnv?: LanFromEnv;
  pending?: boolean;
  /** Sends the settings that changed, and only those */
  onSettings: (patch: UpdateLanSettingsRequest) => void;
  onRetry?: () => void;
  /** A Reset ran: the status is read again */
  onChanged?: () => void;
}) {
  const { t } = useTranslation('config');
  const { state, settings } = status;
  const narrow = useMediaQuery(NARROW);
  const [qrFor, setQrFor] = useState<string | null>(null);
  const previous = useRef<LanState>(state);
  const needsSignIn = state === 'refused' || authMode === 'none';
  const nextFree = status.portTaken?.nextFree ?? null;

  // A port that was free a moment ago and is not now: the field to change is the one that takes focus.
  // Only on the move into the state, so a page that opens on it does not pull focus away
  useEffect(() => {
    if (state === 'port-in-use' && previous.current !== 'port-in-use') focusSettingControl('lan.port');
    previous.current = state;
  }, [state]);

  // The address a QR belonged to can go (the machine changed network): its code goes with it
  const openQr = status.addresses.some((address) => address.url === qrFor) ? qrFor : null;

  if (!status.available) {
    return (
      <Card title={t('lan.title')} actions={<Tag tone="warn">{t('lan.disabled.tag')}</Tag>}>
        <p className="small muted">{t('lan.intro.off')}</p>
        <div className="alert alert-warn" role="status" data-testid="lan-disabled">
          <ShieldAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('lan.disabled.title')}</strong>
            <div className="small">{t('lan.disabled.body', { variable: 'CLAUDIO_LAN=on' })}</div>
          </div>
        </div>
      </Card>
    );
  }

  const wording = {
    port: (value: SettingDefault) => String(value),
    bind: (value: SettingDefault) => (value === 'all' ? t('lan.bind.all') : t('settings.changeSlot.composite')),
  };

  return (
    <Card
      title={t('lan.title')}
      actions={
        <div className="lan-head" data-setting="lan.enabled">
          <Switch
            checked={settings.enabled === true}
            disabled={pending || needsSignIn || fromEnv.enabled === true}
            aria-label={t('lan.switch')}
            onChange={(enabled) => onSettings({ enabled })}
          />
          <Tag tone={LAN_TONE[state]}>{t(`lan.states.${state}`)}</Tag>
          <ServerSettingChange id="lan.enabled" label={t('lan.switch')} invalidate={[keys.lan]} onReset={onChanged} />
        </div>
      }
    >
      {/* A port in use or a failure has an alert of its own: "turn this on" would contradict the switch */}
      {(state === 'listening' || state === 'off' || state === 'refused') && <p className="small muted">{state === 'listening' ? t('lan.intro.listening') : t('lan.intro.off')}</p>}

      {state === 'listening' && (
        <>
          {status.addresses.length === 0 ? (
            <p className="small muted" data-testid="lan-no-address">
              {t('lan.noAddress')}
            </p>
          ) : (
            <ul className="lan-addresses" data-testid="lan-addresses">
              {status.addresses.map((address) => (
                <li key={address.url} className="lan-address">
                  <a className="lan-address-url mono break" href={address.url} target="_blank" rel="noreferrer" data-testid="lan-url">
                    {address.url}
                  </a>
                  <span className="lan-address-actions">
                    <CopyButton text={address.url} label={t('lan.address.copy', { url: address.url })} />
                    <button
                      type="button"
                      className="btn btn-small lan-qr-button"
                      aria-pressed={openQr === address.url}
                      aria-label={t('lan.address.showQr', { url: address.url })}
                      data-testid="lan-qr-toggle"
                      onClick={() => setQrFor(openQr === address.url ? null : address.url)}
                    >
                      <QrIcon {...ICON_SM} />
                      {t('lan.address.qr')}
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {openQr && !narrow && (
            <div className="lan-qr" data-testid="lan-qr">
              <QrCode text={openQr} label={t('lan.qr.label', { url: openQr })} />
              <p className="small muted">{t('lan.qr.scan')}</p>
            </div>
          )}
          <Sheet open={openQr !== null && narrow} onOpenChange={(open) => !open && setQrFor(null)} title={t('lan.qr.title')} description={openQr ?? undefined} side="bottom">
            {openQr && (
              <div className="lan-qr lan-qr-sheet" data-testid="lan-qr">
                <QrCode text={openQr} label={t('lan.qr.label', { url: openQr })} />
                <p className="small muted">{t('lan.qr.scan')}</p>
              </div>
            )}
          </Sheet>
        </>
      )}

      {state === 'refused' && (
        <div className="alert alert-warn" role="status" data-testid="lan-auth-required">
          <ShieldAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('lan.authRequired.title')}</strong>
            <div className="small">{t('lan.authRequired.body')}</div>
            <div className="form-actions">
              <Link className="btn btn-small" to={settingsHref('access', { section: 'access' })}>
                {t('lan.authRequired.action')}
              </Link>
            </div>
          </div>
        </div>
      )}

      {state === 'port-in-use' && (
        <div className="alert alert-bad" role="alert" data-testid="lan-port-in-use">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('lan.portInUse.title', { port: String(status.port) })}</strong>
            <div className="small">{t('lan.portInUse.body')}</div>
            {status.portTaken && (
              <div className="small" data-testid="lan-port-holder">
                {t('lan.portInUse.holder')} <code className="mono break">{status.portTaken.holder}</code>
              </div>
            )}
            {nextFree !== null && !fromEnv.port && (
              <div className="form-actions">
                <button type="button" className="btn btn-small" disabled={pending} onClick={() => onSettings({ port: nextFree })} data-testid="lan-use-next-port">
                  {t('lan.portInUse.useNext', { port: String(nextFree) })}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {state === 'failed' && (
        <div className="alert alert-bad" role="alert" data-testid="lan-failed">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('lan.failedTitle')}</strong>
            {status.reason?.code === 'lan.listenFailed' && typeof status.reason.params?.detail === 'string' ? (
              <div className="small">
                <code className="mono break">{status.reason.params.detail}</code>
              </div>
            ) : (
              status.reason && <div className="small">{localized(status.reason)}</div>
            )}
            <div className="form-actions">
              <button type="button" className="btn btn-small" disabled={pending} onClick={onRetry} data-testid="lan-retry">
                {t('lan.retry')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Keyed by the port, so a port the server moved (the next free one, another page) replaces the draft */}
      <LanPortSetting key={status.settings.port} status={status} fromEnv={fromEnv.port === true} pending={pending} wording={wording.port} onChanged={onChanged} onSave={(port) => onSettings({ port })} />
      <LanBindSetting status={status} fromEnv={fromEnv.bind === true} pending={pending} wording={wording.bind} onChanged={onChanged} onSave={(bind) => onSettings({ bind })} />

      {state !== 'off' && state !== 'refused' && (
        <div className="alert alert-warn" data-testid="lan-http-notice">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('lan.http.title')}</strong>
            <div className="small">{t('lan.http.body')}</div>
          </div>
        </div>
      )}
    </Card>
  );
}

/**
 * The port the listener opens on. Saved with its button, as the tunnel's is: a listener that moves
 * port on every keystroke would close and open on each digit. Where `CLAUDIO_LAN_PORT` sets it, it is
 * shown and never sent.
 */
function LanPortSetting({
  status,
  fromEnv,
  pending,
  wording,
  onChanged,
  onSave,
}: {
  status: LanStatus;
  fromEnv: boolean;
  pending: boolean;
  wording: (value: SettingDefault) => string;
  onChanged: () => void;
  onSave: (port: number) => void;
}) {
  const { t } = useTranslation('config');
  const [draft, setDraft] = useState<number | undefined>(status.settings.port);
  const valid = draft !== undefined && Number.isInteger(draft) && draft >= LAN_PORT_RANGE.min && draft <= LAN_PORT_RANGE.max;
  const hint = fromEnv ? t('lan.port.fromEnv', { variable: 'CLAUDIO_LAN_PORT' }) : status.state === 'listening' ? t('lan.port.restarts') : t('lan.port.hint');
  return (
    <form
      className="setting-change-row lan-setting"
      data-setting="lan.port"
      data-testid="lan-port"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave(draft);
      }}
    >
      <Field label={t('lan.port.label')} hint={hint}>
        <NumberInput aria-label={t('lan.port.label')} value={draft} onChange={setDraft} min={LAN_PORT_RANGE.min} max={LAN_PORT_RANGE.max} disabled={fromEnv || pending} compact />
      </Field>
      <ServerSettingChange id="lan.port" label={t('lan.port.label')} wording={wording} invalidate={[keys.lan]} onReset={onChanged} />
      {!fromEnv && (
        <div className="form-actions">
          <button type="submit" className="btn btn-small" disabled={!valid || draft === status.settings.port || pending}>
            {t('lan.port.save')}
          </button>
        </div>
      )}
    </form>
  );
}

/**
 * Which of the machine's addresses the listener answers on: all of them, or the ones ticked. The
 * last one ticked cannot be cleared, since a listener on no address is not a setting the server
 * accepts. An address the settings keep that the machine no longer has stays in the list, ticked,
 * so the person sees why the listener failed.
 */
function LanBindSetting({
  status,
  fromEnv,
  pending,
  wording,
  onChanged,
  onSave,
}: {
  status: LanStatus;
  fromEnv: boolean;
  pending: boolean;
  wording: (value: SettingDefault) => string;
  onChanged: () => void;
  onSave: (bind: 'all' | string[]) => void;
}) {
  const { t } = useTranslation('config');
  const { bind } = status.settings;
  const chosen = bind === 'all' ? [] : bind;
  const options = [...status.interfaces.map(({ name, ip }) => ({ name: name as string | null, ip })), ...chosen.filter((ip) => !status.interfaces.some((each) => each.ip === ip)).map((ip) => ({ name: null as string | null, ip }))];
  const first = status.interfaces[0]?.ip;
  return (
    <div className="setting-change-row lan-setting" data-setting="lan.bind" data-testid="lan-bind">
      <div className="lan-bind-head">
        <span className="field-label">{t('lan.bind.label')}</span>
        <Segmented
          label={t('lan.bind.label')}
          value={bind === 'all' ? 'all' : 'choose'}
          disabled={pending || fromEnv}
          options={[
            { value: 'all', label: t('lan.bind.all') },
            { value: 'choose', label: t('lan.bind.choose'), disabled: first === undefined && bind === 'all', title: first === undefined ? t('lan.bind.none') : undefined },
          ]}
          onChange={(next) => {
            if (next === 'all') onSave('all');
            else if (first !== undefined) onSave([first]);
          }}
        />
      </div>
      <ServerSettingChange id="lan.bind" label={t('lan.bind.label')} wording={wording} invalidate={[keys.lan]} onReset={onChanged} />
      {bind !== 'all' && (
        <ul className="lan-interfaces" data-testid="lan-interfaces">
          {options.map((option) => {
            const on = chosen.includes(option.ip);
            return (
              <li key={option.ip}>
                <Checkbox
                  className="check lan-interface"
                  checked={on}
                  // The last one ticked stays: the listener needs an address to open on
                  disabled={pending || fromEnv || (on && chosen.length === 1)}
                  aria-label={option.name ? `${option.ip} (${option.name})` : option.ip}
                  onChange={(next) => onSave(next ? [...chosen, option.ip] : chosen.filter((ip) => ip !== option.ip))}
                >
                  <span className="mono">{option.ip}</span>
                  {option.name && <span className="small muted lan-interface-name">{option.name}</span>}
                </Checkbox>
              </li>
            );
          })}
        </ul>
      )}
      <p className="small muted lan-bind-hint">{fromEnv ? t('lan.bind.fromEnv', { variable: 'CLAUDIO_LAN_BIND' }) : bind === 'all' ? t('lan.bind.hintAll') : t('lan.bind.hintChosen')}</p>
    </div>
  );
}

function TunnelCard({ status, authMode }: { status: TunnelStatus; authMode: AuthMode }) {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const onStatus = (next: TunnelStatus) => queryClient.setQueryData(keys.tunnel, next);
  const checking = useIsFetching({ queryKey: keys.tunnel }) > 0;

  // Set once this page has closed the tunnel it came through: its address is gone, so nothing it
  // could fetch from here on would answer, and a failure is the expected end rather than an error
  const [closedHere, setClosedHere] = useState(false);
  const start = useMutation({ mutationFn: api.startTunnel, onSuccess: onStatus, onError: (err) => toast.error(t('remote.startFailed'), err) });
  const stop = useMutation({
    // `here` rides along as the mutation's variable so both outcomes know where the request came from
    mutationFn: (_here: boolean) => api.stopTunnel(),
    onSuccess: (next, here) => (here ? setClosedHere(true) : onStatus(next)),
    onError: (err, here) => (here ? setClosedHere(true) : toast.error(t('remote.stopFailed'), err)),
  });
  const settings = useMutation({
    mutationFn: api.updateTunnelSettings,
    onSuccess: onStatus,
    onError: (err) => toast.error(t('remote.saveFailed'), err),
  });
  // "Use the next free port": the port goes into the settings, then the tunnel opens on it
  const movePort = useMutation({
    mutationFn: async (port: number) => {
      onStatus(await api.updateTunnelSettings({ port }));
      return api.startTunnel();
    },
    onSuccess: onStatus,
    onError: (err) => toast.error(t('remote.startFailed'), err),
  });

  async function close() {
    // Closing the tunnel this page came through leaves it talking to an address that is gone
    const here = reachedThrough(status.url, window.location.host);
    if (here) {
      const ok = await confirm({ title: t('remote.stopConfirm.title'), body: t('remote.stopConfirm.body'), confirmLabel: t('remote.stop') });
      if (!ok) return;
    }
    stop.mutate(here);
  }

  if (closedHere) return <TunnelPanel status={status} authMode={authMode} closedHere onStart={() => {}} onStop={() => {}} />;

  return (
    <>
      <TunnelPanel
        status={status}
        authMode={authMode}
        pending={start.isPending || stop.isPending || movePort.isPending}
        checking={checking}
        onStart={() => start.mutate()}
        onStop={() => void close()}
        onRecheck={() => void queryClient.invalidateQueries({ queryKey: keys.tunnel })}
        onUsePort={(port) => movePort.mutate(port)}
      />
      {status.enabled && status.tailscale.state === 'ready' && (
        <div className="settings-block">
          <div className="setting-change-row">
            <Switch
              checked={status.settings.startWithClaudio}
              disabled={settings.isPending}
              onChange={(startWithClaudio) => settings.mutate({ startWithClaudio })}
            >
              {t('remote.startWith.label')}
            </Switch>
            <p className="small muted">{t('remote.startWith.hint')}</p>
            <ServerSettingChange id="remote.tunnel" label={t('remote.startWith.label')} invalidate={[keys.tunnel]} />
          </div>
          {/* Keyed by the port, so a port the server moved (the next free one, another page) replaces the draft */}
          <TunnelPortSetting key={status.port} status={status} onStatus={onStatus} />
        </div>
      )}
      <p className="small muted">{t('remote.footnote')}</p>
    </>
  );
}

/**
 * What the tunnel card shows for a status, kept apart from the queries so a test can draw every
 * state. Nothing about the tunnel is offered until Tailscale is ready: before that, the card says
 * what is missing and what the person runs or turns on, because Claudio never signs in to or
 * configures Tailscale itself. Once ready, the start button is the zone's one primary action;
 * while the guard is open it is replaced by the reason and the way to Security.
 */
export function TunnelPanel({
  status,
  authMode,
  pending = false,
  checking = false,
  closedHere = false,
  onStart,
  onStop,
  onRecheck = () => {},
  onUsePort,
}: {
  status: TunnelStatus;
  authMode: AuthMode;
  pending?: boolean;
  /** The status is being read again, which also asks the CLI again */
  checking?: boolean;
  /** This page closed the tunnel it came through, and nothing behind its address answers any more */
  closedHere?: boolean;
  onStart: () => void;
  onStop: () => void;
  onRecheck?: () => void;
  /** Moves the tunnel to the port given and opens it there: "Use the next free port" */
  onUsePort?: (port: number) => void;
}) {
  const { t } = useTranslation('config');
  const { state } = status;
  const guarded = authMode !== 'none';
  const nextFree = status.portTaken?.nextFree ?? null;

  if (closedHere) {
    return (
      <Card actions={<Tag tone={TUNNEL_TONE.stopped}>{t('remote.states.stopped')}</Tag>}>
        <div data-testid="tunnel-closed-here">
          <Empty illustration="offline" size="sm" title={t('remote.closedHere.title')}>
            {t('remote.closedHere.body')}
          </Empty>
        </div>
      </Card>
    );
  }

  // Off by the deploy (CLAUDIO_TUNNEL, off in the image): only whoever runs Claudio can change that,
  // so a start button would only ever answer 409
  if (!status.enabled) {
    return (
      <Card actions={<Tag tone="warn">{t('remote.disabled.tag')}</Tag>}>
        <p className="small muted">{t('remote.intro')}</p>
        <div className="alert alert-warn" role="status" data-testid="tunnel-disabled">
          <ShieldAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('remote.disabled.title')}</strong>
            <div className="small">{t('remote.disabled.body', { variable: 'CLAUDIO_TUNNEL=on' })}</div>
          </div>
        </div>
      </Card>
    );
  }

  if (status.tailscale.state !== 'ready') return <TailscaleNotReady readiness={status.tailscale} managed={status.managed} checking={checking} onRecheck={onRecheck} />;

  return (
    <Card actions={<Tag tone={TUNNEL_TONE[state]}>{t(`remote.states.${state}`)}</Tag>}>
      <p className="small muted">{t('remote.intro')}</p>
      {status.tailscale.host && (
        <div className="tunnel-node">
          <p className="small muted" data-testid="tunnel-node">
            {t('remote.node')} <span className="mono">{status.tailscale.host}</span>
          </p>
          {/* Only the Tailscale Claudio runs is Claudio's to sign out; closing the tunnel comes first, on the server */}
          {status.managed && <SignOutButton tool="tailscale" label="Tailscale" small />}
        </div>
      )}

      {state === 'active' && status.url && <TunnelAddress url={status.url} since={status.since} />}

      {/* Slow answers are not a failure: no colour change, only the word, and a warning once nothing has answered for a while */}
      {state === 'active' && status.checking && !status.reason && (
        <p className="small muted" role="status" data-testid="tunnel-checking">
          {t('remote.checking')}
        </p>
      )}

      {state === 'active' && status.reason && (
        <div className="alert alert-warn" role="status" data-testid="tunnel-not-answering">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('remote.notAnsweringTitle')}</strong>
            <div className="small">{localized(status.reason)}</div>
          </div>
        </div>
      )}

      {(state === 'starting' || state === 'verifying' || state === 'stopping') && (
        <p className="small" role="status" data-testid="tunnel-progress">
          {t(`remote.progress.${state}`)}
        </p>
      )}

      {state === 'failed' && status.reason && (
        <div className="alert alert-bad" role="alert">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('remote.failedTitle')}</strong>
            <div className="small">{localized(status.reason)}</div>
            {status.portTaken && (
              <>
                <div className="small" data-testid="tunnel-port-holder">
                  {t('remote.portTaken.holder')} <code className="mono break">{status.portTaken.holder}</code>
                </div>
                {guarded && onUsePort && nextFree !== null && status.portSource !== 'env' && (
                  <div className="form-actions">
                    <button type="button" className="btn btn-small" disabled={pending} onClick={() => onUsePort(nextFree)} data-testid="tunnel-use-next-port">
                      {t('remote.portTaken.useNext', { port: nextFree })}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {!guarded ? (
        <div className="alert alert-warn" role="status" data-testid="tunnel-auth-required">
          <ShieldAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            <strong>{t('remote.authRequired.title')}</strong>
            <div className="small">{t('remote.authRequired.body')}</div>
            <div className="form-actions">
              <Link className="btn btn-small" to={settingsHref('access', { section: 'access' })}>
                {t('remote.authRequired.action')}
              </Link>
            </div>
          </div>
        </div>
      ) : (
        <div className="tunnel-actions">
          {tunnelBusy(state) ? (
            <button type="button" className="btn" disabled={pending} onClick={onStop} data-testid="tunnel-stop">
              {t('remote.stop')}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={pending || state === 'stopping'} onClick={onStart} data-testid="tunnel-start">
              {state === 'failed' ? t('remote.retry') : t('remote.start')}
            </button>
          )}
          <p className="small muted">{t('remote.caveat', { port: status.port })}</p>
        </div>
      )}
    </Card>
  );
}

/**
 * The port of Claudio's Serve rule. It changes only while the tunnel is closed or failed: the rule on
 * the old port is taken away by closing first. Where `CLAUDIO_TUNNEL_PORT` sets it, it is shown and
 * never sent.
 */
export function TunnelPortSetting({ status, onStatus }: { status: TunnelStatus; onStatus: (next: TunnelStatus) => void }) {
  const { t } = useTranslation('config');
  const toast = useToast();
  const [draft, setDraft] = useState<number | undefined>(status.port);
  const save = useMutation({
    mutationFn: (port: number) => api.updateTunnelSettings({ port }),
    onSuccess: (next) => {
      onStatus(next);
      setDraft(next.port);
    },
    onError: (err) => toast.error(t('remote.port.saveFailed'), err),
  });
  const fromEnv = status.portSource === 'env';
  const open = tunnelBusy(status.state) || status.state === 'stopping';
  const valid = draft !== undefined && Number.isInteger(draft) && draft >= TUNNEL_PORT_RANGE.min && draft <= TUNNEL_PORT_RANGE.max;
  const hint = fromEnv ? t('remote.port.fromEnv', { variable: 'CLAUDIO_TUNNEL_PORT' }) : open ? t('remote.port.whileOpen') : t('remote.port.hint');
  return (
    <form
      className="setting-change-row"
      data-testid="tunnel-port"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) save.mutate(draft);
      }}
    >
      <Field label={t('remote.port.label')} hint={hint}>
        <NumberInput aria-label={t('remote.port.label')} value={draft} onChange={setDraft} min={TUNNEL_PORT_RANGE.min} max={TUNNEL_PORT_RANGE.max} disabled={fromEnv || open || save.isPending} compact />
      </Field>
      {!fromEnv && !open && (
        <div className="form-actions">
          <button type="submit" className="btn btn-small" disabled={!valid || draft === status.port || save.isPending}>
            {t('remote.port.save')}
          </button>
        </div>
      )}
    </form>
  );
}

/**
 * Tailscale is not there or not ready. Not installed is the one state with an illustration, since
 * the whole section depends on it; the others say what is missing in the server's words (by code),
 * and what the person can do about it: a command to run, or the admin page to open. Where Claudio
 * runs the daemon itself (`managed`, the Docker image) there is no terminal to run anything in, so
 * a signed-out node is signed in here instead, with the shared panel.
 */
function TailscaleNotReady({ readiness, managed, checking, onRecheck }: { readiness: TailscaleReadiness; managed: boolean; checking: boolean; onRecheck: () => void }) {
  const { t } = useTranslation('config');
  const recheck = (
    <button type="button" className="btn" disabled={checking} onClick={onRecheck} data-testid="tunnel-recheck">
      {t('remote.tailscale.recheck')}
    </button>
  );

  if (readiness.state === 'missing') {
    return (
      <Card actions={<Tag tone="warn">{t('remote.tailscale.tags.missing')}</Tag>}>
        <div data-testid="tunnel-tailscale-missing">
          <Empty
            illustration="cli-missing"
            tone="warn"
            size="sm"
            title={t('remote.tailscale.missing.title')}
            action={
              <div className="form-actions">
                <a className="btn btn-primary" href={TAILSCALE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
                  {t('remote.tailscale.missing.install')}
                  <ExternalLink {...ICON_SM} />
                </a>
                {recheck}
              </div>
            }
          >
            {t('remote.tailscale.missing.body')}
          </Empty>
        </div>
      </Card>
    );
  }

  const { state } = readiness;
  if (state === 'ready') return null;
  if (managed && (state === 'loggedOut' || state === 'stopped')) return <ManagedSignIn readiness={readiness} checking={checking} onRecheck={onRecheck} />;
  // Only the command that is the same everywhere Tailscale runs; how tailscaled is started is the system's
  const command = !managed && (state === 'loggedOut' || state === 'stopped') ? 'tailscale up' : null;
  const { signOut } = tailscaleActions({ enabled: true, managed, state });
  const link =
    state === 'httpsDisabled'
      ? { href: TAILSCALE_DNS_ADMIN_URL, label: t('remote.tailscale.openDns') }
      : state === 'unsupported'
        ? { href: TAILSCALE_DOWNLOAD_URL, label: t('remote.tailscale.update') }
        : null;
  return (
    <Card actions={<Tag tone="warn">{t(`remote.tailscale.tags.${state}`)}</Tag>}>
      <p className="small muted">{t('remote.intro')}</p>
      <div className="alert alert-warn" role="status" data-testid={`tunnel-tailscale-${state}`}>
        <TriangleAlert {...ICON} className="alert-icon" />
        <div className="alert-body">
          <strong>{t(`remote.tailscale.titles.${state}`)}</strong>
          {readiness.reason && <div className="small">{localized(readiness.reason)}</div>}
          {command && (
            <div className="small">
              {t('remote.tailscale.runThis')} <code className="mono">{command}</code>
            </div>
          )}
          {managed && state === 'daemonDown' && <div className="small">{t('remote.tailscale.managed.daemonDown')}</div>}
          <div className="form-actions">
            {link && (
              <a className="btn btn-small" href={link.href} target="_blank" rel="noreferrer">
                {link.label}
                <ExternalLink {...ICON_SM} />
              </a>
            )}
            {recheck}
            {signOut && <SignOutButton tool="tailscale" label="Tailscale" small />}
          </div>
        </div>
      </div>
      {readiness.version && <p className="small muted">{t('remote.tailscale.version', { version: readiness.version })}</p>}
    </Card>
  );
}

/**
 * The Tailscale Claudio runs is signed out: the card says so and offers Sign in, which opens the
 * shared panel inside it (a link to open on any device, or an auth key). It never asks for a link on
 * its own: a visit to the tab is not a sign-in.
 */
function ManagedSignIn({ readiness, checking, onRecheck }: { readiness: TailscaleReadiness; checking: boolean; onRecheck: () => void }) {
  const { t } = useTranslation('config');
  const [open, setOpen] = useState(false);
  const state = readiness.state === 'stopped' ? 'stopped' : 'loggedOut';
  return (
    <Card actions={<Tag tone="warn">{t(`remote.tailscale.tags.${state}`)}</Tag>}>
      <p className="small muted">{t('remote.intro')}</p>
      <div className="alert alert-warn" role="status" data-testid={`tunnel-tailscale-${state}`}>
        <TriangleAlert {...ICON} className="alert-icon" />
        <div className="alert-body">
          <strong>{t('remote.tailscale.managed.title')}</strong>
          <div className="small">{t('remote.tailscale.managed.body')}</div>
          {!open && (
            <div className="form-actions">
              <button type="button" className="btn btn-primary btn-small" data-testid="tunnel-sign-in" onClick={() => setOpen(true)}>
                {t('remote.tailscale.managed.signIn')}
              </button>
              <button type="button" className="btn btn-small" disabled={checking} onClick={onRecheck} data-testid="tunnel-recheck">
                {t('remote.tailscale.recheck')}
              </button>
            </div>
          )}
        </div>
      </div>
      {open && <SignInPanel tool="tailscale" label="Tailscale" layout="card" closable onClose={() => setOpen(false)} />}
      {readiness.version && <p className="small muted">{t('remote.tailscale.version', { version: readiness.version })}</p>}
    </Card>
  );
}

/** The live address: what the screen is about while the tunnel is open, so it takes the gradient border. */
function TunnelAddress({ url, since }: { url: string; since: string | null }) {
  const { t } = useTranslation('config');
  return (
    <div className="tunnel-address grad-border" data-testid="tunnel-address">
      <div className="tunnel-address-text">
        <span className="section-label">{t('remote.address.label')}</span>
        <div className="tunnel-address-url">
          <a className="mono break" href={url} target="_blank" rel="noreferrer" data-testid="tunnel-url">
            {url}
          </a>
          <CopyButton text={url} label={t('remote.address.copy')} />
        </div>
        {since && <span className="small muted">{t('remote.address.since', { time: timeAgo(since) })}</span>}
        <span className="small muted">{t('remote.address.scan')}</span>
      </div>
      <QrCode text={url} label={t('remote.address.qr', { url })} />
    </div>
  );
}
