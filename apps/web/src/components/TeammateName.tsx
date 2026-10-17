import type { SharedProject } from '@claudio/shared';
import { useSharedProjects } from '../lib/api/collaborators';
import { shortId } from '../pages/collaborators/model';

/** The person, install and project a copy comes from, as the catalog names them; null when it has no such copy */
export function teammateLabel(shared: readonly SharedProject[], owner: string, shareId: string | null): string | null {
  const copy = shared.find((s) => s.owner === owner && (shareId === null || s.shareId === shareId)) ?? shared.find((s) => s.owner === owner);
  if (!copy) return null;
  const who = copy.ownerLabel ? `${copy.ownerName} · ${copy.ownerLabel}` : copy.ownerName;
  return shareId !== null && copy.shareId === shareId ? `${who} · ${copy.name}` : who;
}

/**
 * Whose share a chat's tool read, for the chat package's `Teammate` slot: the name from the catalog
 * of what teammates share, or the install's short id, in mono, once that copy is gone or unread.
 */
export function TeammateName({ owner, shareId }: { owner: string; shareId: string | null }) {
  const shared = useSharedProjects();
  const label = shared.data ? teammateLabel(shared.data, owner, shareId) : null;
  return label ? (
    <span className="strong">{label}</span>
  ) : (
    <span className="mono" title={owner}>
      {shortId(owner)}
    </span>
  );
}
