import { createContext, useContext, type ComponentType, type ReactElement, type ReactNode } from 'react';
import type {
  Account,
  AgentTranscript,
  Attachment,
  BackgroundTaskOutput,
  Chat,
  ChatBackgroundTask,
  ChatDetail,
  ChatMcpServers,
  ChatMessageRequest,
  ChatMessageResponse,
  ChatSummary,
  ForkChatRequest,
  McpSelection,
  ModelOption,
  PermissionMode,
  PermissionDecision,
  PermissionRequest,
  ResumeChatRequest,
  SwitchChatAccountResponse,
} from '@claudio/shared';
import { RUN_TAG } from './chat-pages';

/** What a resume or a fork may start with; a key left out keeps what the chat had. */
export interface StartChoices {
  /** `null` asks for no preset at all: not the default on a new chat, not the one it had on a resume */
  toolPreset?: string | null;
  /** `null` goes back to the servers the CLI loads on its own, an object picks exactly those */
  mcp?: McpSelection | null;
  /** Claudio's own MCP server for the chat; absent keeps what it has */
  claudioMcp?: boolean;
  permissionMode?: PermissionMode;
  model?: string;
}

/** What the chat package asks of the server. `api` in apps/web satisfies it, plus two URL builders. */
export interface ChatClient {
  chat(id: string, page?: { limit?: number; before?: number }, o?: { signal?: AbortSignal }): Promise<ChatDetail>;
  chatPermissions(id: string): Promise<PermissionRequest[]>;
  chatTasks(id: string): Promise<ChatBackgroundTask[]>;
  answerPermission(id: string, requestId: string, decision: PermissionDecision): Promise<unknown>;
  sendMessage(id: string, req: ChatMessageRequest): Promise<ChatMessageResponse>;
  resumeChat(id: string, req: ResumeChatRequest): Promise<ChatSummary>;
  forkChat(id: string, req: ForkChatRequest): Promise<ChatSummary>;
  deleteChat(id: string): Promise<{ ok: true }>;
  uploadFile(file: File): Promise<Attachment>;
  subagent(chatId: string, agentId: string, after?: number): Promise<AgentTranscript>;
  workflowAgent(chatId: string, workflowId: string, agentId: string, after?: number): Promise<AgentTranscript>;
  taskOutput(chatId: string, taskId: string, offset?: number): Promise<BackgroundTaskOutput>;
  /** The MCP servers of a chat's live process, connectors included */
  chatMcp(id: string): Promise<ChatMcpServers>;
  /** Switches one of them on or off in the running process */
  toggleChatMcp(id: string, name: string, enabled: boolean): Promise<ChatMcpServers>;
  /** Switches Claudio's own MCP server in the running process, and keeps the choice on the chat */
  setChatClaudioMcp(id: string, enabled: boolean): Promise<ChatMcpServers>;
  /** The accounts a chat could run on */
  accounts(): Promise<Account[]>;
  /** The models one account offers */
  accountModels(id: string): Promise<ModelOption[]>;
  /** Moves the chat to another account: at once when idle, when the turn ends when working; the current account cancels a pending move */
  switchChatAccount(id: string, accountId: string): Promise<SwitchChatAccountResponse>;
  /** The SSE URL of one chat's stream, with the token when the wrapper is guarded. */
  streamUrl(chatId: string, since: number): string;
  /** Where an upload's bytes are served (`/api/uploads/:id/content` today). */
  contentUrl(uploadId: string): string;
}

export interface ChatUiConfig {
  client: ChatClient;
  /** The name of the agent a chat runs on, as the person reads it: the app derives it from the provider's label. */
  agentNameFor(chat: ChatSummary): string;
  /** The app's polling fallback while its event feed is down (useFallbackInterval), as a value. */
  fallbackInterval: number | false;
  paths: {
    /** '/chats/:id', after a fork */
    chat(id: string): string;
    /** The review screen at one step */
    chatChangeStep(chatId: string, stepId: string): string;
    /** The connectors page: where one waiting for its authorisation says how to give it */
    connectors: string;
  };
  slots: {
    StartOptions: ComponentType<{ chat: Chat; value: StartChoices; onChange(next: StartChoices): void; forking: boolean }>;
    /**
     * `onOpenServers` opens the "+" menu's Servers panel and `onOpenEnvironment` the app's Environment
     * tab, so the popover's rows lead to the real lists instead of repeating them
     */
    LiveOptions: ComponentType<{ chat: Chat; onOpenServers?: () => void; onOpenEnvironment?: () => void }>;
    /** A patch as the app's comparator draws it: the chat package must not import the app's diff (design system §5) */
    Diff: ComponentType<{ path: string; patch: string }>;
    /**
     * Who shares a copy a tool call read (`owner`, an install's endpoint id), in the person's words:
     * the app knows its teammates, the chat package does not. Absent, the row names the install's id
     */
    Teammate?: ComponentType<{ owner: string; shareId: string | null }>;
  };
}

const ChatUiContext = createContext<ChatUiConfig | null>(null);

export function ChatUiProvider({ value, children }: { value: ChatUiConfig; children: ReactNode }): ReactElement {
  return <ChatUiContext.Provider value={value}>{children}</ChatUiContext.Provider>;
}

/** Throws outside the provider: a chat component without a client is a wiring bug, not a state. */
/** The config when a provider is above, null otherwise: for a row that only adds to what it shows */
export function useOptionalChatUi(): ChatUiConfig | null {
  return useContext(ChatUiContext);
}

export function useChatUi(): ChatUiConfig {
  const config = useContext(ChatUiContext);
  if (!config) throw new Error('useChatUi needs a ChatUiProvider above it');
  return config;
}

/**
 * The keys the chat package reads and writes. `lib/events.ts` invalidates by prefix, so each
 * prefix travels with the keys under it (`agentDetail` with `agent`, `taskOutput` with `output`).
 * apps/web spreads them into `keys`, unchanged.
 */
export const chatKeys = {
  chats: ['chats'] as const,
  /** Prefix of a chat's page and of everything read for it */
  chatScope: (id: string) => ['chat', id] as const,
  chat: (id: string) => ['chat', id, 'transcript'] as const,
  /** The pages of a chat read back from its newest one, kept across visits */
  chatEarlier: (id: string) => ['chat', id, 'transcript', RUN_TAG] as const,
  chatPermissions: (id: string) => ['chat', id, 'permissions'] as const,
  chatTasks: (chatId: string) => ['tasks', 'chat', chatId] as const,
  agentDetail: ['agent-detail'] as const,
  agent: (chatId: string, workflowId: string, agentId: string) => ['agent-detail', chatId, workflowId, agentId] as const,
  taskOutput: ['task-output'] as const,
  output: (chatId: string, taskId: string) => ['task-output', chatId, taskId] as const,
};
