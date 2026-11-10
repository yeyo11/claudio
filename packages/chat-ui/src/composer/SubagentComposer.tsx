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

/**
 * The hint the lead reads when a subagent could not be written to: it passes the words on with its
 * own tools. English because the agent reads it; the name is cut of backticks, which would end the code span.
 */
export function relayWords(name: string, words: string): string {
  return `Relay this to your background agent \`${name.replace(/`/g, "'")}\` with SendMessage: ${words}`;
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
      if (!client.sendToSubagent) throw new Error('This server cannot write to a subagent');
      return client.sendToSubagent(chatId, agentId, { text: words });
    },
    onSuccess: (_receipt, words) => {
      // Only what went: whatever was typed while the request was out stays
      const held = editor.current?.getText() ?? '';
      if (held.startsWith(words)) editor.current?.setText(held.slice(words.length).replace(/^\s+/, ''));
      refresh();
    },
  });
  // A 409 is a message the subagent took meanwhile: the refresh that follows shows it gone
  const drop = useMutation({
    mutationFn: (message: QueuedMessage) => {
      if (!client.withdrawSubagentMessage) throw new Error('This server cannot write to a subagent');
      return client.withdrawSubagentMessage(chatId, agentId, message.id);
    },
    onSettled: refresh,
  });
  const viaLead = useMutation({
    mutationFn: async (message: QueuedMessage) => {
      if (!client.hintChat || !client.withdrawSubagentMessage) throw new Error('This server cannot hint a chat');
      await client.hintChat(chatId, { text: relayWords(name, message.text) });
      // Put away once the lead has it: the card must not offer to send it again
      await client.withdrawSubagentMessage(chatId, agentId, message.id);
    },
    onSettled: refresh,
  });

  const submit = () => {
    const words = (editor.current?.getText() ?? text).trim();
    if (!enabled || !words || send.isPending) return;
    send.mutate(words);
  };
  const empty = !text.trim();
  const sendName = send.isPending ? t('runView.sending') : t('runView.send');

  return (
    <div className="agent-composer">
      <QueuedCards
        queued={queued}
        agent={name}
        footWords={{ waiting: t('agentComposer.note'), lost: t('agentComposer.bridgeDown') }}
        onWithdraw={(message) => {
          drop.mutate(message);
          // Back in the box at once, after whatever is half-typed
          const held = editor.current?.getText() ?? '';
          editor.current?.setText(held.trim() ? `${held.replace(/\s+$/, '')}\n\n${message.text}` : message.text);
          editor.current?.focus();
        }}
        onDismiss={(message) => drop.mutate(message)}
        onRestore={(message) => {
          drop.mutate(message);
          const held = editor.current?.getText() ?? '';
          editor.current?.setText(held.trim() ? `${held.replace(/\s+$/, '')}\n\n${message.text}` : message.text);
          editor.current?.focus();
        }}
        onViaLead={(message) => viaLead.mutate(message)}
        sending={viaLead.isPending}
      />
      <ComposerBox
        editor={editor}
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
