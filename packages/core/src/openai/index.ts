// The OpenAI-compatible surface's pure half (docs/openai-compatible-api.md): request in, chat start
// out; RunEvent in, Chat Completions out; failures in OpenAI's error shape; the conversation rows.
export {
  chainKey as openAiChainKey,
  extendKey as openAiExtendKey,
  historyKey as openAiHistoryKey,
  keyAfterAnswer as openAiKeyAfterAnswer,
  seedKey as openAiSeedKey,
  type KeySeed as OpenAiKeySeed,
} from './conversation-key.ts';
export {
  answerStub as answerOpenAiStub,
  CLIENT_TIMEOUT_MESSAGE,
  CLIENT_TOOL_PREFIX,
  CLIENT_TOOLS_SERVER,
  ClientToolSession,
  clientToolName,
  clientToolsProblem,
  clientToolsServerEntry,
  MAX_CLIENT_TOOL_NAME,
  NOBODY_ANSWERS,
  resultsProblem,
  sameTools as sameClientTools,
  toolChoiceInstruction,
  trailingResults,
  type StubReply,
  type StubResult,
  type TrailingResults,
} from './client-tools.ts';
export { OpenAiConversationStore, type OpenAiConversation } from './conversations.ts';
export { fetchImage as fetchOpenAiImage, isPublicAddress, type FetchImageOptions } from './fetch-image.ts';
export { OPENAI_CONVERSATION_TTL_MS, sweepOpenAiChats, type OpenAiSweep, type OpenAiSweepDeps } from './sweep.ts';
export { failureOfSpendCap, failureOfThrown, openAiError, retryAfterSeconds, type OpenAiErrorResponse, type OpenAiFailure } from './errors.ts';
export {
  ChatCompletionTranslator,
  completionUsage,
  failureOfOutcome,
  finishReasonOf,
  structuredFailure as openAiStructuredFailure,
  tokenUsageOf,
  type ChatCompletionTranslatorOptions,
  type TurnEnd as OpenAiTurnEnd,
} from './events.ts';
export {
  chatTurnOf,
  parseChatCompletionRequest,
  renderCold as renderOpenAiCold,
  renderDelta as renderOpenAiDelta,
  renderResultsCold as renderOpenAiResultsCold,
  sameJsonSchema,
  translateRequest as translateOpenAiRequest,
  uploadImages as uploadOpenAiImages,
  type ChatTurn as OpenAiChatTurn,
  type ImageUploads as OpenAiImageUploads,
  type Parsed as OpenAiParsed,
  type RenderedPrompt as OpenAiRenderedPrompt,
} from './request.ts';
export {
  STREAM_DONE,
  type ChatCompletion,
  type ChatCompletionChunk,
  type ChatCompletionRequest,
  type ChatCompletionStreamItem,
  type ChatCompletionUsage,
  type ChatMessage as OpenAiChatMessage,
  type ClientTool as OpenAiClientTool,
  type FinishReason as OpenAiFinishReason,
  type ImageRef as OpenAiImageRef,
  type OpenAiErrorBody,
  type ToolCall as OpenAiToolCall,
  type ToolChoice as OpenAiToolChoice,
} from './wire.ts';
