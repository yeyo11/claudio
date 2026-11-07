import type { PermissionDecision } from '@claudio/shared';
import type { SessionIO } from '../driver.ts';

/** A control request the CLI has not answered by then is not going to be answered */
const CONTROL_TIMEOUT_MS = 15_000;

// The requests below are typed as the Agent SDK declares them (`@anthropic-ai/claude-agent-sdk`
// 0.3.156, `sdk.d.ts`; the interrupt's answer as 0.3.319 types it), the vendor's documented surface of
// the control protocol.

/** `SDKControlInterruptRequest`: interrupts the turn under way. Nothing else on it is documented, so nothing else is sent. */
export interface InterruptRequest {
  subtype: 'interrupt';
}

/**
 * `SDKControlBackgroundTasksRequest`: backgrounds the foreground task its `tool_use` started (a Bash
 * command or a subagent); the call returns at once with a "running in the background" result and the
 * turn goes on. The SDK's `backgroundTasks(toolUseId)` reads `backgrounded` off the answer, as true
 * when the field is missing, and false "only when `toolUseId` was given and it matched no foreground task".
 */
export interface BackgroundTasksRequest {
  subtype: 'background_tasks';
  tool_use_id?: string;
}

/**
 * `SDKControlCancelAsyncMessageRequest`: "drops a pending async user message from the command queue
 * by uuid. No-op if already dequeued for execution." The SDK's `cancelAsyncMessage(uuid)` answers the
 * answer's `cancelled`.
 */
export interface CancelAsyncMessageRequest {
  subtype: 'cancel_async_message';
  message_uuid: string;
}

/**
 * The `system/init` capability that promises the interrupt receipt: the Agent SDK (0.3.319,
 * `SDKSystemMessage.capabilities`) says to feature-detect on it rather than on the version, and to
 * check each capability "for exactly the behavior you use".
 */
export const INTERRUPT_RECEIPT = 'interrupt_receipt_v1';

/**
 * What the CLI answers an interrupt with: `SDKControlInterruptResponse` in the Agent SDK (0.3.319),
 * whose `still_queued` lists the uuids of the messages that survive the interrupt ("commands still in
 * the queue, plus any batch already dequeued for the imminent turn"), written before the interrupted
 * turn's result. The SDK types it as the answer of a CLI that advertises {@link INTERRUPT_RECEIPT} in
 * its `system/init`, and an older CLI "send[s] an empty success response with no still_queued field".
 * So it is read only from a process whose init advertised that capability: an answer that happens to
 * carry the field without the promise says nothing Claudio may settle a message on.
 */
export function stillQueuedOf(response: Record<string, unknown>, capabilities: ReadonlySet<string>): string[] | null {
  if (!capabilities.has(INTERRUPT_RECEIPT)) return null;
  const listed = response.still_queued;
  return Array.isArray(listed) && listed.every((id): id is string => typeof id === 'string') ? listed : null;
}

/** A person's decision in the shape `can_use_tool` expects; allowing always carries the input. */
function toControlDecision(decision: PermissionDecision, input: Record<string, unknown>): Record<string, unknown> {
  if (decision.behavior === 'deny') return { behavior: 'deny', message: decision.message ?? 'denied' };
  return {
    behavior: 'allow',
    updatedInput: decision.updatedInput ?? input,
    ...(decision.updatedPermissions?.length ? { updatedPermissions: decision.updatedPermissions } : {}),
  };
}

/**
 * The control protocol of one process: requests Claudio sends down stdin and waits on
 * (`interrupt`, `background_tasks`, `cancel_async_message`, `set_permission_mode`, `set_model`,
 * `mcp_status`, `mcp_toggle`, `mcp_set_servers`, `get_context_usage`), and the CLI's own
 * (`can_use_tool`), which it holds until they are answered.
 */
export class ControlChannel {
  private seq = 0;
  /** Requests sent to the CLI, by request_id, waiting for its control_response */
  private readonly pending = new Map<string, { resolve: (response: Record<string, unknown>) => void; reject: (err: Error) => void }>();
  /** The input each permission question was asked with: allowing it answers with that input unless changed */
  private readonly asked = new Map<string, Record<string, unknown>>();

  constructor(private readonly io: SessionIO) {}

  write(message: unknown): void {
    this.io.write(`${JSON.stringify(message)}\n`);
  }

  /** Sends a control request down stdin and resolves with the CLI's response. */
  request(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const requestId = `claudio-${String(++this.seq)}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`the CLI did not answer ${String(request.subtype)} in time`));
      }, CONTROL_TIMEOUT_MS);
      timer.unref();
      this.pending.set(requestId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolvePromise(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.write({ type: 'control_request', request_id: requestId, request });
    });
  }

  /** The CLI answered one of ours. */
  settle(response: Record<string, unknown>): void {
    const requestId = typeof response.request_id === 'string' ? response.request_id : null;
    const control = requestId ? this.pending.get(requestId) : undefined;
    if (!control || !requestId) return;
    this.pending.delete(requestId);
    if (response.subtype === 'error') control.reject(new Error(String(response.error ?? 'the CLI refused the request')));
    else control.resolve((response.response ?? {}) as Record<string, unknown>);
  }

  /** The CLI asks for something Claudio does not handle: an answer still has to come, or it waits for it. */
  refuse(requestId: string, subtype: unknown): void {
    this.write({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error: `Claudio does not handle ${String(subtype)}` },
    });
  }

  /** Remembers what a `can_use_tool` request was about, for its answer. */
  ask(requestId: string, input: Record<string, unknown>): void {
    this.asked.set(requestId, input);
  }

  forget(requestId: string): void {
    this.asked.delete(requestId);
  }

  /** The answer goes to the process that asked, and nobody is waiting for it once that is gone. */
  answer(requestId: string, decision: PermissionDecision): void {
    const input = this.asked.get(requestId) ?? {};
    this.asked.delete(requestId);
    if (!this.io.up()) return;
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response: toControlDecision(decision, input) },
    });
  }

  dispose(reason: string): void {
    for (const control of this.pending.values()) control.reject(new Error(reason));
    this.pending.clear();
    this.asked.clear();
  }
}
