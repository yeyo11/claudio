import type { Chat, ChatSessionNote } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { NotebookPen, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RichText } from '@claudio/chat-ui/components/Transcript';
import { Collapsible } from '@claudio/ui/components/controls/Collapsible';
import { MoreActions } from '@claudio/ui/components/controls/MoreActions';
import { Sheet } from '@claudio/ui/components/controls/Sheet';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { Dialog } from '@claudio/ui/components/Dialog';
import { ICON_SM } from '@claudio/ui/components/icons';
import { Spinner } from '@claudio/ui/components/Spinner';
import { useToast } from '@claudio/ui/components/Toast';
import { CopyButton, ErrorBox, Tag } from '@claudio/ui/components/ui';
import { formatDateTime, formatNumber } from '@claudio/ui/lib/format';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { api, keys } from '../../api';
import { compactState, JOURNAL_ENTRY_MAX, maskSecrets, noteHeadline } from './context-model';
import { useRefusalText } from './ContextPanel';
import { Section } from './Section';

/** How often a note being written is asked for again: the turn that writes it sends no event of its own. */
const PENDING_POLL_MS = 3_000;

export interface SessionNotesViewProps {
  notes: ChatSessionNote[] | undefined;
  loading?: boolean;
  error?: unknown;
  /** The chat belongs to a project, so a note can go to its journal */
  hasProject: boolean;
  /** Why "Write a note" is not offered, or null when it is */
  writeBlocked: string | null;
  writing?: boolean;
  writeError?: unknown;
  onWrite(): void;
  onDelete(note: ChatSessionNote): void;
  onJournal(note: ChatSessionNote): void;
}

/** Notes the chat kept, from data. The section is quiet when there is nothing: one sentence and the button. */
export function SessionNotesView({ notes, loading, error, hasProject, writeBlocked, writing, writeError, onWrite, onDelete, onJournal }: SessionNotesViewProps) {
  const { t } = useTranslation('chats');
  const list = notes ?? [];
  const write = (
    <button type="button" className="btn btn-small ctx-action" aria-disabled={writeBlocked || writing ? 'true' : undefined} aria-description={writeBlocked ?? undefined} onClick={() => !writeBlocked && !writing && onWrite()}>
      <NotebookPen {...ICON_SM} aria-hidden /> {writing ? t('context.notes.writing') : t('context.notes.write')}
    </button>
  );
  return (
    <Section title={t('context.notes.title')} className="insp-notes">
      <ErrorBox error={error} />
      {loading && list.length === 0 ? null : list.length === 0 ? (
        <p className="small muted">{t('context.notes.empty')}</p>
      ) : (
        <ul className="notes-list list-plain">
          {list.map((note) => (
            <NoteItem key={note.id} note={note} hasProject={hasProject} onDelete={onDelete} onJournal={onJournal} />
          ))}
        </ul>
      )}
      <ErrorBox error={writeError} />
      <div>{writeBlocked ? <Tooltip content={writeBlocked}>{write}</Tooltip> : write}</div>
    </Section>
  );
}

function NoteItem({ note, hasProject, onDelete, onJournal }: { note: ChatSessionNote; hasProject: boolean; onDelete(note: ChatSessionNote): void; onJournal(note: ChatSessionNote): void }) {
  const { t } = useTranslation('chats');
  const pending = note.state === 'pending';
  const failed = note.state === 'failed';
  const title = (
    <span className="note-title">
      <span className="note-meta mono small muted">
        {formatDateTime(note.createdAt)} · {t(`context.notes.source.${note.source}`)}
      </span>
      {pending ? (
        <span className="note-line small">
          <Spinner variant="ring" /> {t('context.notes.pending')}
        </span>
      ) : failed ? (
        <span className="note-line small">
          <Tag tone="bad">{t('context.notes.failedTag')}</Tag>
        </span>
      ) : (
        <span className="note-line small ellipsis">{noteHeadline(note, t('context.notes.fallbackTitle'))}</span>
      )}
    </span>
  );
  return (
    <li className="note-item">
      <Collapsible className="fold" title={title}>
        <div className="stack-tight note-body">
          {failed && <p className="small">{note.error ?? t('context.notes.failed')}</p>}
          {pending && <p className="small muted">{t('context.notes.pending')}</p>}
          {note.state === 'ready' && note.text && <RichText text={note.text} />}
          <div className="note-actions">
            {note.state === 'ready' && note.text && <CopyButton text={note.text} label={t('context.notes.copy')} />}
            {note.state === 'ready' && hasProject && (
              <button type="button" className="btn btn-small" onClick={() => onJournal(note)}>
                {t('context.notes.addToJournal')}
              </button>
            )}
            <MoreActions
              label={t('context.notes.moreActions')}
              entries={[{ id: 'delete', label: t('context.notes.delete'), icon: Trash2, destructive: true, disabled: pending, onSelect: () => onDelete(note) }]}
            />
          </div>
        </div>
      </Collapsible>
    </li>
  );
}

/** The inspector's notes section: the chat's rows, a button to ask for one, and the journal's composer. */
export function SessionNotes({ chat, itemId = null }: { chat: Chat; /** The one work item the chat is linked to, so the journal entry belongs to it */ itemId?: string | null }) {
  const { t } = useTranslation('chats');
  const toast = useToast();
  const queryClient = useQueryClient();
  const why = useRefusalText(chat);
  const key = keys.chatNotes(chat.id);
  const notes = useQuery({
    queryKey: key,
    queryFn: () => api.chatNotes(chat.id),
    refetchInterval: (q) => (q.state.data?.some((n) => n.state === 'pending') ? PENDING_POLL_MS : false),
  });
  const write = useMutation({
    mutationFn: () => api.createChatNote(chat.id, { from: 'agent' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const remove = useMutation({
    mutationFn: (note: ChatSessionNote) => api.deleteChatNote(chat.id, note.id),
    onSuccess: () => {
      toast.success(t('context.notes.removed'));
      void queryClient.invalidateQueries({ queryKey: key });
    },
    onError: (error) => toast.error(t('context.notes.removeFailed'), error),
  });
  const [journaling, setJournaling] = useState<ChatSessionNote | null>(null);
  const { available, refusal } = compactState(chat);
  // A note is a paid turn like a compaction, so the same things stop it
  const blocked = available ? null : refusal ? why(refusal) : null;
  return (
    <>
      <SessionNotesView
        notes={notes.data}
        loading={notes.isPending}
        error={notes.error}
        hasProject={Boolean(chat.project)}
        writeBlocked={blocked}
        writing={write.isPending}
        writeError={write.error}
        onWrite={() => write.mutate()}
        onDelete={(note) => remove.mutate(note)}
        onJournal={setJournaling}
      />
      {journaling && chat.project && <JournalDialog projectId={chat.project.id} itemId={itemId} note={journaling} onClose={() => setJournaling(null)} />}
    </>
  );
}

/** The journal entry, prefilled with the note after `maskSecrets`: nothing reaches the journal without being read here first. */
function JournalDialog({ projectId, itemId, note, onClose }: { projectId: string; itemId: string | null; note: ChatSessionNote; onClose: () => void }) {
  const narrow = useMediaQuery(NARROW);
  const toast = useToast();
  const queryClient = useQueryClient();
  const { t } = useTranslation('chats');
  const [text, setText] = useState(() => maskSecrets(note.text ?? ''));
  const add = useMutation({
    mutationFn: () => api.addJournalEntry(projectId, { text: text.trim(), kind: 'note', itemId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.journal(projectId) });
      toast.success(t('context.notes.journal.saved'));
      onClose();
    },
  });
  const body = <JournalForm text={text} onText={setText} error={add.error} disabled={add.isPending} />;
  const over = text.length > JOURNAL_ENTRY_MAX;
  const actions = (
    <>
      <button type="button" className="btn" onClick={onClose}>
        {t('context.notes.journal.cancel')}
      </button>
      <button type="button" className="btn btn-strong" disabled={add.isPending || over || !text.trim()} onClick={() => add.mutate()}>
        {t('context.notes.journal.save')}
      </button>
    </>
  );
  const title = t('context.notes.journal.title');
  if (narrow) {
    return (
      <Sheet open onOpenChange={(open) => !open && onClose()} title={title} footer={<div className="ctx-foot">{actions}</div>}>
        {body}
      </Sheet>
    );
  }
  return (
    <Dialog title={title} onClose={onClose} width={640} footer={actions}>
      {body}
    </Dialog>
  );
}

/** The preview and its counter, from data. */
export function JournalForm({ text, onText, error, disabled = false }: { text: string; onText(value: string): void; error?: unknown; disabled?: boolean }) {
  const { t } = useTranslation('chats');
  const over = text.length > JOURNAL_ENTRY_MAX;
  return (
    <div className="stack-tight journal-form">
      <p className="small muted">{t('context.notes.journal.hint')}</p>
      <label className="field">
        <span className="field-label">{t('context.notes.journal.label')}</span>
        <textarea className="journal-text" rows={12} value={text} disabled={disabled} onChange={(event) => onText(event.target.value)} aria-invalid={over || undefined} />
        <span className={`mono small ${over ? 'text-bad' : 'muted'}`} aria-live="polite">
          {t('context.notes.journal.counter', { n: formatNumber(text.length), max: formatNumber(JOURNAL_ENTRY_MAX) })}
          {over && ` · ${t('context.notes.journal.over')}`}
        </span>
      </label>
      <ErrorBox error={error} />
    </div>
  );
}
