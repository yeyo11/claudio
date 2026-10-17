import type { Health, HealthSignal, SupervisorProposal } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleSlash, Clock, Lightbulb, Pencil, Repeat, Send, TriangleAlert, OctagonX, X, type LucideIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api';
import { cancellable, healthWord, type HealthWord } from '../../lib/observe';
import i18n from '../../i18n';
import { healthReason, shownParams, signalHint, signalReason } from '../../lib/server-strings';
import { Collapsible } from '@claudio/ui/components/controls/Collapsible';
import { FullText } from '@claudio/ui/components/FullText';
import { formatCost, shortPath, timeAgo } from '@claudio/ui/lib/format';
import { ClampText } from '../ClampText';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { DecisionMark } from '../DecisionMark';
import { useConfirm } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { useToast } from '@claudio/ui/components/Toast';
import { CopyButton, ErrorBox, Field } from '@claudio/ui/components/ui';

const TONE: Record<HealthWord, string> = { ok: 'ok', slow: 'warn', stuck: 'bad', looping: 'bad' };
// A shape per word besides the colour and the text: it still reads in greyscale
const ICON: Record<HealthWord, LucideIcon> = { ok: CircleCheck, slow: Clock, stuck: OctagonX, looping: Repeat };

/**
 * ok, slow, stuck or looping: said in words and with a shape, the reason one hover away. A hint the
 * supervisor proposed and nobody has judged yet is part of the badge, since it is what to act on.
 */
export function HealthBadge({ health }: { health: Pick<Health, 'level' | 'signals' | 'reason' | 'proposal'> }) {
  const { t } = useTranslation('observe');
  const word = healthWord(health);
  const Icon = ICON[word];
  const proposed = health.proposal?.status === 'proposed';
  return (
    <Tooltip content={proposed ? `${healthReason(health)} ${t('supervisor.badgeHint')}` : healthReason(health)}>
      <span className={`badge badge-${TONE[word]}`}>
        <Icon size={12} strokeWidth={2} aria-hidden />
        {t(`health.word.${word}`)}
        {proposed && (
          <>
            <Lightbulb size={12} strokeWidth={2} aria-hidden />
            <span className="sr-only">{t('supervisor.badgeHint')}</span>
          </>
        )}
      </span>
    </Tooltip>
  );
}

/**
 * What the supervisor proposed for the worst signal. Send delivers it as written; Edit opens the
 * hint box with it, and a hint sent from there answers the proposal, so it is dismissed after it.
 */
function ProposalRow({
  proposal,
  live,
  sendHint,
  onChanged,
}: {
  proposal: SupervisorProposal;
  live: boolean;
  sendHint: (text: string) => Promise<unknown>;
  onChanged: () => void;
}) {
  const { t } = useTranslation(['observe', 'common']);
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const settle = useMutation({
    mutationFn: (action: 'send' | 'dismiss') => api.settleSupervisorProposal(proposal, action),
    onSuccess: (_result, action) => {
      if (action === 'send') toast.success(t('observe:health.hintSent'));
      onChanged();
    },
  });
  const sendEdited = async (text: string) => {
    await sendHint(text);
    // The hint reached the worker already; a proposal settled in the meantime is nothing to report
    await api.settleSupervisorProposal(proposal, 'dismiss').catch(() => undefined);
  };

  return (
    <div className="obs-proposal" role="group" aria-label={t('observe:supervisor.title')}>
      <div className="obs-signal-line">
        <Lightbulb {...ICON_SM} />
        <span className="strong">{t('observe:supervisor.proposes')}</span>
        <DecisionMark subjectKind="chat" subjectId={proposal.chatId} />
      </div>
      <ClampText text={proposal.hint} className="small obs-proposal-text" />
      {!editing && (
        <div className="task-actions">
          {live && (
            <button type="button" className="btn btn-small btn-primary" disabled={settle.isPending} onClick={() => settle.mutate('send')}>
              <Send {...ICON_SM} /> {t('observe:supervisor.send')}
            </button>
          )}
          {live && (
            <button type="button" className="btn btn-small" disabled={settle.isPending} onClick={() => setEditing(true)}>
              <Pencil {...ICON_SM} /> {t('observe:supervisor.edit')}
            </button>
          )}
          <button type="button" className="btn btn-small" disabled={settle.isPending} onClick={() => settle.mutate('dismiss')}>
            <X {...ICON_SM} /> {t('observe:supervisor.dismiss')}
          </button>
        </div>
      )}
      <ErrorBox error={settle.error} />
      {editing && (
        <HintBox
          initial={proposal.hint}
          send={sendEdited}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

/** The signals a person can do something about; the rest of a chat's facts stay in the side card. */
const STEP_IN = new Set<HealthSignal['kind']>(['hung-command', 'repeat-stall', 'no-progress', 'loop', 'weakened-test', 'silence', 'budget', 'guard-blocked', 'guard-missing']);

export const isStepIn = (signal: HealthSignal): boolean => STEP_IN.has(signal.kind);

function HintBox({ initial, send, onDone }: { initial: string; send: (text: string) => Promise<unknown>; onDone: () => void }) {
  const { t } = useTranslation(['observe', 'common']);
  const toast = useToast();
  const [text, setText] = useState(initial);
  const mutation = useMutation({
    mutationFn: () => send(text.trim()),
    onSuccess: () => {
      toast.success(t('observe:health.hintSent'));
      onDone();
    },
  });
  return (
    <form
      className="stack-tight obs-hint"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) mutation.mutate();
      }}
    >
      <Field label={t('observe:health.hintLabel')} hint={t('observe:health.hintExplained')}>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </Field>
      <ErrorBox error={mutation.error} />
      <div className="form-actions">
        <button type="submit" className="btn btn-small btn-primary" disabled={mutation.isPending || !text.trim()}>
          <Send {...ICON_SM} /> {mutation.isPending ? t('observe:health.sending') : t('observe:health.sendHint')}
        </button>
        <button type="button" className="btn btn-small" onClick={onDone} disabled={mutation.isPending}>
          {t('common:actions.cancel')}
        </button>
      </div>
    </form>
  );
}

// A signal's short line comes from a key per reason code, built from the same figures as the sentence
const tr = i18n.t.bind(i18n) as unknown as (key: string, options?: Record<string, string | number>) => string;

const LEVEL_ICON: Record<HealthSignal['level'], LucideIcon> = { warn: TriangleAlert, bad: OctagonX };

/** The figure that says how much: minutes, a count, a share or what was spent. */
function figureOf(signal: HealthSignal): string | null {
  const shown = shownParams(signal.params);
  if (shown.spentUsd !== undefined && typeof signal.params?.spentUsd === 'number') return formatCost(signal.params.spentUsd);
  if (shown.percent !== undefined) return String(shown.percent);
  if (shown.minutes !== undefined) return tr('observe:health.figure.minutes', { n: shown.minutes });
  // A weakened test counts assertions, which its short line already says
  if (shown.count !== undefined && signal.kind !== 'weakened-test') return tr('observe:health.figure.times', { n: shown.count });
  return null;
}

/** The command or the file the signal is about, the only part of it that is a literal. */
function literalOf(signal: HealthSignal): string | null {
  const { params } = signal;
  const named = [params?.file, params?.command].find((value): value is string => typeof value === 'string' && value !== '');
  if (named) return named;
  const detail = signal.detail && signal.detail !== 'time' && signal.detail !== 'cost' ? signal.detail : null;
  return signal.kind === 'hung-command' || signal.kind === 'repeat-stall' ? detail : null;
}

/** At most one short line of what happened, or the sentence itself (cut by CSS) for a code this build has no line for. */
function shortOf(signal: HealthSignal): string {
  if (signal.reasonCode) {
    const key = `observe:${signal.reasonCode.replace(/^health\./, 'health.short.')}`;
    const options = shownParams(signal.params);
    if (i18n.exists(key, options)) return tr(key, options);
  }
  return signalReason(signal);
}

/**
 * One signal, as a name and a figure, the literal it is about on a line of its own and one short
 * line; everything longer (the sentence, the whole command, since when, the hint) is under
 * Details. The level is told by the shape of the icon and a word for a screen reader.
 */
export function SignalItem({ signal, children }: { signal: HealthSignal; children?: ReactNode }) {
  const { t } = useTranslation('observe');
  const Icon = LEVEL_ICON[signal.level];
  const figure = figureOf(signal);
  const literal = literalOf(signal);
  const full = signal.detail && signal.detail !== 'time' && signal.detail !== 'cost' ? signal.detail : literal;
  const hint = signalHint(signal);
  const title = i18n.exists(`observe:health.signal.${signal.kind}`) ? tr(`observe:health.signal.${signal.kind}`) : signalReason(signal);
  return (
    <li className={`obs-signal obs-signal-${signal.level}`}>
      <div className="obs-signal-line">
        <Icon {...ICON_SM} />
        <span className="obs-signal-title">
          <span className="sr-only">{t(`health.level.${signal.level}`)}: </span>
          {title}
        </span>
        {figure && <span className="obs-signal-figure tnum">{figure}</span>}
      </div>
      {literal && (
        <FullText className="mono small muted obs-signal-literal" full={full ?? literal}>
          {signal.kind === 'weakened-test' ? shortPath(literal, 40) : literal}
        </FullText>
      )}
      <div className="small muted obs-signal-short">{shortOf(signal)}</div>
      <Collapsible className="obs-details" triggerClassName="small" title={t('health.details')}>
        <div className="obs-details-body">
          <p className="small break">{signalReason(signal)}</p>
          {full && (
            <div className="obs-signal-full">
              <pre className="mono small break">{full}</pre>
              <CopyButton text={full} label={t('health.copyLiteral')} />
            </div>
          )}
          {signal.since && <p className="small muted tnum">{t('health.since', { when: timeAgo(signal.since) })}</p>}
          {hint && (
            <>
              <p className="small muted">{t('health.hintLabel')}</p>
              <p className="small break obs-proposal-text">{hint}</p>
            </>
          )}
        </div>
      </Collapsible>
      {children}
    </li>
  );
}

function SignalRow({
  signal,
  chatId,
  live,
  sendHint,
  onChanged,
  extra,
}: {
  signal: HealthSignal;
  chatId: string | null;
  live: boolean;
  sendHint: (text: string) => Promise<unknown>;
  onChanged: () => void;
  extra?: ReactNode;
}) {
  const { t } = useTranslation(['observe', 'common']);
  const confirm = useConfirm();
  const toast = useToast();
  const [hinting, setHinting] = useState(false);
  const cancel = useMutation({
    mutationFn: (toolUseId: string) => api.cancelCommand(chatId ?? '', toolUseId),
    onSuccess: (result) => {
      toast.success(t('observe:health.cancelled'), result.command);
      onChanged();
    },
  });
  const toolUseId = cancellable(signal) ? signal.toolUseId : null;
  const hint = signalHint(signal);
  const detail = literalOf(signal) ?? signal.detail ?? null;

  return (
    <SignalItem signal={signal}>
      {live && chatId && (toolUseId || hint) && (
        <div className="task-actions">
          {toolUseId && (
            <button
              type="button"
              className="btn btn-small btn-danger"
              disabled={cancel.isPending}
              onClick={() =>
                void confirm({
                  title: t('observe:health.cancelTitle'),
                  body: (
                    <>
                      <p>{t('observe:health.cancelBody')}</p>
                      {detail && <p className="mono small break">{detail}</p>}
                    </>
                  ),
                  confirmLabel: t('observe:health.cancel'),
                  danger: true,
                }).then((ok) => {
                  if (ok) cancel.mutate(toolUseId);
                })
              }
            >
              <CircleSlash {...ICON_SM} /> {t('observe:health.cancelCommand')}
            </button>
          )}
          {hint && !hinting && (
            <button type="button" className="btn btn-small" onClick={() => setHinting(true)}>
              <Send {...ICON_SM} /> {t('observe:health.hint')}
            </button>
          )}
        </div>
      )}
      {extra}
      <ErrorBox error={cancel.error} />
      {hinting && <HintBox initial={hint ?? ''} send={sendHint} onDone={() => setHinting(false)} />}
    </SignalItem>
  );
}

function useRefreshHealth(chatId: string | null) {
  const queryClient = useQueryClient();
  return () => {
    if (chatId) void queryClient.invalidateQueries({ queryKey: ['chat', chatId] });
    void queryClient.invalidateQueries({ queryKey: ['orchestration'] });
    void queryClient.invalidateQueries({ queryKey: ['orchestrations'] });
  };
}

/** Ends the turn that is running; the chat stays open for what comes next. */
export function InterruptButton({ chatId }: { chatId: string }) {
  const { t } = useTranslation('observe');
  const refresh = useRefreshHealth(chatId);
  const interrupt = useMutation({ mutationFn: () => api.interruptChat(chatId), onSuccess: refresh });
  return (
    <>
      <Tooltip content={t('health.interruptHint')}>
        <button type="button" className="btn btn-small" disabled={interrupt.isPending} onClick={() => interrupt.mutate()}>
          <CircleSlash {...ICON_SM} /> {t('health.interrupt')}
        </button>
      </Tooltip>
      <ErrorBox error={interrupt.error} />
    </>
  );
}

/**
 * What core noticed about a worker, and the three ways to step in: cancel the command that hangs
 * (the worker carries on), send it a hint that is already written for this signal, or interrupt the
 * turn. Only a chat something is working on can be acted on, so a finished one just shows why.
 */
export function HealthPanel({
  health,
  chatId,
  live,
  sendHint,
  badge = true,
  interrupt = true,
  all = false,
  extra,
}: {
  health: Health;
  /** The chat that does the work: a task's worker or the chat itself */
  chatId: string | null;
  live: boolean;
  sendHint: (text: string) => Promise<unknown>;
  /** Off where the caller already shows the badge */
  badge?: boolean;
  /** Off where the caller puts Interrupt in its own header */
  interrupt?: boolean;
  /** Draw the facts of the chat (a failed run, a full context) in the same list, worst first */
  all?: boolean;
  /** What a fact signal offers besides being read, like compacting for a full context */
  extra?: (signal: HealthSignal) => ReactNode;
}) {
  const { t } = useTranslation('observe');
  const signals = (all ? health.signals : health.signals.filter(isStepIn)).slice().sort((a, b) => Number(b.level === 'bad') - Number(a.level === 'bad'));
  const proposal = health.proposal?.status === 'proposed' ? health.proposal : null;
  const refresh = useRefreshHealth(chatId);

  if (signals.length === 0 && !proposal) return null;
  return (
    <div className="stack-tight obs-health" role="group" aria-label={t('health.title')}>
      {(badge || (interrupt && live && chatId)) && (
        <div className="obs-health-head">
          {badge && <HealthBadge health={health} />}
          {interrupt && live && chatId && <InterruptButton chatId={chatId} />}
        </div>
      )}
      {proposal && <ProposalRow key={proposal.id} proposal={proposal} live={live && Boolean(chatId)} sendHint={sendHint} onChanged={refresh} />}
      <ul className="obs-signals">
        {signals.map((signal) => (
          <SignalRow key={`${signal.kind}:${signal.toolUseId ?? signal.detail ?? ''}`} signal={signal} chatId={chatId} live={live} sendHint={sendHint} onChanged={refresh} extra={extra?.(signal)} />
        ))}
      </ul>
    </div>
  );
}
