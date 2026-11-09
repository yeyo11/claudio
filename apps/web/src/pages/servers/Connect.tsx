import type { ServerLink, ServerLinkCode } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { api, ApiRequestError, keys } from '../../api';
import type { AuthConfig } from '@claudio/shared';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { useToast } from '@claudio/ui/components/Toast';
import { Card, CopyButton, ErrorBox } from '@claudio/ui/components/ui';
import { formatDuration, timeAgo } from '@claudio/ui/lib/format';
import { serversApi, useServerLinks, useServersMutation } from '../../lib/api/servers';
import { groupCode, secondsLeft } from '../../lib/servers-model';
import { LanFingerprint } from '../config/RemoteAccessTab';
import { settingsHref } from '../config/settingsGroups';

/**
 * Whether this Claudio asks for no sign-in: another Claudio can only connect to one that does (the
 * pairing routes answer 409/403 otherwise). Undefined until the auth mode is read, so nothing that
 * depends on it is asked or drawn on a guess.
 */
function useOpenAccess(): boolean | undefined {
  const auth = useQuery({ queryKey: keys.securityAuth, queryFn: ({ signal }) => api.securityAuth({ signal }) });
  const mode = (auth.data as AuthConfig | undefined)?.mode;
  return mode === undefined ? undefined : mode === 'none';
}

/** Why nothing can connect yet, with the way to the setting that changes it */
function OpenAccessNote() {
  const { t } = useTranslation('serversPage');
  return (
    <div className="server-open-access" role="status" data-testid="server-link-auth-required">
      <p className="small muted">{t('connect.authRequired')}</p>
      <Link className="btn btn-small" to={settingsHref('access', { section: 'access' })}>
        {t('connect.toAccess')}
      </Link>
    </div>
  );
}

/** The code as shown: mono, large, in two groups of four, with its countdown and what to do when it ends */
export function CodeView({ code, now, onNew, pending }: { code: ServerLinkCode; now: number; onNew: () => void; pending: boolean }) {
  const { t } = useTranslation('serversPage');
  const left = secondsLeft(code.expiresAt, now);
  const expired = left === 0;
  return (
    <div className="server-code" data-testid="server-link-code">
      <span className="field-label">{t('connect.code')}</span>
      <div className="server-code-row">
        <code className={`mono server-code-value ${expired ? 'is-expired' : ''}`} data-testid="server-link-code-value">
          {groupCode(code.code)}
        </code>
        {!expired && <CopyButton text={code.code} label={t('connect.code')} />}
      </div>
      <p className="small muted tnum" data-testid="server-link-countdown">
        {expired ? t('connect.expired') : t('connect.expires', { time: formatDuration(left * 1000) })}
      </p>
      <p className="small muted">{t('connect.once')}</p>
      <div className="form-actions">
        <button type="button" className="btn btn-small" onClick={onNew} disabled={pending} data-testid="server-link-new">
          {t('connect.new')}
        </button>
      </div>
    </div>
  );
}

/**
 * "Let another Claudio connect to this one" (plan §12.1): every Claudio is the hub of itself, so this
 * is where a remote is prepared. A one-time code with its countdown, and below it the fingerprint of
 * this Claudio's certificate for the other side to compare when it pairs with a token.
 */
export function ConnectCard() {
  const { t } = useTranslation('serversPage');
  const open = useOpenAccess();
  const [code, setCode] = useState<ServerLinkCode | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const make = useServersMutation(() => serversApi.linkCode());
  const lan = useQuery({ queryKey: keys.lan, queryFn: ({ signal }) => api.lan({ signal }) });
  const fingerprint = lan.data?.fingerprint ?? null;

  // A countdown is the only clock here, and it stops with the code
  useEffect(() => {
    if (!code || secondsLeft(code.expiresAt, Date.now()) === 0) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [code]);

  const ask = () =>
    make.mutate(undefined, {
      onSuccess: (made) => {
        setNow(Date.now());
        setCode(made);
      },
    });
  const needsSignIn = make.error instanceof ApiRequestError && make.error.code === 'server-links.auth-required';

  // While nothing can connect, the card says why and where to change it, and nothing else: no
  // button that would be refused, no fingerprint to compare for a pairing that cannot happen
  return (
    <Card title={t('connect.title')} className="server-connect">
      <p className="small muted">{t('connect.body')}</p>
      {open === undefined ? null : open || needsSignIn ? (
        <OpenAccessNote />
      ) : (
        <>
          {code ? (
            <CodeView code={code} now={now} onNew={ask} pending={make.isPending} />
          ) : (
            <div className="form-actions">
              <button type="button" className="btn" onClick={ask} disabled={make.isPending} data-testid="server-link-show">
                {t('connect.show')}
              </button>
            </div>
          )}
          {make.error ? <ErrorBox error={make.error} title={t('connect.failed')} /> : null}
          {fingerprint ? <LanFingerprint fingerprint={fingerprint} /> : lan.data && <p className="small muted" data-testid="server-link-no-fingerprint">{t('connect.noFingerprint')}</p>}
        </>
      )}
    </Card>
  );
}

/** One hub holding a token of this Claudio: its name, when it paired and last used it, and Revoke */
export function HubRow({ link, busy, onRevoke }: { link: ServerLink; busy: boolean; onRevoke: (link: ServerLink) => void }) {
  const { t } = useTranslation('serversPage');
  return (
    <li className="server-hub" data-testid="server-hub">
      <div className="server-hub-main">
        <span className="server-hub-name">{link.hubName}</span>
        <span className="small muted">
          {t('hubs.created', { when: timeAgo(link.createdAt) })} · {link.lastUsedAt ? t('hubs.lastUsed', { when: timeAgo(link.lastUsedAt) }) : t('hubs.neverUsed')}
        </span>
      </div>
      <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => onRevoke(link)} data-testid="server-hub-revoke">
        {t('hubs.revoke')}
      </button>
    </li>
  );
}

/** The list inside the card, drawn from data */
export function HubsList({ links, busy, onRevoke }: { links: readonly ServerLink[]; busy: boolean; onRevoke: (link: ServerLink) => void }) {
  const { t } = useTranslation('serversPage');
  // One quiet line: an empty list in a card among others is not a state that needs a picture
  if (links.length === 0) return <p className="small muted" data-testid="server-hubs-none">{t('hubs.none')}</p>;
  return (
    <ul className="server-hubs" data-testid="server-hubs">
      {links.map((link) => (
        <HubRow key={link.tokenId} link={link} busy={busy} onRevoke={onRevoke} />
      ))}
    </ul>
  );
}

/** Connected hubs (D14): who may drive this Claudio, with Revoke; the secret is never shown */
export function HubsCard() {
  const { t } = useTranslation('serversPage');
  const toast = useToast();
  const confirm = useConfirm();
  const open = useOpenAccess();
  // Not asked while nobody can connect, nor before that is known: the route refuses it, and a
  // refusal here would read as a fault
  const links = useServerLinks(open === false);
  const refused = links.error instanceof ApiRequestError && links.error.status === 403;
  const revoke = useServersMutation((link: ServerLink) => serversApi.revokeLink(link.tokenId));

  const ask = (link: ServerLink) =>
    void confirm({ title: t('hubs.revokeTitle', { name: link.hubName }), body: t('hubs.revokeBody', { name: link.hubName }), confirmLabel: t('hubs.revoke'), danger: true }).then((ok) => {
      if (ok) revoke.mutate(link, { onSuccess: () => toast.success(t('hubs.revoked', { name: link.hubName })), onError: (err) => toast.error(t('hubs.revokeFailed', { name: link.hubName }), err) });
    });

  // A Claudio nobody can connect to has no hubs to list: the card above already says why
  if (open !== false) return null;
  return (
    <Card title={t('hubs.title')} className="server-hubs-card">
      {refused ? <p className="small muted" data-testid="server-hubs-unavailable">{t('hubs.notOwner')}</p> : null}
      {links.error && !refused ? <ErrorBox error={links.error} title={t('hubs.failed')} /> : null}
      {links.data && <HubsList links={links.data} busy={revoke.isPending} onRevoke={ask} />}
    </Card>
  );
}
