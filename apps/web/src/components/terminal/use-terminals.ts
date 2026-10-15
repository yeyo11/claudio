import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateTerminalRequest, Terminal, TerminalStatus } from '@claudio/shared';
import { useToast } from '@claudio/ui/components/Toast';
import { useTranslation } from 'react-i18next';
import { api, keys } from '../../api';
import { useAgentryEvents, useFallbackInterval } from '../../lib/feed';
import { orderTerminals } from './terminal-model';

/** Which terminals a list is of: a project's (any of its directories) or one chat's. */
export type TerminalScopeKey = { project: string } | { chat: string };

export const scopeKey = (scope: TerminalScopeKey): string => ('project' in scope ? `project:${scope.project}` : `chat:${scope.chat}`);

/**
 * The feature's state and the list of terminals, kept fresh by `terminal.changed`: the event carries
 * the whole status, which is written in place, and the lists are read again because each is filtered.
 */
function useTerminalFeed(): void {
  const queryClient = useQueryClient();
  useAgentryEvents((event) => {
    if (event.type !== 'terminal.changed') return;
    queryClient.setQueryData<TerminalStatus>(keys.terminalStatus, event.status);
    void queryClient.invalidateQueries({ queryKey: ['terminal', 'list'] });
    void queryClient.invalidateQueries({ queryKey: ['terminal', 'one'] });
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

export function useTerminalList(scope: TerminalScopeKey, enabled = true) {
  const query = useQuery({
    queryKey: keys.terminalList(scopeKey(scope)),
    queryFn: ({ signal }) => api.terminals(scope, { signal }),
    enabled,
    refetchInterval: useFallbackInterval(),
  });
  return { ...query, terminals: query.data ? orderTerminals(query.data) : [] };
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
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['terminal', 'list'] });
      onClosed?.();
    },
    onError: (error) => toast.error(t('notices.closeFailed'), error),
  });
}
