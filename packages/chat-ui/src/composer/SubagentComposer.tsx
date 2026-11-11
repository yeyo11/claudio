/**
 * The box at the foot of a subagent's drawer: words written straight to that subagent, carried by
 * the chat's bridge mod (docs/agent-messages.md). The lead does not see them. It is the chat's own
 * `ComposerBox` with the chat's menu and status line left out, and it never takes the energy border:
 * the chat's composer may already have it on the same screen.
 */
import type { AgentTranscript, ChatPendingMessage } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUp } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON_SM } from '@claudio/ui/components/icons';
import { ErrorBox } from '@claudio/ui/components/ui';
import { useMediaQuery } from '@claudio/ui/lib/media';
import { useSlashMenu } from '../components/SlashMenu';
import { chatKeys, useChatUi } from '../lib/context';
import { ComposerBox } from './Composer';
import type { RichEditorHandle } from './editor/RichEditor';
import { QueuedCards } from './QueuedCards';
import { subagentQueue, type QueuedMessage } from './queued';

/** What the box can do for this subagent right now, which is also what its note line says */
export type SubagentComposerState = 'running' | 'finished' | 'stopped' | 'gone';

export function subagentComposerState(alive: boolean, status: AgentTranscript['status']): SubagentComposerState {
  if (!alive) return 'gone';
  if (status === 'stopped') return 'stopped';
  return status === 'completed' || status === 'failed' ? 'finished' : 'running';
}

const NOTE_KEY = {
  running: 'agentComposer.note',
  finished: 'agentComposer.resumes',
  stopped: 'agentComposer.stopped',
  gone: 'agentComposer.chatGone',
} as const;

export function SubagentComposer({
  chatId,
  agentId,
  name,
  status,
  alive,
  pending,
}: {
  chatId: string;
  /** The CLI's id of the subagent, which the bridge addresses */
  agentId: string;
  /** Its description, as the drawer's title reads it */
  name: string;
  status: AgentTranscript['status'];
  alive: boolean;
  /** `chat.pending`: the messages not read yet, the ones for this subagent among them */
  pending: readonly ChatPendingMessage[] | undefined;
}) {
  const { t } = useTranslation('chat');
  const queryClient = useQueryClient();
  const { client } = useChatUi();
  const editor = useRef<RichEditorHandle>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const touch = useMediaQuery('(pointer: coarse)');
  const slash = useSlashMenu({ text, caret, commands: [], target: editor });
  const state = subagentComposerState(alive, status);
  const enabled = state === 'running' || state === 'finished';
  const queued = useMemo(() => subagentQueue(pending, agentId), [pending, agentId]);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: chatKeys.chatScope(chatId) });

  const send = useMutation({
    mutationFn: (words: string) => {
      // Unreachable for a person: the drawer offers the box only to a client that has both methods
      if (!client.sendToSubagent) throw new Error('the chat client cannot write to a subagent');
      return client.sendToSubagent(chatId, agentId, { text: words });
    },
    onSuccess: (_receipt, words) => {
      // Only what went: whatever was typed while the request was out stays
      const held = editor.current?.getText() ?? '';
      if (held.startsWith(words)) editor.current?.setText(held.slice(words.length).replace(/^\s+/, ''));
      refresh();
    },
  });
  // `isPending` shows a render later: two clicks in the same tick would both get through it
  const inFlight = useRef(false);
  const settled = () => {
    inFlight.current = false;
    refresh();
  };
  // A 409 is a message the subagent took meanwhile: the refresh that follows shows it gone
  const drop = useMutation({
    mutationFn: (message: QueuedMessage) => {
      if (!client.withdrawSubagentMessage) throw new Error('the chat client cannot withdraw a message to a subagent');
      return client.withdrawSubagentMessage(chatId, agentId, message.id);
    },
    onSettled: settled,
  });
  const viaLead = useMutation({
    mutationFn: async (message: QueuedMessage) => {
      // Offered only when the client can write to a subagent (above). Core frames it for the lead, which
      // passes it on; the lead's transcript draws it as a system row, not as the person's hint
      if (!client.sendToSubagent || !client.withdrawSubagentMessage) throw new Error('the chat client cannot write to a subagent');
      await client.sendToSubagent(chatId, agentId, { text: message.text, via: 'lead' });
      // Put away once the lead has it: the card must not offer to send it again
      await client.withdrawSubagentMessage(chatId, agentId, message.id);
    },
    onSettled: settled,
  });

  const submit = () => {
    const words = (editor.current?.getText() ?? text).trim();
    if (!enabled || !words || send.isPending) return;
    send.mutate(words);
  };
  const empty = !text.trim();
  const busy = viaLead.isPending || drop.isPending;
  const once = (run: (message: QueuedMessage) => void, message: QueuedMessage): boolean => {
    if (busy || inFlight.current) return false;
    inFlight.current = true;
    run(message);
    return true;
  };
  const sendName = send.isPending ? t('runView.sending') : t('runView.send');

  return (
    <div className="agent-composer">
      <QueuedCards
        queued={queued}
        agent={name}
        // The note under the box already says where a message goes, so the card says what it waits for
        footWords={{ waiting: t('agentComposer.waiting'), lost: t('agentComposer.bridgeDown') }}
        onWithdraw={(message) => {
          if (!once(drop.mutate, message)) return;
          // Back in the box at once, after whatever is half-typed
          const held = editor.current?.getText() ?? '';
          editor.current?.setText(held.trim() ? `${held.replace(/\s+$/, '')}\n\n${message.text}` : message.text);
          editor.current?.focus();
        }}
        onDismiss={(message) => void once(drop.mutate, message)}
        onRestore={(message) => {
          if (!once(drop.mutate, message)) return;
          const held = editor.current?.getText() ?? '';
          editor.current?.setText(held.trim() ? `${held.replace(/\s+$/, '')}\n\n${message.text}` : message.text);
          editor.current?.focus();
        }}
        // Pressed twice, the lead would get the relay twice. Only while the subagent can still take
        // words: a stopped one cannot be resumed by the lead either, and a chat gone has no lead to ask
        {...(enabled && client.sendToSubagent ? { onViaLead: (message: QueuedMessage) => void once(viaLead.mutate, message) } : {})}
        sending={busy}
      />
      <ComposerBox
        editor={editor}
        hideKeys={!enabled}
        slash={slash}
        formClass=""
        formLabel={t('agentComposer.placeholder', { agent: name })}
        onSubmit={submit}
        editorProps={{
          placeholder: t('agentComposer.placeholder', { agent: name }),
          ariaLabel: t('agentComposer.placeholder', { agent: name }),
          submitKey: touch ? 'mod-enter' : 'enter',
          disabled: !enabled,
          onChange: setText,
          onCaret: setCaret,
          onKeyDown: slash.onKeyDown,
        }}
        send={{ name: sendName, icon: <ArrowUp {...ICON_SM} />, disabled: !enabled || empty || send.isPending }}
        status={
          <span className="agent-composer-note" role="status">
            {t(NOTE_KEY[state])}
          </span>
        }
        error={<ErrorBox error={send.error ?? drop.error ?? viaLead.error} title={t('runView.notSent')} />}
      />
    </div>
  );
}
