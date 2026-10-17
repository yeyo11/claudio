import type { CodeHostId, CodeHostsSettings, CodeHostStatus, TrackerId, TrackersSettings, TrackerStatus } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw, TerminalSquare } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { Sheet } from '@claudio/ui/components/controls';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { Empty, ErrorBox, Skeleton } from '@claudio/ui/components/ui';
import { keepsCredentials, trackerEntry, trackerWords, TRACKER_IDS, withTrackerEntry } from '../../lib/trackers';
import { timeAgo } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { BinaryEditor, ExternalLinkText, HostRow, LINKS, TrackerRow, trackerBinaryWords, trackerReasonText, WORKS } from './integrations/rows';
import { hostTool } from '../../lib/setup';
import { SignInPanel, SignInSheet } from '../../components/setup/SignInPanel';
import { SettingsSection } from './groups/Section';
import { sectionLabel } from './settingsGroups';
import { WebhooksSection } from './WebhooksSection';
import { YoutrackAccess } from './YoutrackAccess';

const entryOf = (settings: CodeHostsSettings, id: CodeHostId) => settings.hosts[id] ?? { enabled: true, binaryPath: null };

const latestCheck = (list: Array<{ checkedAt: string }>): string | null =>
  list.reduce<string | null>((latest, s) => (latest === null || s.checkedAt > latest ? s.checkedAt : latest), null);

/**
 * Settings → Connections → Code hosts, Trackers and Webhooks (docs/plans/settings-ia.md §6.3): the
 * code host CLIs Claudio reaches (gh, glab), each one's state in words, the host names it knows with
 * their accounts, and a binary of the person's own when the search cannot find one; then the issue
 * trackers and the webhooks. Three sections of one component, because the hosts and the trackers
 * are read and checked again together. Nothing is stored but the paths; the sessions are the
 * programs' own.
 */
export function IntegrationsTab() {
  const { t } = useTranslation(['integrations', 'config', 'webhooks']);
  const toast = useToast();
  const queryClient = useQueryClient();
  const narrow = useMediaQuery(NARROW);
  const hosts = useQuery({ queryKey: keys.hosts, queryFn: () => api.hosts() });
  const settings = useQuery({ queryKey: keys.hostSettings, queryFn: () => api.hostSettings() });
  const trackers = useQuery({ queryKey: keys.trackers, queryFn: () => api.trackers() });
  const trackerSettings = useQuery({ queryKey: keys.trackerSettings, queryFn: () => api.trackerSettings() });
  const projects = useQuery({ queryKey: keys.projects, queryFn: () => api.projects() });
  const refresh = useMutation({
    mutationFn: () => api.refreshHosts(),
    onSuccess: (fresh) => queryClient.setQueryData(keys.hosts, fresh),
  });
  // The trackers of GitHub and GitLab are read from their host's CLI, so both are read together
  const refreshTrackers = useMutation({
    mutationFn: () => api.refreshTrackers(),
    onSuccess: (fresh) => queryClient.setQueryData(keys.trackers, fresh),
  });
  const saveTrackers = useMutation({
    mutationFn: (next: TrackersSettings) => api.putTrackerSettings(next),
    onSuccess: (saved) => queryClient.setQueryData(keys.trackerSettings, saved),
    onError: (err) => toast.error(t('saveFailed'), err),
  });
  const save = useMutation({
    mutationFn: (next: CodeHostsSettings) => api.putHostSettings(next),
    onSuccess: (saved) => queryClient.setQueryData(keys.hostSettings, saved),
    onError: (err) => toast.error(t('saveFailed'), err),
  });
  // The row being read again: "all" after Check again, or the one whose binary was just chosen
  const [checking, setChecking] = useState<CodeHostId | 'all' | null>(null);
  const [binaryOf, setBinaryOf] = useState<CodeHostId | null>(null);
  const [trackerBinaryOf, setTrackerBinaryOf] = useState<TrackerId | null>(null);
  const [checkingTracker, setCheckingTracker] = useState<TrackerId | null>(null);
  // YouTrack's address and token, opened under its row (a sheet on a phone)
  const [accessOpen, setAccessOpen] = useState(false);
  // A code host's sign-in panel: the host it starts on (null: the CLI's default, '': one to name)
  const [signInOf, setSignInOf] = useState<{ id: CodeHostId; host: string | null } | null>(null);

  const failed = hosts.error ?? settings.error ?? trackers.error ?? trackerSettings.error;
  const sections = (codeHosts: ReactNode, trackerBody: ReactNode, rest?: ReactNode) => (
    <>
      <SettingsSection id="code-hosts" title={t(sectionLabel('code-hosts'))}>
        <p className="small muted">{t('section.hosts')}</p>
        {codeHosts}
      </SettingsSection>
      <SettingsSection id="trackers" title={t(sectionLabel('trackers'))}>
        <p className="small muted">{t('section.trackers')}</p>
        {trackerBody}
      </SettingsSection>
      <SettingsSection id="webhooks" title={t(sectionLabel('webhooks'))}>
        <p className="small muted">{t('webhooks:line')}</p>
        {projects.error ? <ErrorBox error={projects.error} /> : projects.data ? <WebhooksSection projects={projects.data} /> : <Skeleton rows={3} />}
      </SettingsSection>
      {rest}
    </>
  );
  if (failed) return sections(<ErrorBox error={failed} />, null);
  // The skeletons hold the height of the toolbar and the rows they wait for
  if (!hosts.data || !settings.data || !trackers.data || !trackerSettings.data) return sections(<Skeleton rows={3} height={20} />, <Skeleton rows={3} height={20} />);

  const list = hosts.data;
  const current = settings.data;
  const trackerList = TRACKER_IDS.map((id) => trackers.data.find((s) => s.id === id)).filter((s): s is TrackerStatus => s !== undefined);
  const currentTrackers = trackerSettings.data;
  const checkedAt = latestCheck([...list, ...trackerList]);
  const trackersReady = trackerList.filter((s) => trackerEntry(currentTrackers, s.id).enabled && s.state === 'ready').length;
  const openTracker = trackerBinaryOf ? trackerList.find((s) => s.id === trackerBinaryOf) : undefined;
  const ready = list.filter((s) => entryOf(current, s.id).enabled && s.state === 'ready').length;
  const nothing = list.length > 0 && list.every((s) => s.state === 'not-installed' && entryOf(current, s.id).binaryPath === null) && binaryOf === null;
  const open = binaryOf ? list.find((s) => s.id === binaryOf) : undefined;

  const recheck = async (scope: CodeHostId | 'all'): Promise<CodeHostStatus[] | null> => {
    setChecking(scope);
    try {
      const [fresh] = await Promise.all([refresh.mutateAsync(), refreshTrackers.mutateAsync()]);
      return fresh;
    } catch (err) {
      toast.error(t('refreshFailed'), err);
      return null;
    } finally {
      setChecking(null);
    }
  };

  /**
   * Point a CLI at a binary (or back at the PATH) and read it. A binary the detector rejects is not
   * kept: the previous choice is put back, so "Check and save" never leaves a broken program in
   * the settings.
   */
  const useBinary = async (id: CodeHostId, binaryPath: string | null): Promise<CodeHostStatus | null> => {
    const previous = entryOf(current, id);
    const withPath = (path: string | null): CodeHostsSettings => ({ hosts: { ...current.hosts, [id]: { ...previous, binaryPath: path } } });
    setChecking(id);
    try {
      await save.mutateAsync(withPath(binaryPath));
      const [fresh] = await Promise.all([refresh.mutateAsync(), refreshTrackers.mutateAsync()]);
      const found = fresh.find((s) => s.id === id) ?? null;
      if (binaryPath !== null && found && !WORKS.has(found.state)) {
        await save.mutateAsync(withPath(previous.binaryPath));
        // Awaited so "Not saved" shows once the row reads the program put back, never the refused one
        await Promise.all([refresh.mutateAsync(), refreshTrackers.mutateAsync()]).catch(() => undefined);
      }
      return found;
    } catch (err) {
      toast.error(t('refreshFailed'), err);
      return null;
    } finally {
      setChecking(null);
    }
  };

  /**
   * The same for a tracker: its own binary, or none, which reads the one of its host. A refused
   * path is put back, as for the hosts.
   */
  const useTrackerBinary = async (id: TrackerId, binaryPath: string | null): Promise<TrackerStatus | null> => {
    const previous = trackerEntry(currentTrackers, id);
    const withPath = (path: string | null): TrackersSettings => withTrackerEntry(currentTrackers, id, { ...previous, binaryPath: path });
    setCheckingTracker(id);
    try {
      await saveTrackers.mutateAsync(withPath(binaryPath));
      const fresh = await refreshTrackers.mutateAsync();
      const found = fresh.find((s) => s.id === id) ?? null;
      if (binaryPath !== null && found && !WORKS.has(found.state)) {
        await saveTrackers.mutateAsync(withPath(previous.binaryPath));
        await refreshTrackers.mutateAsync().catch(() => undefined);
      }
      return found;
    } catch (err) {
      toast.error(t('refreshFailed'), err);
      return null;
    } finally {
      setCheckingTracker(null);
    }
  };

  const toolbar = (
    <div className="prov-toolbar">
      <button type="button" className="btn btn-small" disabled={checking !== null} onClick={() => void recheck('all')}>
        {checking === 'all' ? <Spinner /> : <RefreshCw {...ICON_SM} />}
        {t('refresh')}
      </button>
      <span className="prov-checked tnum">{checkedAt ? t('checkedAgo', { time: timeAgo(checkedAt) }) : t('notChecked')}</span>
    </div>
  );

  const rows = list.map((status) => {
    const entry = entryOf(current, status.id);
    return (
      <HostRow
        key={status.id}
        status={status}
        enabled={entry.enabled}
        variant={narrow ? 'cell' : 'row'}
        setting={`code-hosts.${status.id}`}
        open={binaryOf === status.id || signInOf?.id === status.id}
        checking={checking === 'all' || checking === status.id}
        onRetry={() => void recheck(status.id)}
        onChooseBinary={() => {
          setTrackerBinaryOf(null);
          setSignInOf(null);
          setBinaryOf((now) => (now === status.id ? null : status.id));
        }}
        onSignIn={(host) => {
          setBinaryOf(null);
          setTrackerBinaryOf(null);
          setAccessOpen(false);
          setSignInOf((now) => (now?.id === status.id && now.host === host ? null : { id: status.id, host }));
        }}
        panel={
          !narrow && signInOf?.id === status.id ? (
            <SignInPanel key={`${status.id}:${signInOf.host ?? ''}`} tool={hostTool(status.id)} label={status.label} host={signInOf.host} onClose={() => setSignInOf(null)} />
          ) : !narrow && binaryOf === status.id ? (
            <BinaryEditor
              key={status.id}
              status={status}
              saved={entry.binaryPath}
              busy={checking === status.id}
              onUse={(path) => useBinary(status.id, path)}
              onDone={() => setBinaryOf(null)}
            />
          ) : null
        }
      />
    );
  });

  const trackerRows = trackerList.map((status) => {
    const entry = trackerEntry(currentTrackers, status.id);
    return (
      <TrackerRow
        key={status.id}
        status={status}
        enabled={entry.enabled}
        variant={narrow ? 'cell' : 'row'}
        setting={keepsCredentials(status.id) ? 'trackers.youtrack' : undefined}
        open={trackerBinaryOf === status.id || (accessOpen && keepsCredentials(status.id))}
        accessOpen={accessOpen && keepsCredentials(status.id)}
        checking={checking === 'all' || checkingTracker === status.id}
        onRetry={() => void recheck('all')}
        onChooseBinary={() => {
          setBinaryOf(null);
          setSignInOf(null);
          setAccessOpen(false);
          setTrackerBinaryOf((now) => (now === status.id ? null : status.id));
        }}
        onConnect={() => {
          setBinaryOf(null);
          setSignInOf(null);
          setTrackerBinaryOf(null);
          setAccessOpen((now) => !now);
        }}
        panel={
          !narrow && accessOpen && keepsCredentials(status.id) ? (
            <YoutrackAccess onDone={() => setAccessOpen(false)} reasonOf={(fresh, address) => trackerReasonText(t, fresh, address)} />
          ) : !narrow && trackerBinaryOf === status.id ? (
            <BinaryEditor
              key={status.id}
              status={status}
              saved={entry.binaryPath}
              busy={checkingTracker === status.id}
              words={trackerBinaryWords(t, status)}
              onUse={(path) => useTrackerBinary(status.id, path)}
              onDone={() => setTrackerBinaryOf(null)}
            />
          ) : null
        }
      />
    );
  });

  // The gradient border goes on what the screen is about: the trackers, unless the empty state has it
  const trackersBody = (
    <>
      <p className="prov-summary tnum">
        {t('tracker.total', { count: trackerList.length })} · {t('list.ready', { count: trackersReady })}
      </p>
      <section className={`card${nothing ? '' : ' grad-border'} prov-card`} aria-label={t('tracker.title')}>
        {trackerRows}
      </section>
    </>
  );

  const missing = (
    <p className="prov-step-note host-missing">
      {t('missing.text')}
      <ExternalLinkText href={LINKS.github.signIn} label={t('missing.link')} />
    </p>
  );

  // A section beside others keeps the compact empty state: the illustrated one is for a whole screen
  const hostsBody = nothing ? (
    <div className="card grad-border prov-card">
      <Empty
        icon={TerminalSquare}
        title={t('empty.title')}
        action={
          <>
            <a className="btn btn-primary" href={LINKS.github.install} target="_blank" rel="noopener noreferrer">
              {t('empty.install')}
              <ExternalLink {...ICON_SM} />
              <span className="sr-only"> ({t('row.opensNewTab')})</span>
            </a>
            <button type="button" className="btn" disabled={checking !== null} onClick={() => void recheck('all')}>
              {t('refresh')}
            </button>
          </>
        }
      >
        {t('empty.body')}
      </Empty>
      <div className="host-also">
        <span className="section-label">{t('empty.also')}</span>
        <div className="host-also-chips">
          <a className="chip" href={LINKS.gitlab.install} target="_blank" rel="noopener noreferrer">
            {t('empty.installGlab')}
            <span className="sr-only"> ({t('row.opensNewTab')})</span>
          </a>
          <button type="button" className="chip" onClick={() => setBinaryOf(list[0]?.id ?? null)}>
            {t('empty.chooseBinary')}
          </button>
        </div>
      </div>
    </div>
  ) : (
    <>
      <p className="prov-summary tnum">
        {t('list.total', { count: list.length })} · {t('list.ready', { count: ready })}
      </p>
      <section className="card prov-card" aria-label={t('list.aria')}>
        {rows}
      </section>
    </>
  );

  return sections(
    <>
      {toolbar}
      {hostsBody}
      {missing}
    </>,
    trackersBody,
    <>
      {narrow && signInOf && (
        <SignInSheet
          key={`${signInOf.id}:${signInOf.host ?? ''}`}
          tool={hostTool(signInOf.id)}
          label={list.find((s) => s.id === signInOf.id)?.label ?? signInOf.id}
          host={signInOf.host}
          onClose={() => setSignInOf(null)}
        />
      )}
      {narrow && accessOpen && (
        <Sheet open onOpenChange={(next) => !next && setAccessOpen(false)} title={t('tracker.credentials.title')} className="prov-sheet">
          <YoutrackAccess sheet onDone={() => setAccessOpen(false)} reasonOf={(fresh, address) => trackerReasonText(t, fresh, address)} />
        </Sheet>
      )}
      {narrow && openTracker && (
        <Sheet open onOpenChange={(next) => !next && setTrackerBinaryOf(null)} title={t('tracker.bin.title', { cli: openTracker.cli, tracker: trackerWords(openTracker.id).label })} className="prov-sheet">
          <BinaryEditor
            key={openTracker.id}
            status={openTracker}
            saved={trackerEntry(currentTrackers, openTracker.id).binaryPath}
            busy={checkingTracker === openTracker.id}
            words={trackerBinaryWords(t, openTracker)}
            onUse={(path) => useTrackerBinary(openTracker.id, path)}
            onDone={() => setTrackerBinaryOf(null)}
            sheet
          />
        </Sheet>
      )}
      {narrow && open && (
        <Sheet open onOpenChange={(next) => !next && setBinaryOf(null)} title={t('bin.title', { cli: open.cli })} className="prov-sheet">
          <BinaryEditor
            key={open.id}
            status={open}
            saved={entryOf(current, open.id).binaryPath}
            busy={checking === open.id}
            onUse={(path) => useBinary(open.id, path)}
            onDone={() => setBinaryOf(null)}
            sheet
          />
        </Sheet>
      )}
    </>,
  );
}
