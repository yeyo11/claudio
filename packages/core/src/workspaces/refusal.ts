import type { WorkspaceRefusalCode } from '@claudio/shared';

const STATUS: Record<WorkspaceRefusalCode, number> = {
  'workspace-host-not-allowed': 400,
  'workspace-address-blocked': 400,
  'workspace-bad-archive': 400,
  'workspace-too-large': 413,
  'workspace-limit': 429,
  'workspace-not-found': 404,
  'workspace-expired': 410,
  'workspace-timeout': 408,
  'workspace-download-failed': 502,
};

/**
 * A workspace request refused for a reason the client acts on. `statusCode` and `reason` are what
 * the API's error handler turns into `{ error, code }`. The message never carries the source URL,
 * which holds the code host's short-lived token: it names the host at most.
 */
export class WorkspaceRefusal extends Error {
  readonly statusCode: number;
  readonly reason: WorkspaceRefusalCode;

  constructor(reason: WorkspaceRefusalCode, message: string) {
    super(message);
    this.reason = reason;
    this.statusCode = STATUS[reason];
  }
}

export const refuse = (reason: WorkspaceRefusalCode, message: string): WorkspaceRefusal => new WorkspaceRefusal(reason, message);
