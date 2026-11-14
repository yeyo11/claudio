import { lazy, useMemo, type ReactNode } from 'react';
import { activeBase } from '@claudio/ui/lib/server-scope';
import { api, enc } from '../api';
import { withToken } from './auth';
import { ChatUiProvider, type ChatClient, type ChatUiConfig } from '@claudio/chat-ui/lib/context';
import { EffortName, ModelName } from '../components/AgentFacts';
import { TeammateName } from '../components/TeammateName';
import { reviewLink, reviewPath } from './changes-summary';
import { describeCron } from './cron-words';
import { useFallbackInterval } from './feed';
import { useProviderLabel } from './provider-status';
import { settingsHref } from '../pages/config/settingsGroups';

/** How long a schedule prompt waits for its preview before it shows the answers without it */
const SCHEDULE_PROMPT_PREVIEW_MS = 5_000;

/** `api`'s chat methods, plus the two URLs the chat package cannot build without knowing the base. */
export const chatClient: ChatClient = {
  chat: api.chat,
  hintChat: api.hintChat,
  sendToSubagent: api.sendToSubagent,
  withdrawSubagentMessage: api.withdrawSubagentMessage,
  chatPermissions: api.chatPermissions,
  chatTasks: api.chatTasks,
  answerPermission: api.answerPermission,
  sendMessage: api.sendMessage,
  resumeChat: api.resumeChat,
  forkChat: api.forkChat,
  deleteChat: api.deleteChat,
  uploadFile: api.uploadFile,
  subagent: api.subagent,
  workflowAgent: api.workflowAgent,
  taskOutput: api.taskOutput,
  chatMcp: api.chatMcp,
  toggleChatMcp: api.toggleChatMcp,
  setChatClaudioMcp: api.setChatClaudioMcp,
  // The words in the UI language, as the schedules page says them: the API describes an expression only in English
  schedulePreview: async (cron, timezone) => {
    // Allow and Deny wait for this read, so it gives up long before a request's usual two minutes:
    // a pure computation on the server answers at once, and without it the prompt still has the expression
    const preview = await api.schedulePreview(cron, timezone, 3, SCHEDULE_PROMPT_PREVIEW_MS);
    const words = describeCron(cron);
    return words ? { ...preview, description: words } : preview;
  },
  orchestrationTemplate: (templateId) => api.orchestrationTemplate(templateId),
  accounts: () => api.accounts(),
  accountModels: (id) => api.accountModels(id),
  switchChatAccount: api.switchChatAccount,
  streamUrl: (chatId, since) => withToken(`${activeBase()}/chats/${enc(chatId)}/stream?since=${since}`),
  contentUrl: (uploadId) => withToken(`${activeBase()}/uploads/${enc(uploadId)}/content`),
};

// Lazy here, so `Controls` stays its own chunk
const slots: ChatUiConfig['slots'] = {
  StartOptions: lazy(() => import('../pages/chat/Controls').then((m) => ({ default: m.StartOptions }))),
  LiveOptions: lazy(() => import('../pages/chat/Controls').then((m) => ({ default: m.LiveOptions }))),
  // Lazy too: the comparator is only needed once a reader opens an edit
  Diff: lazy(() => import('../components/changes/DiffSlot').then((m) => ({ default: m.DiffSlot }))),
  // Not lazy: a row names its teammate as it draws, and a suspended name would blank the step
  Teammate: TeammateName,
  // Light, and a card draws them as it mounts
  ModelName,
  EffortName,
};

const paths: ChatUiConfig['paths'] = {
  chat: (id) => `/chats/${enc(id)}`,
  chatChangeStep: (chatId, stepId) => reviewLink(reviewPath.chat(chatId), { lens: 'steps', step: stepId }),
  connectors: settingsHref('connections', { section: 'connectors' }),
};

/** Mounted around `<App />`: the detail panel, orchestrations, work items and Home use chat hooks too. */
export function AppChatUi({ children }: { children: ReactNode }) {
  const fallbackInterval = useFallbackInterval();
  const labelOf = useProviderLabel();
  const value = useMemo<ChatUiConfig>(
    () => ({ client: chatClient, agentNameFor: (chat) => labelOf(chat.provider), fallbackInterval, paths, slots }),
    [fallbackInterval, labelOf],
  );
  return <ChatUiProvider value={value}>{children}</ChatUiProvider>;
}
