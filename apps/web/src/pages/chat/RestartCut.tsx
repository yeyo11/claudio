import { useMutation, useQueryClient } from '@tanstack/react-query';
import { errorMessage, RESTART_CONTINUE_TEXT, type Chat, type Execution } from '@claudio/shared';
import { Play, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { chatKeys } from '@claudio/chat-ui/lib/context';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { formatDate, timeAgo, toMs } from '@claudio/ui/lib/format';
import { api } from '../../api';

/**
 * The execution a restart of Claudio cut in a person's chat, when nothing has continued it: one cut
 * less than an hour ago goes on by itself, so what is left here is an older cut, one the CLI could
 * not continue, or one cut again and again (docs/plans/survive-restarts.md, D7). Never an API,
 * internal or orchestration chat, nor one an owner (a flow, the assistant) continues.
 */
export function restartCut(chat: Chat): Execution | null {
  if (chat.alive || chat.control.mode !== 'resumable') return null;
  if (chat.origin !== 'claudio' && chat.origin !== 'external') return null;
  const last = chat.executions.at(-1);
  if (last?.outcome !== 'interrupted' || !last.endedAt) return null;
  if (last.purpose !== undefined && last.purpose !== 'person') return null;
  return last;
}

/** When `timeAgo` stops answering a time ago */
const OLD_MS = 30 * 24 * 60 * 60_000;

/** "Claudio restarted while this chat was working" and one click to continue the turn where it was cut. */
export function RestartCutBanner({ chat, cut }: { chat: Chat; cut: Execution }) {
  const { t } = useTranslation('chats');
  const queryClient = useQueryClient();
  const go = useMutation({
    // The same words the CLI reads when it continues a cut turn by itself, so the transcript shows Claudio's line, not the person's
    mutationFn: () => api.resumeChat(chat.id, { prompt: RESTART_CONTINUE_TEXT, permissionPrompts: 'host' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.chats });
      void queryClient.invalidateQueries({ queryKey: chatKeys.chatScope(chat.id) });
    },
  });
  const at = toMs(cut.endedAt) ?? Date.now();
  // Past a month `timeAgo` answers a bare date, which reads as "stopped Oct 12" without its "on"
  const when = Date.now() - at < OLD_MS ? t('restartCut.body', { ago: timeAgo(at) }) : t('restartCut.bodyOn', { date: formatDate(at) });
  return (
    <div className="alert alert-bad chat-banner restart-cut" role="status">
      <RotateCcw {...ICON} className="alert-icon" aria-hidden />
      <div className="alert-body">
        <strong>{t('restartCut.title')}</strong>
        <div>{when}</div>
        {go.error && <div role="alert">{t('restartCut.failed', { error: errorMessage(go.error) })}</div>}
      </div>
      {/* Held after it went through too: the banner stays until the chat reads back alive, and a second click would resume it twice */}
      <button className="btn btn-small" onClick={() => go.mutate()} disabled={go.isPending || go.isSuccess}>
        <Play {...ICON_SM} /> {t('restartCut.continue')}
      </button>
    </div>
  );
}
