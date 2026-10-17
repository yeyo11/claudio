import type { Chat, ChatMessageReceipt, ChatPendingAttachment } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, GitFork, Play, Square } from 'lucide-react';
import { Fragment, Suspense, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AttachmentTray, useAttachments, type AttachmentsState } from '../components/Attachments';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { ICON_SM } from '@claudio/ui/components/icons';
import { SlashMenu, useSlashMenu, type SlashMenuState } from '../components/SlashMenu';
import { ErrorBox } from '@claudio/ui/components/ui';
import { AgentScope } from '../lib/agent';
import { chatKeys, useChatUi, type StartChoices } from '../lib/context';
import { modeLabel } from '../lib/wire-words';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { ComposerMenu } from './ComposerMenu';
import { draftKey, readDraft, writeDraft } from './drafts';
import { RichEditor, type RichEditorHandle, type RichEditorProps } from './editor/RichEditor';
import { historyStep, type HistoryIndex } from './history';
import { OptionsPanel } from './OptionsPanel';

export { OptionsPanel };

// Its Select and Combobox are Radix controls kept out of the shell bundle this page lives in: the
// app hands them over as lazy components (`lib/chat-ui.tsx`)
export type { StartChoices };

/**
 * A new message's id, a v4 UUID. `crypto.randomUUID` exists only in a secure context, and the app is
 * often opened over plain http on the local network; `getRandomValues` is there either way.
 */
function messageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** What a send carries: the words and files as they went, and the box as it was when they left. */
interface Outgoing {
  message: string;
  /** The box's text when it was sent: only that is taken out of it once the send succeeds */
  typed: string;
  attachments: ChatPendingAttachment[];
  id?: string;
}

/** What a message does: reaches a live process, resumes the chat in place, or continues a copy of it. */
export type ComposerKind = 'send' | 'resume' | 'fork';

/**
 * The status line's words: model · mode · preset · servers, each what the next message will run
 * with. A choice made for a resume or a fork wins over what the chat last ran with.
 */
function useStatusWords(chat: Chat, kind: ComposerKind, choices: StartChoices): string[] {
  const { t } = useTranslation('chat');
  const last = chat.execution ?? chat.executions.at(-1) ?? null;
  const starting = kind !== 'send';
  const model = (starting ? choices.model : undefined) ?? last?.model ?? chat.model ?? t('shared.default');
  const chosenMode = (starting ? choices.permissionMode : undefined) ?? last?.permissionMode;
  const mode = chosenMode ? modeLabel(chosenMode) : t('controls.default');
  const presetChoice = starting ? choices.toolPreset : undefined;
  const preset =
    presetChoice === null
      ? t('status.noPreset')
      : presetChoice !== undefined
        ? presetChoice
        : (chat.tools?.preset?.name ?? t('status.noPreset'));
  const mcpChoice = starting ? choices.mcp : undefined;
  const servers = mcpChoice === undefined ? (chat.tools?.mcp ?? null) : mcpChoice;
  const mcp = servers ? t('status.mcpChosen', { count: servers.servers.length }) : t('status.mcpDefault');
  return [model, mode, preset, mcp];
}

/**
 * The chips under the message box, `opus · bypassPermissions · no preset · MCP: CLI default`, as one
 * button that opens what used to be four labelled fields under it: the permission mode and model of
 * the live process, or everything a resume or a fork may start with. The permission mode is the
 * chip in the accent: it decides what the chat may do without asking.
 */
function StatusLine({
  chat,
  kind,
  choices,
  onChoices,
  open,
  setOpen,
}: {
  chat: Chat;
  kind: ComposerKind;
  choices: StartChoices;
  onChoices: (next: StartChoices) => void;
  /** Held by the composer: the "+" menu opens it to choose the servers of a resume or a fork */
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const { t } = useTranslation('chat');
  const { slots } = useChatUi();
  const { StartOptions, LiveOptions } = slots;
  const words = useStatusWords(chat, kind, choices);
  const narrow = useMediaQuery(NARROW);
  const title = kind === 'send' ? t('status.liveTitle') : kind === 'resume' ? t('status.resumeTitle') : t('status.forkTitle');
  const changed = kind !== 'send' && Object.values(choices).some((v) => v !== undefined);
  const trigger = (
    <button
      type="button"
      className={`composer-status ${changed ? 'is-changed' : ''}`.trim()}
      aria-expanded={open}
      onClick={narrow ? () => setOpen(true) : undefined}
    >
      <StatusChips label={t('status.open')} words={words} accent={1} />
    </button>
  );
  return (
    <OptionsPanel trigger={trigger} title={title} open={open} onOpenChange={setOpen}>
      <Suspense fallback={null}>
        {kind === 'send' ? <LiveOptions chat={chat} /> : <StartOptions chat={chat} value={choices} onChange={onChoices} forking={kind === 'fork'} />}
      </Suspense>
    </OptionsPanel>
  );
}

/**
 * The status line's words as chips; `accent` is the index of the permission mode's. The button is
 * named by the chips it shows, after `label` said off screen: a phone hides the preset's chip, and
 * a name of its own words would still say it. A space goes between two chips: the flex row does not
 * draw it, but without it the chips' text runs together ("workspacedefault model").
 */
export function StatusChips({ label, words, accent, icon }: { label: string; words: string[]; accent: number; icon?: ReactNode }) {
  // Outside the row of chips, whose `:nth-child` rules pick which chip a phone hides
  return (
    <>
      <span className="sr-only">{label}: </span>
      <span className="composer-status-words">
        {words.map((word, i) => (
          <Fragment key={i}>
            {i > 0 && ' '}
            <span className={`composer-status-word ${i === accent ? 'is-accent' : ''}`.trim()}>
              {i === 0 && icon}
              <span className="composer-status-text">{word}</span>
            </span>
          </Fragment>
        ))}
      </span>
    </>
  );
}

/** Which keys send and which break the line, for a box with a keyboard under it; a phone hides it. */
export function KeysHint({ children }: { children: ReactNode }) {
  return (
    <span className="composer-keys" aria-hidden>
      {children}
    </span>
  );
}

/** Past this many characters a paste is attached as a text file: a wall of logs is a file, not a message. */
const BIG_PASTE_CHARS = 12_000;
/** How long typing rests before the draft is written down. */
const DRAFT_DEBOUNCE_MS = 300;

/**
 * The message box, with its own text state: the transcript above it can be thousands of nodes, and
 * re-rendering the page on every character typed here is enough to lock the tab up. The box is a
 * ProseMirror editor (`editor/RichEditor.tsx`); this component holds what it says as a string.
 */
export function Composer({
  chat,
  kind,
  onSent,
  interrupt,
  restore,
  history = [],
  onSending,
  writing = false,
}: {
  chat: Chat;
  kind: ComposerKind;
  /** The message left for the chat, with how the server took it (a message to a live chat): the page holds it until the agent reads it */
  onSent: (sent: { text: string; attachments: ChatPendingAttachment[]; receipt: ChatMessageReceipt | null }) => void;
  /** While the chat works, an empty box's button stops the turn instead of sending */
  interrupt?: { run: () => void; pending: boolean };
  /** Words and files handed back to the box: a message the agent never read (see `composer/queued.ts`) */
  restore?: { text: string; attachments: ChatPendingAttachment[]; at: number } | null;
  /** What the person already sent in this chat, oldest first: ArrowUp brings it back */
  history?: readonly string[];
  /**
   * The moment a message to an idle chat leaves, before the server answers: the page draws it in the
   * conversation. `id` is null for a resume, which has none to send. Returns the undo, run if the send fails.
   */
  onSending?: (message: { id: string | null; text: string; attachments: ChatPendingAttachment[] }) => (() => void) | void;
  /** The answer's text is streaming: the text is the live surface then, so the box drops its energy border */
  writing?: boolean;
}) {
  const { t } = useTranslation('chat');
  const queryClient = useQueryClient();
  const { client, paths } = useChatUi();
  const navigate = useNavigate();
  // Keyed by the chat and what the box does: a resume's draft is not the live chat's
  const draft = draftKey(chat.id, kind);
  const [initial] = useState(() => readDraft(draft));
  const [text, setText] = useState(initial);
  const [caret, setCaret] = useState(initial.length);
  const [recalled, setRecalled] = useState<HistoryIndex>(null);
  const [choices, setChoices] = useState<StartChoices>({});
  const [options, setOptions] = useState(false);
  const files = useAttachments();
  const editor = useRef<RichEditorHandle>(null);
  const working = chat.state === 'working';
  const narrow = useMediaQuery(NARROW);
  // A touch keyboard has no comfortable Shift+Enter: there Enter breaks the line and the button sends
  const touch = useMediaQuery('(pointer: coarse)');
  const slash = useSlashMenu({ text, caret, commands: chat.environment?.slashCommands ?? [], skills: chat.environment?.skills, target: editor });
  const live = kind === 'send' && Boolean(chat.execution);

  // The draft follows the text a moment after typing rests, and is written at once when the box goes
  const latestText = useRef(text);
  latestText.current = text;
  useEffect(() => {
    const timer = setTimeout(() => writeDraft(draft, text), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, text]);
  useEffect(() => () => writeDraft(draft, latestText.current), [draft]);

  // The message last sent that did not get through: sent again unchanged, it keeps its id, so a send
  // that timed out after the server took it still reaches the agent once
  const attempt = useRef<{ id: string; text: string; files: string } | null>(null);
  // What the box gave up on Send, so a failure can hand it back; null when the send left the box alone
  const sending = useRef<{ undo: (() => void) | null; text: string } | null>(null);
  const submit = useMutation({
    mutationFn: async ({ message, attachments: sent, id }: Outgoing) => {
      const attachments = sent.length ? { attachments: sent.map((a) => a.id) } : {};
      if (kind === 'send') return { receipt: (await client.sendMessage(chat.id, { text: message, ...attachments, ...(id ? { id } : {}) })).message, chatId: chat.id };
      // A chat resumed or forked from here is answered here: permissions would otherwise be denied unasked
      const request = { prompt: message, ...attachments, permissionPrompts: 'host' as const, ...choices };
      const started = await (kind === 'resume' ? client.resumeChat(chat.id, request) : client.forkChat(chat.id, request));
      return { receipt: null, chatId: started.id };
    },
    onSuccess: ({ receipt, chatId }, sent) => {
      attempt.current = null;
      // Only what went: whatever was typed or attached while the request was out stays in the box
      const held = editor.current?.getText() ?? '';
      const clearedAtSend = sending.current !== null;
      sending.current = null;
      if (!clearedAtSend && held.startsWith(sent.typed)) {
        const rest = held.slice(sent.typed.length).replace(/^\s+/, '');
        editor.current?.setText(rest);
        writeDraft(draft, rest);
      }
      setRecalled(null);
      files.removeSent(sent.attachments.map((a) => a.id));
      onSent({ text: sent.message, attachments: sent.attachments, receipt });
      void queryClient.invalidateQueries({ queryKey: chatKeys.chats });
      void queryClient.invalidateQueries({ queryKey: chatKeys.chatScope(chat.id) });
      if (kind === 'fork') navigate(paths.chat(chatId));
    },
    onError: () => {
      const gave = sending.current;
      sending.current = null;
      if (!gave) return;
      gave.undo?.();
      // Back after whatever is half-typed, the way a message the agent never read comes back
      const held = editor.current?.getText() ?? '';
      editor.current?.setText(held.trim() ? `${held.replace(/\s+$/, '')}\n\n${gave.text}` : gave.text);
      editor.current?.focus();
    },
  });

  // A message that was never delivered comes back here, after whatever is half-typed, with its files
  const restoredAt = useRef(0);
  const restoreFiles = files.restore;
  useEffect(() => {
    if (!restore || restore.at === restoredAt.current) return;
    restoredAt.current = restore.at;
    if (restore.text) {
      const held = editor.current?.getText() ?? '';
      editor.current?.setText(held.trim() ? `${held.replace(/\s+$/, '')}\n\n${restore.text}` : restore.text);
    }
    if (restore.attachments.length) restoreFiles(restore.attachments);
    editor.current?.focus();
  }, [restore, restoreFiles]);

  const send = () => {
    const typed = editor.current?.getText() ?? text;
    const message = typed.trim();
    // A file on its own is a message too; one still uploading is not sent without it
    if (!(message || files.ids.length) || files.uploading || submit.isPending) return;
    // On a phone the keyboard covers half the screen, and what happens next is worth watching: the
    // box lets go once the message is away, and a tap on it brings the keyboard back
    if (touch) (editor.current?.element as HTMLElement | null)?.blur();
    const attachments = files.items.flatMap((p) => (p.status === 'ready' && p.attachment ? [p.attachment] : []));
    const fileKey = attachments.map((a) => a.id).join(',');
    let id: string | undefined;
    if (kind === 'send') {
      const last = attempt.current;
      id = last && last.text === message && last.files === fileKey ? last.id : messageId();
      attempt.current = { id, text: message, files: fileKey };
    }
    // A message to a working chat becomes a card over the box once the server says so, not a row
    if (onSending && kind !== 'fork' && !working) {
      const undo = onSending({ id: id ?? null, text: message, attachments });
      sending.current = { undo: undo ?? null, text: typed };
      editor.current?.setText('');
      writeDraft(draft, '');
      setRecalled(null);
    }
    submit.mutate({ message, typed, attachments, ...(id ? { id } : {}) });
  };

  const stoppable = Boolean(interrupt) && kind === 'send' && working;
  const onKeyDown = (event: KeyboardEvent): boolean => {
    if (slash.onKeyDown(event)) return true;
    const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
    if (plain && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      const step = historyStep(event.key, { history, index: recalled, text, caret });
      if (!step) return false;
      editor.current?.setText(step.text, event.key === 'ArrowUp' ? 0 : step.text.length);
      setRecalled(step.index);
      return true;
    }
    // Escape on an empty box stops the turn, as the button beside it does
    if (event.key === 'Escape' && plain && stoppable && interrupt && !text.trim() && !interrupt.pending) {
      interrupt.run();
      return true;
    }
    return false;
  };
  const onChange = (next: string) => {
    setText(next);
    // Typing over what the arrows brought back makes it the person's own again
    if (recalled !== null && next !== history[history.length - 1 - recalled]) setRecalled(null);
  };
  const startCommand = () => {
    const held = editor.current?.getText() ?? '';
    editor.current?.setText(held.startsWith('/') ? held : `/${held}`, 1);
    editor.current?.focus();
  };
  const onBigPaste = (pasted: string): boolean => {
    files.add([new File([pasted], t('composer.pastedFile'), { type: 'text/plain' })]);
    return true;
  };

  const label = {
    send: { idle: t('runView.send'), pending: t('runView.sending') },
    resume: { idle: t('composer.resume'), pending: t('composer.resuming') },
    fork: { idle: t('composer.fork'), pending: t('composer.forking') },
  }[kind];
  const placeholder =
    kind === 'fork'
      ? t('composer.placeholderFork')
      : kind === 'resume'
        ? t('composer.placeholderResume')
        : working
          ? t('runView.placeholderQueued')
          : t('runView.placeholderFollowUp');
  const Icon = kind === 'fork' ? GitFork : kind === 'resume' ? Play : ArrowUp;
  const empty = !text.trim() && files.ids.length === 0;
  // A phone has room for one round button: on an empty box it is the one that stops
  const sendable = !(narrow && stoppable && empty);
  const sendName = submit.isPending ? label.pending : files.uploading ? t('shared.uploading') : label.idle;

  return (
    <AgentScope chat={chat}>
      <ComposerBox
        editor={editor}
        files={files}
        slash={slash}
        formClass={working ? (writing ? 'is-working' : 'live-energy is-working') : ''}
        formLabel={kind === 'fork' ? t('sessionView.continueCopy') : t('composer.message')}
        onSubmit={send}
        menu={
          <ComposerMenu
            chat={chat}
            live={live}
            files={files}
            disabled={submit.isPending}
            hasCommands={(chat.environment?.slashCommands?.length ?? 0) > 0}
            onCommands={startCommand}
            onChooseTools={() => setOptions(true)}
          />
        }
        editorProps={{
          initialText: initial,
          placeholder,
          ariaLabel: kind === 'fork' ? t('composer.firstMessage') : t('composer.message'),
          submitKey: touch ? 'mod-enter' : 'enter',
          autoFocus: kind === 'fork',
          onChange,
          onCaret: setCaret,
          onKeyDown,
          onBigPaste,
          bigPasteChars: BIG_PASTE_CHARS,
        }}
        stop={
          stoppable &&
          interrupt && (
            <Tooltip content={t('view.interruptHint')}>
              <button type="button" className="btn btn-danger composer-stop" aria-label={t('runView.interrupt')} disabled={interrupt.pending} onClick={interrupt.run}>
                <Square size={12} strokeWidth={2.5} fill="currentColor" aria-hidden />
                <span className="composer-stop-word">{t('runView.interrupt')}</span>
              </button>
            </Tooltip>
          )
        }
        send={sendable ? { name: sendName, icon: <Icon {...ICON_SM} />, disabled: empty || files.uploading || submit.isPending } : null}
        status={<StatusLine chat={chat} kind={kind} choices={choices} onChoices={setChoices} open={options} setOpen={setOptions} />}
        error={<ErrorBox error={submit.error} title={kind === 'send' ? t('runView.notSent') : kind === 'resume' ? t('composer.couldNotResume') : t('composer.couldNotFork')} />}
      />
    </AgentScope>
  );
}

/** A box with no chat behind it has no commands to offer yet */
const NO_COMMANDS: readonly string[] = [];

/**
 * The chat's composer on a screen that starts a chat and has none yet: the Claudio assistant's entry.
 * The same box, keys and line of chips as a chat's; what needs a chat to exist is left out: the "+"
 * (files, commands, servers, the account), the queue and the stop. `status` is the line of chips for
 * what the screen lets the person choose for the start, and `onStart` gets the trimmed first message.
 */
export function StartComposer({
  editor: handed,
  label,
  placeholder,
  sendLabel,
  pending,
  onStart,
  status,
  error,
  autoFocus = false,
}: {
  /** The box, for a screen that fills it (a starter); the composer keeps its own when left out */
  editor?: RefObject<RichEditorHandle | null>;
  label: string;
  placeholder: string;
  sendLabel: { idle: string; pending: string };
  /** The start is on its way: the button waits and says so */
  pending: boolean;
  onStart: (message: string) => void;
  status?: ReactNode;
  error?: ReactNode;
  autoFocus?: boolean;
}) {
  const own = useRef<RichEditorHandle>(null);
  const editor = handed ?? own;
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  // The chat's keys: Enter sends, and on a touch keyboard Enter breaks the line and the button sends
  const touch = useMediaQuery('(pointer: coarse)');
  const slash = useSlashMenu({ text, caret, commands: NO_COMMANDS, target: editor });
  const send = () => {
    const message = (editor.current?.getText() ?? text).trim();
    if (message && !pending) onStart(message);
  };
  const name = pending ? sendLabel.pending : sendLabel.idle;
  return (
    <ComposerBox
      editor={editor}
      slash={slash}
      formClass=""
      formLabel={label}
      onSubmit={send}
      editorProps={{ placeholder, ariaLabel: label, submitKey: touch ? 'mod-enter' : 'enter', autoFocus, onChange: setText, onCaret: setCaret, onKeyDown: slash.onKeyDown }}
      send={{ name, icon: <ArrowUp {...ICON_SM} />, disabled: !text.trim() || pending }}
      status={status}
      error={error}
    />
  );
}

/**
 * What every composer draws, whatever it sends to: the card with the "+" where there is one, the
 * editor, the stop and send buttons, and the line of chips and keys under it. A chat's `Composer`
 * and a `StartComposer` are this one box, so the two cannot drift apart.
 */
function ComposerBox({
  editor,
  files,
  slash,
  formClass,
  formLabel,
  onSubmit,
  menu,
  editorProps,
  stop,
  send,
  status,
  error,
}: {
  editor: RefObject<RichEditorHandle | null>;
  /** Left out where nothing can be attached: no tray, no drop zone, no pasted files */
  files?: AttachmentsState;
  slash: SlashMenuState;
  formClass: string;
  formLabel: string;
  onSubmit: () => void;
  menu?: ReactNode;
  editorProps: Omit<RichEditorProps, 'ariaProps' | 'onSubmit' | 'onPasteFiles'>;
  stop?: ReactNode;
  /** Null where the box has no send button: a phone's, whose one round button stops the turn */
  send: { name: string; icon: ReactNode; disabled: boolean } | null;
  status?: ReactNode;
  error?: ReactNode;
}) {
  const { t } = useTranslation('chat');
  return (
    <div className="composer-wrap">
      <div {...files?.dropProps}>
        {files && <AttachmentTray state={files} />}
        <SlashMenu state={slash}>
          <form
            className={`composer ${formClass}`.trim()}
            aria-label={formLabel}
            onSubmit={(e) => {
              e.preventDefault();
              onSubmit();
            }}
          >
            {menu}
            <RichEditor ref={editor} {...editorProps} ariaProps={slash.ariaProps} onSubmit={onSubmit} {...(files ? { onPasteFiles: files.add } : {})} />
            {stop}
            {send && (
              <Tooltip content={send.name}>
                <button type="submit" className="composer-send" aria-label={send.name} disabled={send.disabled}>
                  {send.icon}
                </button>
              </Tooltip>
            )}
          </form>
        </SlashMenu>
      </div>
      <div className="composer-foot">
        {status}
        <KeysHint>{t('composer.keys')}</KeysHint>
      </div>
      {error}
    </div>
  );
}
