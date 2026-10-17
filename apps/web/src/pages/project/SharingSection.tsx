import type { Project, ProjectSharing, UpdateProjectSharingRequest } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ApiRequestError } from '../../api';
import { Select, Switch } from '@claudio/ui/components/controls';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox, Skeleton, Tag } from '@claudio/ui/components/ui';
import { collaboratorsApi, collaboratorsKeys, useCollaboratorsStatus } from './shared-data';

/** What `PUT /projects/:id/sharing` accepts for an edited key (§3.4): lower case, no spaces. */
export const SHARE_KEY_RE = /^[a-z0-9._/#-]{3,200}$/;

/**
 * The project's Sharing section, in its Settings view (§5.2): which groups see it, what goes with
 * it, the warning that what was sent cannot be taken back, and the share key a teammate's project
 * has to carry for the two to meet. Each switch is saved at once; the key is edited in place.
 */
export function SharingSection({ project }: { project: Project }) {
  const { t } = useTranslation(['collaborators', 'common']);
  const status = useCollaboratorsStatus().data;
  const on = Boolean(status?.settings.enabled && !status.unavailable);
  if (!status) return null;
  return (
    <section className="settings-cells-group project-sharing" aria-labelledby="project-sharing-title">
      <h2 id="project-sharing-title" className="section-label settings-cells-label">
        {t('sharing.title')}
      </h2>
      {on ? (
        <SharingSettings project={project} />
      ) : (
        <div className="card settings-cells">
          <div className="settings-cell">
            <span className="settings-cell-name small muted">{status.unavailable ? t('sharing.unavailable') : t('sharing.off')}</span>
            {!status.unavailable && (
              <Link to="/collaborators" className="btn btn-small">
                {t('sharing.openCollaborators')}
              </Link>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function SharingSettings({ project }: { project: Project }) {
  const { t } = useTranslation(['collaborators', 'common']);
  const qc = useQueryClient();
  const toast = useToast();
  const groups = useQuery({ queryKey: collaboratorsKeys.groups, queryFn: ({ signal }) => collaboratorsApi.groups({ signal }) });
  const sharing = useQuery({ queryKey: collaboratorsKeys.sharing(project.id), queryFn: ({ signal }) => collaboratorsApi.sharing(project.id, { signal }) });
  const save = useMutation({
    mutationFn: (body: UpdateProjectSharingRequest) => collaboratorsApi.putSharing(project.id, body),
    onSuccess: (saved) => {
      qc.setQueryData(collaboratorsKeys.sharing(project.id), saved);
      void qc.invalidateQueries({ queryKey: collaboratorsKeys.catalog });
    },
    // A key another project already shares is not a failure to report: the section says so in place
    onError: (error) => {
      if (error instanceof ApiRequestError && error.status === 409) void sharing.refetch();
      else toast.error(t('sharing.saveFailed'), error);
    },
  });

  if (sharing.error || groups.error) return <ErrorBox error={sharing.error ?? groups.error} />;
  if (!sharing.data || !groups.data) return <Skeleton rows={3} height={18} />;
  const current = sharing.data;
  const blocked = current.keyInUse !== null;

  const toggle = (groupId: string, share: boolean) =>
    save.mutate({ groups: share ? [...current.groups.filter((id) => id !== groupId), groupId] : current.groups.filter((id) => id !== groupId) });

  return (
    <>
      <div className="card settings-cells">
        {groups.data.groups.length === 0 ? (
          <div className="settings-cell">
            <span className="settings-cell-name small muted">{t('sharing.noGroups')}</span>
            <Link to="/collaborators" className="btn btn-small">
              {t('sharing.openCollaborators')}
            </Link>
          </div>
        ) : (
          groups.data.groups.map((group) => (
            <div key={group.id} className="settings-cell">
              <Switch
                checked={!blocked && current.groups.includes(group.id)}
                disabled={save.isPending || blocked}
                tooltip={blocked ? t('sharing.keyInUse', { project: current.keyInUse?.projectName }) : undefined}
                onChange={(checked) => toggle(group.id, checked)}
              >
                <span className="settings-cell-name">{t('sharing.shareWith', { group: group.name })}</span>
              </Switch>
            </div>
          ))
        )}
      </div>

      <div className="alert alert-warn" role="note">
        <TriangleAlert {...ICON} className="alert-icon" />
        <div className="alert-body">{t('sharing.warning')}</div>
      </div>

      <div className="card stack">
        <ShareKey project={project} sharing={current} saving={save.isPending} onSave={(body) => save.mutate(body)} />
        {/* The sharer's flag travels with the share: the reading install honours it */}
        <div className="stack-tight">
          <Switch checked={current.agentsMayRead} disabled={save.isPending} onChange={(agentsMayRead) => save.mutate({ agentsMayRead })}>
            <span className="settings-cell-name">{t('sharing.agentsMayRead')}</span>
          </Switch>
          <span className="field-hint">{t('sharing.agentsMayReadHint')}</span>
        </div>
        <div className="stack-tight">
          <span className="section-label">{t('sharing.included')}</span>
          <div className="inline-form">
            {current.kinds.map((kind) => (
              <Tag key={kind}>{t(`sharing.kinds.${kind}`)}</Tag>
            ))}
          </div>
        </div>
        <div className="stack-tight">
          <span className="section-label">{t('sharing.seenAs')}</span>
          <span className="mono small break">{current.seenAs.remote ? `${current.seenAs.name} · ${current.seenAs.remote}` : current.seenAs.name}</span>
        </div>
      </div>

      {/* The reader's side: what teammates share into this project, read by its own chats */}
      <div className="card settings-cells">
        <div className="settings-cell">
          <Switch checked={current.agentReads} disabled={save.isPending} onChange={(agentReads) => save.mutate({ agentReads })}>
            <span className="settings-cell-name">{t('sharing.agentReads')}</span>
          </Switch>
        </div>
        <div className="settings-cell">
          <span className="settings-cell-name small muted">{t('sharing.agentReadsHint')}</span>
        </div>
      </div>
    </>
  );
}

/**
 * The key, in mono, with where it came from: the remote (and a `Select` when the repository has
 * several), or the project's own id when there is none. Edit turns it into a field; a key another
 * project of this install shares already is named in a `warn` line, and sharing waits for an edit.
 */
function ShareKey({ project, sharing, saving, onSave }: { project: Project; sharing: ProjectSharing; saving: boolean; onSave: (body: UpdateProjectSharingRequest) => void }) {
  const { t } = useTranslation(['collaborators', 'common']);
  const [draft, setDraft] = useState<string | null>(null);
  const valid = draft !== null && SHARE_KEY_RE.test(draft);
  const submit = () => {
    if (!valid) return;
    if (draft !== sharing.shareKey) onSave({ shareKey: draft });
    setDraft(null);
  };
  return (
    <div className="stack-tight">
      <span className="section-label">{t('sharing.key')}</span>
      {draft === null ? (
        <div className="inline-form">
          <span className="mono break">{sharing.shareKey}</span>
          {sharing.edited && <Tag>{t('sharing.edited')}</Tag>}
          <button type="button" className="btn btn-small" disabled={saving} onClick={() => setDraft(sharing.shareKey)}>
            <Pencil {...ICON_SM} />
            {t('sharing.edit')}
          </button>
          {sharing.edited && (
            <button type="button" className="link-btn small" disabled={saving} onClick={() => onSave({ shareKey: sharing.defaultShareKey })}>
              {t('sharing.useDefault')}
            </button>
          )}
        </div>
      ) : (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            autoFocus
            className={`mono grow ${valid ? '' : 'is-invalid'}`.trim()}
            value={draft}
            aria-label={t('sharing.key')}
            aria-invalid={!valid}
            spellCheck={false}
            autoCapitalize="off"
            onChange={(event) => setDraft(event.target.value.trim())}
            onKeyDown={(event) => event.key === 'Escape' && setDraft(null)}
          />
          <button type="submit" className="btn btn-small" disabled={!valid || saving}>
            {t('sharing.save')}
          </button>
          <button type="button" className="btn btn-small btn-quiet" onClick={() => setDraft(null)}>
            {t('common:actions.cancel')}
          </button>
        </form>
      )}
      {draft !== null && !valid && <span className="field-hint text-err">{t('sharing.keyRule')}</span>}
      <span className="field-hint">{sharing.remote ? t('sharing.fromRemote', { remote: sharing.remote }) : t('sharing.noRemote')}</span>
      {sharing.remotes.length > 1 && (
        <Select
          aria-label={t('sharing.remote')}
          value={sharing.remote ?? ''}
          disabled={saving}
          options={sharing.remotes.map((remote) => ({ value: remote.name, label: remote.name, hint: <span className="mono">{remote.shareKey}</span> }))}
          onChange={(remote) => onSave({ remote })}
        />
      )}
      {sharing.keyInUse && (
        <div className="alert alert-warn" role="alert">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body">
            {t('sharing.keyInUse', { project: sharing.keyInUse.projectId === project.id ? project.name : sharing.keyInUse.projectName })}
          </div>
        </div>
      )}
    </div>
  );
}
