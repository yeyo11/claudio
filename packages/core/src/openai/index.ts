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
export { OpenAiConversationStore, type OpenAiConversation } from './conversations.ts';
export { failureOfSpendCap, failureOfThrown, openAiError, retryAfterSeconds, type OpenAiErrorResponse, type OpenAiFailure } from './errors.ts';
export {
  ChatCompletionTranslator,
  completionUsage,
  failureOfOutcome,
  finishReasonOf,
  tokenUsageOf,
  type ChatCompletionTranslatorOptions,
  type TurnEnd as OpenAiTurnEnd,
} from './events.ts';
export {
  chatTurnOf,
  parseChatCompletionRequest,
  renderCold as renderOpenAiCold,
  renderDelta as renderOpenAiDelta,
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
