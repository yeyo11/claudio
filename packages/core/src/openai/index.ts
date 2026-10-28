// The OpenAI-compatible surface's pure half (docs/openai-compatible-api.md): request in, chat start
// out; RunEvent in, Chat Completions or Responses out; failures in OpenAI's error shape; the
// conversation and stored-response rows.
export {
  chainKey as openAiChainKey,
  imageDigest as openAiImageDigest,
  extendKey as openAiExtendKey,
  historyKey as openAiHistoryKey,
  keyAfterAnswer as openAiKeyAfterAnswer,
  policyKey as openAiPolicyKey,
  seedKey as openAiSeedKey,
  type KeySeed as OpenAiKeySeed,
} from './conversation-key.ts';
export {
  abandons as abandonsClientCalls,
  allowedToolNames,
  answerStub as answerOpenAiStub,
  CHAT_COMPLETION_RESULTS,
  CLIENT_ABANDONED_MESSAGE,
  CLIENT_TIMEOUT_MESSAGE,
  CLIENT_TOOL_PREFIX,
  CLIENT_TOOLS_SERVER,
  ClientToolSession,
  clientToolName,
  clientToolsProblem,
  clientToolsServerEntry,
  MAX_CLIENT_TOOL_NAME,
  missingResults,
  NOBODY_ANSWERS,
  listedIds as listedCallIds,
  RESPONSES_RESULTS,
  resultsProblem,
  sameTools as sameClientTools,
  toolChoiceInstruction,
  trailingResults,
  type ClientCall as OpenAiClientCall,
  type StubReply,
  type StubResult,
  type ResultsVocabulary,
  type TrailingResults,
} from './client-tools.ts';
export { OpenAiConversationStore, type OpenAiConversation } from './conversations.ts';
export { listedInputItems, STORED_IMAGE_URL_MAX, storedInputItems, type RequestInputItem as ResponseRequestInputItem, type StoredInputItem as ResponseStoredInputItem } from './stored-images.ts';
export { effectiveSystemPrompt, hasSystemMessages, OpenAiChatPromptStore, systemPromptParts, type ConversationBase, type SystemPromptParts } from './system-prompt.ts';
export { OpenAiResponseStore, type StoredResponse as OpenAiStoredResponse, type StoredResponseHead as OpenAiStoredResponseHead } from './responses-store.ts';
export {
  assistantOfOutput,
  keyAfterPrevious as openAiKeyAfterPrevious,
  parseResponsesRequest,
  responsesTurnOf,
  withPreviousOutput,
  type ResponseEcho,
  type ResponsesRequest,
} from './responses-request.ts';
export { responseUsage, ResponsesTranslator, type ResponsesTranslatorOptions, type ResponsesTurnEnd } from './responses-events.ts';
export type {
  FunctionCallItem as ResponseFunctionCallItem,
  InputItem as ResponseInputItem,
  OutputItem as ResponseOutputItem,
  ResponseDeleted,
  ResponseObject,
  ResponseStreamEvent,
} from './responses-wire.ts';
export { fetchImage as fetchOpenAiImage, isPublicAddress, type FetchImageOptions } from './fetch-image.ts';
export { OPENAI_CONVERSATION_TTL_MS, sweepOpenAiChats, type OpenAiSweep, type OpenAiSweepDeps } from './sweep.ts';
export { failureOfSpendCap, failureOfThrown, openAiError, retryAfterSeconds, type OpenAiErrorResponse, type OpenAiFailure } from './errors.ts';
export {
  ChatCompletionTranslator,
  completionUsage,
  failureOfOutcome,
  finishReasonOf,
  httpErrorOf as openAiHttpErrorOf,
  isTurnError as isOpenAiTurnError,
  structuredFailure as openAiStructuredFailure,
  tokenUsageOf,
  toolBlocked as openAiToolBlocked,
  type ChatCompletionTranslatorOptions,
  type TurnTranslator as OpenAiTurnTranslator,
  type TurnEnd as OpenAiTurnEnd,
  type TurnError as OpenAiTurnError,
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
// The confined API chat every `/v1` chat is (D14 of docs/plans/headless-image.md): the route reads a
// request's policy the way a start does, to key the conversation and compare a continuation with it
export { apiChatPolicy, CONFINED_PERMISSION_MODE, samePolicy } from '../confined-chat.ts';
export { declaredToolsProblem } from '../guards/declared.ts';
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
  type StartRefusedCode as OpenAiStartRefusedCode,
  type ToolCall as OpenAiToolCall,
  type ToolChoice as OpenAiToolChoice,
} from './wire.ts';
