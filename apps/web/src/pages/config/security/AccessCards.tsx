import type { AuthConfig, AuthMode, OidcConfig } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../../api';
import { Switch } from '@claudio/ui/components/controls';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { useToast } from '@claudio/ui/components/Toast';
import { Field, Segmented, Tag } from '@claudio/ui/components/ui';
import { getToken } from '../../../lib/auth';
import { SaveButton, SettingsBlock, SettingsReveal, SettingsRow } from '../groups/Block';
import { OwnTokenForm, RevealedToken, useTokenActions } from './token';

const MODES: AuthMode[] = ['none', 'token', 'oidc'];
const NO_OIDC: OidcConfig = { issuer: '', audience: '', clientId: '' };

function useAuthUpdate() {
  const { t } = useTranslation('config');
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: api.updateSecurityAuth,
    onSuccess: (config) => {
      queryClient.setQueryData(keys.securityAuth, config);
      void queryClient.invalidateQueries({ queryKey: ['security', 'audit'] });
    },
    onError: (err) => toast.error(t('security.saveFailed'), err),
  });
}

/** Read-only: a switch whose consequence says, live, what it does to everyone holding access. */
export function ReadOnlyCard({ auth }: { auth: AuthConfig }) {
  const { t } = useTranslation('config');
  const toast = useToast();
  const update = useAuthUpdate();

  return (
    <SettingsBlock
      title={t('security.readOnly.title')}
      setting="access.read-only"
      status={auth.readOnly ? <Tag tone="warn">{t('security.readOnly.on')}</Tag> : <Tag>{t('security.readOnly.off')}</Tag>}
    >
      <SettingsRow>
        <Switch
          checked={auth.readOnly}
          disabled={update.isPending}
          onChange={(readOnly) =>
            update.mutate({ readOnly }, { onSuccess: () => toast.success(readOnly ? t('security.readOnly.enabled') : t('security.readOnly.disabled')) })
          }
        >
          {t('security.readOnly.label')}
        </Switch>
        <p className="small muted">{auth.readOnly ? t('security.readOnly.consequenceOn') : t('security.readOnly.consequenceOff')}</p>
      </SettingsRow>
      <SettingsReveal open={auth.readOnly}>
        <p className="small muted">{t('security.readOnly.note')}</p>
      </SettingsReveal>
    </SettingsBlock>
  );
}

/** The mode a request must satisfy: the primary control of Access & safety. */
export function AccessCard({ auth }: { auth: AuthConfig }) {
  const { t } = useTranslation('config');
  const toast = useToast();
  const confirm = useConfirm();
  const update = useAuthUpdate();
  const [mode, setMode] = useState<AuthMode>(auth.mode);
  const [oidc, setOidc] = useState<OidcConfig>(auth.oidc ?? NO_OIDC);

  const oidcComplete = oidc.issuer.trim() !== '' && oidc.audience.trim() !== '';
  const oidcChanged = JSON.stringify(auth.oidc ?? NO_OIDC) !== JSON.stringify(oidc);
  // What the server would refuse: named up front instead of after the click
  const missing = mode === 'token' && !auth.tokenSet ? 'token' : mode === 'oidc' && !oidcComplete ? 'oidc' : null;
  const dirty = mode !== auth.mode || (mode === 'oidc' && oidcChanged);

  async function save() {
    if (missing) return;
    // Switching the guard on ends this browser's access unless it holds what the new mode wants
    if (mode !== auth.mode && mode !== 'none') {
      const ok = await confirm({
        title: t(`security.access.confirm.${mode}.title`),
        body: mode === 'token' && !getToken() ? t('security.access.confirm.token.noStoredToken') : t(`security.access.confirm.${mode}.body`),
        confirmLabel: t('security.access.confirm.action'),
      });
      if (!ok) return;
    }
    const cleaned: OidcConfig = { issuer: oidc.issuer.trim(), audience: oidc.audience.trim(), clientId: oidc.clientId.trim() };
    update.mutate({ mode, ...(mode === 'oidc' ? { oidc: cleaned } : {}) }, { onSuccess: () => toast.success(t('security.access.saved')) });
  }

  return (
    <SettingsBlock
      title={t('security.access.modeLabel')}
      setting="access.mode"
      status={<Tag tone={auth.mode === 'none' ? 'warn' : 'ok'}>{t(`security.access.modes.${auth.mode}.tag`)}</Tag>}
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <p className="small muted">{t('security.access.intro')}</p>
        <SettingsRow>
          <Segmented
            label={t('security.access.modeLabel')}
            value={mode}
            onChange={setMode}
            options={MODES.map((value) => ({ value, label: t(`security.access.modes.${value}.label`) }))}
          />
          {/* The three modes' lines are of a length: two lines kept for each, so a choice moves nothing */}
          <p className="small muted settings-consequence-2">{t(`security.access.modes.${mode}.body`)}</p>
        </SettingsRow>

        <SettingsReveal open={mode === 'oidc'}>
          <div className="form-grid form-grid-3">
            <Field label={t('security.access.issuer')} hint={t('security.access.issuerHint')}>
              <input
                type="url"
                autoComplete="off"
                placeholder="https://login.example.com/realms/claudio"
                value={oidc.issuer}
                onChange={(e) => setOidc({ ...oidc, issuer: e.target.value })}
              />
            </Field>
            <Field label={t('security.access.audience')} hint={t('security.access.audienceHint')}>
              <input type="text" autoComplete="off" placeholder="claudio" value={oidc.audience} onChange={(e) => setOidc({ ...oidc, audience: e.target.value })} />
            </Field>
            <Field label={t('security.access.clientId')} hint={t('security.access.clientIdHint')}>
              <input type="text" autoComplete="off" value={oidc.clientId} onChange={(e) => setOidc({ ...oidc, clientId: e.target.value })} />
            </Field>
          </div>
          <p className="small muted">{t('security.access.oidcNoLogin')}</p>
        </SettingsReveal>

        <SettingsReveal open={missing !== null}>
          <div className="alert alert-warn" role="status">
            <div className="alert-body">{missing && t(`security.access.missing.${missing}`)}</div>
          </div>
        </SettingsReveal>
        <div className="form-actions">
          <SaveButton label={t('security.access.save')} savingLabel={t('shared.saving')} dirty={dirty} pending={update.isPending} disabled={Boolean(missing)} />
          <button
            type="button"
            className="btn"
            disabled={!dirty || update.isPending}
            onClick={() => {
              setMode(auth.mode);
              setOidc(auth.oidc ?? NO_OIDC);
            }}
          >
            {t('shared.discard')}
          </button>
        </div>
      </form>
    </SettingsBlock>
  );
}

export function TokenCard({ auth }: { auth: AuthConfig }) {
  const { t } = useTranslation(['config', 'common']);
  const confirm = useConfirm();
  const { set, clear, generate, busy } = useTokenActions(auth);
  const [own, setOwn] = useState(false);

  return (
    <SettingsBlock
      title={t('config:security.token.title')}
      setting="access.token"
      status={auth.tokenSet ? <Tag tone="ok">{t('config:security.token.set')}</Tag> : <Tag>{t('config:security.token.notSet')}</Tag>}
    >
      <p className="small muted">{t('config:security.token.intro')}</p>
      <p className="small muted">{t('config:security.token.recovery', { token: 'CLAUDIO_AUTH_TOKEN', reset: 'CLAUDIO_AUTH_TOKEN_RESET' })}</p>

      <RevealedToken />

      <div className="form-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void generate()}>
          {auth.tokenSet ? t('config:security.token.rotate') : t('config:security.token.generate')}
        </button>
        <button type="button" className="btn" disabled={busy || own} onClick={() => setOwn(true)}>
          {t('config:security.token.own')}
        </button>
        {auth.tokenSet && (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || auth.mode === 'token'}
            onClick={() => {
              void confirm({
                title: t('config:security.token.removeConfirm.title'),
                body: t('config:security.token.removeConfirm.body'),
                confirmLabel: t('config:security.token.remove'),
                danger: true,
              }).then((ok) => ok && clear.mutate());
            }}
          >
            {t('config:security.token.remove')}
          </button>
        )}
      </div>
      {auth.tokenSet && auth.mode === 'token' && <p className="small muted">{t('config:security.token.removeBlocked')}</p>}

      {own && <OwnTokenForm busy={busy} onSave={(token) => set.mutate(token, { onSuccess: () => setOwn(false) })} onCancel={() => setOwn(false)} />}
    </SettingsBlock>
  );
}
