import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { CreateTerminalRequest, Terminal, TerminalChangedEvent, TerminalStatus } from '@claudio/shared';
import { useToast } from '@claudio/ui/components/Toast';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { useClaudioEvents, useFallbackInterval } from '../../lib/feed';
import { orderTerminals } from './terminal-model';

/** Which terminals a list is of: a project's (any of its directories), one chat's, or all of them. */
export type TerminalScopeKey = { project: string } | { chat: string } | { all: true };

export const scopeKey = (scope: TerminalScopeKey): string => ('all' in scope ? 'all' : 'project' in scope ? `project:${scope.project}` : `chat:${scope.chat}`);

/** The query string's filter for a scope: nothing for all of them */
const filterOf = (scope: TerminalScopeKey): { project?: string; chat?: string } => ('all' in scope ? {} : scope);

/**
 * What a `terminal.changed` does to the cache. The event's status is the server's, not this client's:
 * the gate may still refuse this device (`needs-tunnel`, `remote-off`), so an available status is
 * read again through `GET /terminal` rather than written in. An unavailable one holds for every
 * client and is written at once, and then nothing else is read: the lists and the terminals sit
 * behind the same gate and would only answer 409. A terminal the event no longer lists was closed
 * and forgotten by the server, so its query is emptied from the event instead of asked again (404).
 */
export function applyTerminalEvent(queryClient: QueryClient, event: Pick<TerminalChangedEvent, 'terminals' | 'status'>): void {
  if (!event.status.available) {
    queryClient.setQueryData<TerminalStatus>(keys.terminalStatus, event.status);
    return;
  }
  void queryClient.invalidateQueries({ queryKey: keys.terminalStatus });
  void queryClient.invalidateQueries({ queryKey: ['terminal', 'list'] });
  for (const query of queryClient.getQueryCache().findAll({ queryKey: ['terminal', 'one'] })) {
    const id = query.queryKey[2];
    if (typeof id !== 'string') continue;
    queryClient.setQueryData<Terminal | null>(keys.terminalOne(id), event.terminals.find((terminal) => terminal.id === id) ?? null);
  }
}

/** The feature's state and the lists, kept fresh by `terminal.changed` */
function useTerminalFeed(): void {
  const queryClient = useQueryClient();
  useClaudioEvents((event) => {
    if (event.type === 'terminal.changed') applyTerminalEvent(queryClient, event);
  });
}

export function useTerminalStatus() {
  useTerminalFeed();
  return useQuery({ queryKey: keys.terminalStatus, queryFn: ({ signal }) => api.terminalStatus({ signal }), refetchInterval: useFallbackInterval() });
}

/**
 * Whether a terminal may be opened from this page now. Everything that opens one stays out of sight
 * until it is true; Settings is the only place that says why it is not.
 */
export function useTerminalAccess(): boolean {
  return useTerminalStatus().data?.available === true;
}

/** The terminals of a scope; never asked while the status says a terminal cannot be opened from here, which the route would answer with a refusal */
export function useTerminalList(scope: TerminalScopeKey, enabled = true) {
  const access = useTerminalAccess();
  const query = useQuery({
    queryKey: keys.terminalList(scopeKey(scope)),
    queryFn: ({ signal }) => api.terminals(filterOf(scope), { signal }),
    enabled: enabled && access,
    refetchInterval: useFallbackInterval(),
  });
  return { ...query, terminals: query.data ? orderTerminals(query.data) : [] };
}

/**
 * One terminal by id, for the screens that show one alone. `forget` drops the id before it is closed
 * (or once the server says it was): the query stops, the panel unmounts and its socket with it, so
 * nothing asks for a terminal that no longer exists. `remember` undoes it when the close failed.
 */
export function useTerminalOne(id: string) {
  const access = useTerminalAccess();
  const [forgotten, setForgotten] = useState(false);
  const query = useQuery({ queryKey: keys.terminalOne(id), queryFn: ({ signal }): Promise<Terminal | null> => api.terminal(id, { signal }), enabled: access && !forgotten });
  const forget = useCallback(() => setForgotten(true), []);
  const remember = useCallback(() => setForgotten(false), []);
  return { ...query, terminal: forgotten ? null : (query.data ?? null), forgotten, forget, remember };
}

export function useOpenTerminal(onOpened?: (terminal: Terminal) => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation('terminal');
  return useMutation({
    mutationFn: (request: CreateTerminalRequest) => api.createTerminal(request),
    onSuccess: (terminal) => {
      void queryClient.invalidateQueries({ queryKey: ['terminal', 'list'] });
      onOpened?.(terminal);
    },
    onError: (error) => toast.error(t('notices.openFailed'), error),
  });
}

export function useCloseTerminal(onClosed?: () => void) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { t } = useTranslation('terminal');
  return useMutation({
    mutationFn: (id: string) => api.closeTerminal(id),
    onSuccess: (_closed, id) => {
      // The server forgets a terminal it closed: its own query is dropped, never read again (it would be a 404)
      queryClient.removeQueries({ queryKey: keys.terminalOne(id), exact: true });
      void queryClient.invalidateQueries({ queryKey: ['terminal', 'list'] });
      onClosed?.();
    },
    onError: (error) => toast.error(t('notices.closeFailed'), error),
  });
}
