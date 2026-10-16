import type { HostPreset } from './host/protocol.ts';

/*
 * Collaborators (docs/plans/collaborators.md), as the rest of the core sees it: the service, its
 * errors, the readers' sources the core fills, and the two settings of the environment the e2e
 * harness uses to run two installs on one machine without a network.
 */

export { CollaboratorsError, CollaboratorsService, type CollaboratorsDeps, type CollaboratorsErrorCode, type HostHandle } from './service.ts';
export type { OrchestrationResult, ReaderSources } from './readers.ts';

/** `CLAUDIO_COLLAB_PRESET=minimal`: no relay and no discovery, so peers are reached by their loopback tickets */
export const COLLAB_PRESET_ENV = 'CLAUDIO_COLLAB_PRESET';
/** `CLAUDIO_COLLAB_BIND=127.0.0.1:0`: where the endpoint binds; the binding's default otherwise */
export const COLLAB_BIND_ENV = 'CLAUDIO_COLLAB_BIND';

export function collabHostSettings(env: NodeJS.ProcessEnv = process.env): { preset: HostPreset; bindAddr: string | null } {
  return {
    preset: env[COLLAB_PRESET_ENV] === 'minimal' ? 'minimal' : 'n0',
    bindAddr: env[COLLAB_BIND_ENV]?.trim() || null,
  };
}

/**
 * Upload ids a chat's messages name: the `uploadId` of an image or document block, and the upload
 * folder of each path in an `<attached-files>` block (`uploads.ts` writes `<dir>/<id>/<name>`).
 */
export function uploadIdsIn(messages: readonly unknown[], uploadsDir: string): string[] {
  const ids = new Set<string>();
  const prefix = uploadsDir.endsWith('/') ? uploadsDir : `${uploadsDir}/`;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.uploadId === 'string') ids.add(record.uploadId);
    for (const [key, field] of Object.entries(record)) {
      if (typeof field === 'string' && (key === 'text' || key === 'content') && field.includes(prefix)) {
        for (const line of field.split('\n')) {
          const at = line.indexOf(prefix);
          if (at < 0) continue;
          const id = line.slice(at + prefix.length).split('/')[0];
          if (id && /^[A-Za-z0-9-]+$/.test(id)) ids.add(id);
        }
      } else if (typeof field === 'object') visit(field);
    }
  };
  visit(messages);
  return [...ids];
}
