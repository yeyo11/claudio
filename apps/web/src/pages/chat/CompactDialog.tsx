import { COMPACT_FOCUS_MAX, type Chat } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAgentName } from '@claudio/chat-ui/lib/agent';
import { formatTokens } from '@claudio/chat-ui/lib/chat-model';
import { Sheet } from '@claudio/ui/components/controls/Sheet';
import { Switch } from '@claudio/ui/components/controls/Toggle';
import { Dialog } from '@claudio/ui/components/Dialog';
import { useToast } from '@claudio/ui/components/Toast';
import { ErrorBox } from '@claudio/ui/components/ui';
import { formatNumber } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { api } from '../../api';

/**
 * The question before a compaction: what it does, that it is a paid turn, and what to keep. A
 * dialog on a desktop, a sheet on a phone. A refusal stays in the dialog, in the sentence the
 * server wrote; success closes it and the page shows the compaction as it runs.
 */
export function CompactDialog({ chat, onClose }: { chat: Chat; onClose: () => void }) {
  const { t } = useTranslation('chats');
  const narrow = useMediaQuery(NARROW);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [focus, setFocus] = useState('');
  const [note, setNote] = useState(true);
  const compact = useMutation({
    mutationFn: () => api.compactChat(chat.id, { ...(focus.trim() ? { focus: focus.trim() } : {}), structuredNote: note }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['chat', chat.id] });
      toast.info(t('context.compactDialog.started'));
      onClose();
    },
  });
  const size = chat.context ? (chat.context.compactedSince?.postTokens ?? chat.context.used) : null;
  const form = (
    <CompactForm
      size={size}
      focus={focus}
      onFocus={setFocus}
      note={note}
      onNote={setNote}
      error={compact.error}
      disabled={compact.isPending}
      onSubmit={() => compact.mutate()}
    />
  );
  const actions = (
    <>
      <button type="button" className="btn" onClick={onClose}>
        {t('context.compactDialog.cancel')}
      </button>
      <button type="button" className="btn btn-strong" data-autofocus disabled={compact.isPending || focus.length > COMPACT_FOCUS_MAX} onClick={() => compact.mutate()}>
        {compact.isPending ? t('context.compactDialog.working') : t('context.compactDialog.confirm')}
      </button>
    </>
  );
  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} title={t('context.compactDialog.title')} className="ctx-sheet" footer={<div className="ctx-foot">{actions}</div>}>
        {form}
      </Sheet>
    );
  }
  return (
    <Dialog title={t('context.compactDialog.title')} onClose={onClose} width={560} footer={actions}>
      {form}
    </Dialog>
  );
}

/** The fields, from data: what the tests render. */
export function CompactForm({
  size,
  focus,
  onFocus,
  note,
  onNote,
  error,
  disabled = false,
  onSubmit,
}: {
  /** Tokens the context holds now, or null when it is not known */
  size: number | null;
  focus: string;
  onFocus(value: string): void;
  note: boolean;
  onNote(value: boolean): void;
  error?: unknown;
  disabled?: boolean;
  onSubmit?(): void;
}) {
  const { t } = useTranslation('chats');
  const agent = useAgentName();
  return (
    <form
      className="compact-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit?.();
      }}
    >
      <p>{size === null ? t('context.compactDialog.bodyNoSize', { agent }) : t('context.compactDialog.body', { agent, size: t('context.compactDialog.size', { n: formatTokens(size) }) })}</p>
      <label className="field">
        <span className="field-label">{t('context.compactDialog.focus')}</span>
        <textarea
          className="compact-focus"
          rows={3}
          value={focus}
          maxLength={COMPACT_FOCUS_MAX}
          disabled={disabled}
          placeholder={t('context.compactDialog.focusPlaceholder')}
          onChange={(event) => onFocus(event.target.value)}
        />
        <span className="mono small muted compact-count" aria-live="polite">
          {t('context.compactDialog.count', { n: formatNumber(focus.length), max: formatNumber(COMPACT_FOCUS_MAX) })}
        </span>
      </label>
      <Switch checked={note} onChange={onNote} disabled={disabled}>
        {t('context.compactDialog.note')}
      </Switch>
      <ErrorBox error={error} />
    </form>
  );
}
