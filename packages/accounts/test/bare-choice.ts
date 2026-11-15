import type { Choice } from '../src/index.ts';

/**
 * A choice without its explanation (`why`): the tests written before the project rules pin which
 * account is taken and why it is not the current one, and choose-rules.test.ts pins the explanation.
 */
export const bare = (c: Choice): Omit<Choice, 'why'> => ({ account: c.account, reason: c.reason, waitUntil: c.waitUntil, ...(c.credits ? { credits: c.credits } : {}) });
