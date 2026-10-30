import type { ProviderStatus, SetupState } from '@claudio/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, keys } from '../api';

/** Nothing at all was found: every provider is missing, so the Agents step says so instead of listing them. */
export const nothingFound = (statuses: ProviderStatus[]): boolean => statuses.length > 0 && statuses.every((status) => status.state === 'not-installed');

/**
 * The setup assistant stands in for the app on a first start, until it is finished or skipped
 * (`setupSeen`, which `GET /setup` answers as `seen`). Once seen it never comes back: everything it
 * sets up stays in Settings, where Home and the status bar point when nothing is ready.
 */
export const shouldShowSetup = (setup: Pick<SetupState, 'seen'>): boolean => !setup.seen;

export type SetupGate = { state: 'pending' | 'hidden' } | { state: 'shown'; finish: () => void };

/** A query as the gate reads it: what it holds, and whether its last read failed. */
interface GateRead<T> {
  data: T | undefined;
  isError: boolean;
}

/**
 * The gate's decision, from its two reads. A failed read hides the assistant only when there is
 * nothing to decide with: react-query keeps the last answer through a refetch that fails (`isError`
 * with data), and the wizard's own saves refetch the setup state, which probes every tool. One
 * transient failure there must not drop the person into the app halfway through.
 */
export function setupGateState(settings: GateRead<{ setupSeen: boolean }>, setup: GateRead<Pick<SetupState, 'seen'>>, dismissed: boolean): SetupGate['state'] {
  if (dismissed) return 'hidden';
  if (settings.data === undefined) return settings.isError ? 'hidden' : 'pending';
  if (settings.data.setupSeen) return 'hidden';
  if (setup.data === undefined) return setup.isError ? 'hidden' : 'pending';
  return shouldShowSetup(setup.data) ? 'shown' : 'hidden';
}

/**
 * Whether the assistant stands in for the app. A read that fails before it ever answered hides it
 * (`setupGateState`): the assistant must never be
 * what keeps a person out of an app that would have worked. `finish` dismisses it for this page load
 * and records it with `POST /setup/seen`; when the server cannot record it (read-only, or the
 * environment owns the setting) it is only remembered until the page reloads.
 */
export function useSetupGate(): SetupGate {
  const queryClient = useQueryClient();
  // `setupSeen` comes from the app settings, a file read; `GET /setup` probes every tool, which can
  // take seconds on a cold start, and every start after the first would wait on it for nothing. So
  // the settings decide, and the setup state is read only when the assistant is about to show.
  const settings = useQuery({ queryKey: keys.appSettings, queryFn: api.appSettings });
  const seen = settings.data?.setupSeen;
  const setup = useQuery({ queryKey: keys.setup, queryFn: ({ signal }) => api.setup({ signal }), enabled: seen === false });
  const [dismissed, setDismissed] = useState(false);
  const save = useMutation({
    mutationFn: api.markSetupSeen,
    onSuccess: (next: SetupState) => {
      queryClient.setQueryData(keys.setup, next);
      void queryClient.invalidateQueries({ queryKey: keys.appSettings });
    },
  });

  const state = setupGateState(settings, setup, dismissed);
  if (state !== 'shown') return { state };
  return {
    state: 'shown',
    finish: () => {
      setDismissed(true);
      save.mutate();
    },
  };
}
