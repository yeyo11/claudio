/**
 * What `--model` may be given, as the CLI itself lists it.
 *
 * The only source is the CLI's `initialize` handshake, read per account by `@claudio/accounts` (no
 * turn, no tokens) and cached under `<data>/accounts/models/`. It is what `/model` shows: filtered by
 * the account's subscription, in the CLI's order, with its own names and descriptions. Until it has
 * been read there is no list at all, and the picker says it is loading rather than offering guesses:
 * a list of Claudio's own (the aliases, the CLI's state file, names derived from model ids) went
 * stale with every release and showed entries `/model` did not.
 */
import type { ModelOption } from '@claudio/shared';

/** The options a picker offers: the CLI's list as given, or none before it has been read. */
export function modelOptions(listed: readonly ModelOption[] | null): ModelOption[] {
  return listed ? [...listed] : [];
}

/**
 * Every name the list gives one model: the option's value (an alias such as `sonnet`) and the id it
 * resolves to (`claude-sonnet-5-5`). A run records the id the CLI reports, while the picker holds the
 * alias, so either has to find the other.
 */
export function modelNames(listed: readonly ModelOption[] | null, model: string): string[] {
  const names = new Set([model]);
  for (const option of listed ?? []) {
    if (option.value === model && option.resolvedModel) names.add(option.resolvedModel);
    if (option.resolvedModel === model) names.add(option.value);
  }
  return [...names];
}
