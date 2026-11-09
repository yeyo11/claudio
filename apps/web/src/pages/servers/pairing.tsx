import type { ServerPairing } from '@claudio/shared';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ICON } from '@claudio/ui/components/icons';
import { Field, TabPanel, Tabs } from '@claudio/ui/components/ui';
import { ApiRequestError } from '../../api';
import { certificateIsFromAuthority, cleanCode, CODE_LENGTH, groupCode, groupFingerprint, sameFingerprint } from '../../lib/servers-model';

export type PairingWay = 'code' | 'token';

export interface PairingDraft {
  way: PairingWay;
  code: string;
  token: string;
}
export const emptyPairing: PairingDraft = { way: 'code', code: '', token: '' };

/** The pairing a draft stands for, or null while it is incomplete: a whole code, or any token */
export function pairingOf(draft: PairingDraft): ServerPairing | null {
  if (draft.way === 'code') {
    const code = cleanCode(draft.code);
    return code.length === CODE_LENGTH ? { kind: 'code', code } : null;
  }
  const token = draft.token.trim();
  return token ? { kind: 'token', token } : null;
}

/**
 * The two ways to pair, as tabs: the code the other Claudio shows (an address and eight characters)
 * and an owner token (for one with no screen). The addresses come from the dialog around it.
 */
export function PairingFields({ draft, onChange, group }: { draft: PairingDraft; onChange: (next: PairingDraft) => void; group: string }) {
  const { t } = useTranslation('serversPage');
  return (
    <div className="stack server-pairing">
      <Tabs<PairingWay>
        label={t('add.tabs')}
        group={group}
        value={draft.way}
        onChange={(way) => onChange({ ...draft, way })}
        tabs={[
          { id: 'code', label: t('add.tabCode') },
          { id: 'token', label: t('add.tabToken') },
        ]}
      />
      <TabPanel group={group} tab={draft.way} className="stack">
        {draft.way === 'code' ? (
          <>
            <p className="small muted">{t('add.codeIntro')}</p>
            <Field label={t('add.code')} hint={t('add.codeHint')}>
              <input
                className="mono server-code-input"
                value={groupCode(cleanCode(draft.code))}
                onChange={(e) => onChange({ ...draft, code: e.target.value })}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={CODE_LENGTH + 2}
                data-autofocus
                data-testid="server-code"
              />
            </Field>
          </>
        ) : (
          <>
            <p className="small muted">{t('add.tokenIntro')}</p>
            <Field label={t('add.token')} hint={t('add.tokenHint')}>
              <input
                className="mono"
                type="password"
                value={draft.token}
                onChange={(e) => onChange({ ...draft, token: e.target.value })}
                autoComplete="off"
                spellCheck={false}
                data-testid="server-token"
              />
            </Field>
          </>
        )}
      </TabPanel>
    </div>
  );
}

/**
 * D13: the certificate the address showed, before the token leaves this Claudio. The person compares
 * the groups with the other Claudio's local network card, or pastes that fingerprint to have it
 * compared here; a pasted one that differs blocks the pairing. A name a public authority signed
 * (Tailscale, a tunnel) will never match the card's, which the text says (D15).
 */
export function FingerprintConfirm({ fingerprint, address, typed, onTyped }: { fingerprint: string; address: string; typed: string; onTyped: (value: string) => void }) {
  const { t } = useTranslation('serversPage');
  const comparing = groupFingerprint(typed).length > 0;
  const matches = comparing && sameFingerprint(typed, fingerprint);
  return (
    <div className="stack" data-testid="server-confirm">
      <p>{t('confirm.body')}</p>
      <div className="server-fingerprint">
        <span className="field-label">{t('confirm.fingerprint')}</span>
        <code className="mono server-fingerprint-value" data-testid="server-fingerprint">
          {groupFingerprint(fingerprint).map((group, i) => (
            <span key={i}>{group}</span>
          ))}
        </code>
        <span className="small muted">
          {/* The address is a literal the machine reads, so it is mono like the groups above */}
          <Trans t={t} i18nKey="confirm.shownBy" values={{ address }} components={{ mono: <span className="mono" /> }} />
        </span>
      </div>
      {certificateIsFromAuthority(address) && (
        <div className="alert alert-warn" role="note" data-testid="server-confirm-authority">
          <TriangleAlert {...ICON} className="alert-icon" />
          <div className="alert-body small">{t('confirm.authority')}</div>
        </div>
      )}
      <Field label={t('confirm.typed')} hint={t('confirm.typedHint')}>
        <input className="mono" value={typed} onChange={(e) => onTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-invalid={(comparing && !matches) || undefined} data-testid="server-fingerprint-typed" />
      </Field>
      {comparing && (
        <p className={`server-compare ${matches ? 'tone-ok' : 'tone-bad'}`} role="status" data-testid="server-compare">
          {matches ? <CircleCheck {...ICON} /> : <TriangleAlert {...ICON} />}
          <span>{matches ? t('confirm.matches') : t('confirm.differs')}</span>
        </p>
      )}
    </div>
  );
}

/** Whether pairing may go on given what the person typed to compare: nothing typed, or the same certificate */
export const mayPair = (fingerprint: string, typed: string): boolean => groupFingerprint(typed).length === 0 || sameFingerprint(typed, fingerprint);

/** The certificate a `409 servers.confirm-fingerprint` carries, or null for any other failure */
export function seenCertificateOf(error: unknown): { fingerprint: string; address: string } | null {
  return error instanceof ApiRequestError && error.code === 'servers.confirm-fingerprint' ? (error.seenCertificate ?? null) : null;
}

export interface PairingFlow {
  /** The certificate waiting for the person's yes, once the first call was answered with it */
  confirming: { fingerprint: string; address: string } | null;
  typed: string;
  setTyped: (value: string) => void;
  error: unknown;
  pending: boolean;
  /** First call: a code goes through, a token may come back asking to confirm the certificate */
  start: (pairing: ServerPairing) => void;
  /** The yes: the same pairing again, carrying the fingerprint that was shown */
  confirm: () => void;
  back: () => void;
}

/**
 * The round trip of D13 for any dialog that pairs: `submit` is the call (add, or pair again), run
 * with the pairing; a token answered by `409 servers.confirm-fingerprint` is held until the person
 * confirms the certificate, and only then sent again with `expectedFingerprint`.
 */
export function usePairingFlow(submit: (pairing: ServerPairing) => Promise<unknown>, onDone: () => void): PairingFlow {
  const [confirming, setConfirming] = useState<PairingFlow['confirming']>(null);
  const [held, setHeld] = useState<ServerPairing | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const run = async (pairing: ServerPairing) => {
    setPending(true);
    setError(null);
    try {
      await submit(pairing);
      onDone();
    } catch (err) {
      const seen = pairing.kind === 'token' && pairing.expectedFingerprint === undefined ? seenCertificateOf(err) : null;
      if (seen) {
        setHeld(pairing);
        setConfirming(seen);
      } else setError(err);
    } finally {
      setPending(false);
    }
  };

  return {
    confirming,
    typed,
    setTyped,
    error,
    pending,
    start: (pairing) => void run(pairing),
    confirm: () => {
      if (held?.kind === 'token' && confirming) void run({ ...held, expectedFingerprint: confirming.fingerprint });
    },
    back: () => {
      setConfirming(null);
      setHeld(null);
      setTyped('');
      setError(null);
    },
  };
}
