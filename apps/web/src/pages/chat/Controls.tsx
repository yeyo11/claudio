import type { Chat, Effort, PermissionMode } from '@claudio/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChatToolsPicker } from '../../components/ChatToolsPicker';
import { EffortField } from '../../components/EffortPicker';
import { useEffortUnavailable } from '../../lib/provider-status';
import { Select } from '@claudio/ui/components/controls';
import { ErrorBox, Tag } from '@claudio/ui/components/ui';
import { ModelCombobox, PERMISSION_MODES } from '../../components/ui';
import { modeLabel } from '@claudio/chat-ui/lib/wire-words';
import { api, keys } from '../../api';
import type { StartChoices } from '@claudio/chat-ui/lib/context';
import { serversOn, useLiveServers } from '@claudio/chat-ui/composer/ServersPanel';
import { formatNumber } from '@claudio/ui/lib/format';
import { CLAUDE_CODE_ID } from '../../lib/provider-state';

/*
 * The controls built on Radix selects, in one module so the chat page can load them lazily.
 */

/**
 * The account whose models a chat's pickers offer: the one it runs on (or was switched to), else the
 * one its last process ran on. Null when it has none, and the default account's list stands in.
 */
export function chatAccount(chat: Pick<Chat, 'account' | 'executions'>): string | null {
  return chat.account ?? chat.executions.at(-1)?.account ?? null;
}

/** Permission mode and model of a live execution, changed in place: it switches at once. */
export function LiveSettings({ chat }: { chat: Chat }) {
  const { t } = useTranslation(['chat', 'components']);
  const queryClient = useQueryClient();
  const [model, setModel] = useState('');
  const update = useMutation({
    mutationFn: (change: { permissionMode?: PermissionMode; model?: string }) => api.updateChat(chat.id, change),
    onSuccess: () => {
      setModel('');
      void queryClient.invalidateQueries({ queryKey: keys.chatScope(chat.id) });
    },
  });
  const current = chat.execution;
  return (
    <>
      <dt>{t('chat:runView.permissions')}</dt>
      <dd>
        <Select<PermissionMode>
          aria-label={t('components:runSettings.permissionMode')}
          value={current?.permissionMode ?? 'manual'}
          disabled={update.isPending}
          onChange={(permissionMode) => update.mutate({ permissionMode })}
          options={PERMISSION_MODES.map((m) => ({ value: m, label: modeLabel(m) }))}
        />
      </dd>
      <dt>{t('chat:shared.model')}</dt>
      <dd>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (model.trim()) update.mutate({ model: model.trim() });
          }}
        >
          <ModelCombobox account={chatAccount(chat)} aria-label={t('chat:shared.model')} placeholder={current?.model ?? chat.model ?? t('chat:shared.default')} value={model} onChange={setModel} />
          {model.trim() && (
            <button type="submit" className="btn btn-small" disabled={update.isPending}>
              {t('components:runSettings.set')}
            </button>
          )}
        </form>
      </dd>
      {update.error && (
        <dd className="kv-full">
          <ErrorBox error={update.error} />
        </dd>
      )}
    </>
  );
}

/**
 * What the status line opens on a live chat: what can be switched in place, and two rows that lead
 * to the real lists (the "+" menu's Servers panel and the inspector's Environment tab) rather than
 * repeating them.
 */
export function LiveOptions({ chat, onOpenServers, onOpenEnvironment }: { chat: Chat; onOpenServers?: () => void; onOpenEnvironment?: () => void }) {
  const { t } = useTranslation(['chat', 'work']);
  const { tools } = chat;
  const servers = useLiveServers(chat, Boolean(chat.execution));
  const count = serversOn(servers.data);
  // The same words as the chip: the live count while the process is up, else what the chat started with
  const serversWords = count
    ? t('composerMenu.serversOn', { on: formatNumber(count.on), total: formatNumber(count.total) })
    : tools?.mcp
      ? tools.mcp.servers.length > 0
        ? t('status.serversChosen', { count: tools.mcp.servers.length })
        : t('tools.card.noServers')
      : t('tools.card.serversDefault');
  const presetWords = tools?.preset ? tools.preset.name : t('tools.noPreset');
  return (
    <div className="stack-tight">
      <dl className="kv kv-narrow">
        <LiveSettings chat={chat} />
        <dt>{t('tools.preset')}</dt>
        <dd>
          <LinkRow onClick={onOpenEnvironment}>
            {presetWords} · {t('status.viewRules')}
          </LinkRow>
        </dd>
        <dt>{t('tools.servers')}</dt>
        <dd>
          <LinkRow onClick={onOpenServers}>
            <span className="tnum">{serversWords}</span>
          </LinkRow>
        </dd>
      </dl>
      <p className="small muted">{t('status.liveHint')}</p>
    </div>
  );
}

/** A row's value that opens the list it summarises; plain text when the page gave no way to open it. */
function LinkRow({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  if (!onClick) return <span>{children}</span>;
  return (
    <button type="button" className="link-btn" onClick={onClick}>
      {children}
      <span aria-hidden> ›</span>
    </button>
  );
}

/**
 * `StartChoices` is spread into the resume and fork request as it is, so the effort rides in it. The
 * chat package does not name the key, hence the wider type here.
 */
type StartEffort = StartChoices & { effort?: Effort };

export function withEffort(value: StartChoices, effort: Effort | ''): StartChoices {
  const next: StartEffort = { ...value };
  if (effort) next.effort = effort;
  else delete next.effort;
  return next;
}

/** What a resume or a fork may start with; left alone, it starts as the chat last ran. */
export function StartOptions({ chat, value, onChange, forking }: { chat: Chat; value: StartChoices; onChange: (next: StartChoices) => void; forking: boolean }) {
  const { t } = useTranslation(['chat', 'work']);
  const last = chat.executions.at(-1);
  const chosen: StartEffort = value;
  const unavailable = useEffortUnavailable(chat.provider);
  return (
    <div className="chat-options">
      <label>
        {t('chat:runView.permissions')}
        <Select<PermissionMode | ''>
          aria-label={t('controls.permissionModeNew')}
          value={value.permissionMode ?? ''}
          onChange={(permissionMode) => onChange({ ...value, permissionMode: permissionMode || undefined })}
          options={[{ value: '', label: last ? t('controls.asBefore', { mode: modeLabel(last.permissionMode) }) : t('controls.default') }, ...PERMISSION_MODES.map((m) => ({ value: m, label: modeLabel(m) }))]}
        />
      </label>
      <label>
        {t('chat:shared.model')}
        <ModelCombobox
          account={chatAccount(chat)}
          aria-label={t('controls.modelNew')}
          placeholder={last?.model ?? chat.model ?? t('chat:shared.default')}
          value={value.model ?? ''}
          onChange={(model) => onChange({ ...value, model: model.trim() ? model : undefined })}
        />
      </label>
      <EffortField
        value={chosen.effort ?? ''}
        onChange={(effort) => onChange(withEffort(value, effort))}
        model={value.model ?? last?.model ?? chat.model}
        use="chat"
        inherited={last?.effort}
        unavailable={unavailable}
      />
      <ChatToolsPicker value={value} onChange={(tools) => onChange({ ...value, ...tools })} scope={{ projectId: chat.project?.id }} current={chat.tools ?? null} forking={forking} offerClaudio={!chat.claudioAssistant && chat.provider === CLAUDE_CODE_ID} />
    </div>
  );
}
