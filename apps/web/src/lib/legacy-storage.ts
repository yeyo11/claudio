/**
 * Before the rename every key this app kept in the browser started with `agentry` (`agentry-theme`,
 * `agentry:filters:…`, `agentry.token`, `agentry-composer-draft:<chat>`…); now they start with
 * `claudio`, with the rest of the key unchanged. A key is carried over once: copied to its new name
 * unless that already holds a value (the newer one wins), then removed, so the next start finds
 * nothing left to move.
 *
 * It can go once no browser that ran a build from before the rename is still in use.
 */
const LEGACY = /^agentry(?=[-:.])/;

type KeyStore = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

/** Moves every old key to its new name; answers how many were moved. */
export function migrateLegacyStorage(storage: KeyStore): number {
  // Read the names first: removing while walking the indices would skip keys
  const old: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && LEGACY.test(key)) old.push(key);
  }
  let moved = 0;
  for (const key of old) {
    const value = storage.getItem(key);
    const next = key.replace(LEGACY, 'claudio');
    try {
      if (value !== null && storage.getItem(next) === null) {
        storage.setItem(next, value);
        moved++;
      }
    } catch {
      // Over quota: the old value is dropped rather than kept for ever under a name nothing reads
    }
    storage.removeItem(key);
  }
  return moved;
}
