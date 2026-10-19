import type { Effort, NewChatRequest, PermissionMode } from '@claudio/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, FolderOpen, MessageSquare, Network, Search, X, type LucideIcon } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { api, keys, useAccounts, useOverview, useProjects } from '../api';
import { useAttachments } from '@claudio/chat-ui/components/Attachments';
import { ChatToolsPicker, type ToolChoices } from '../components/ChatToolsPicker';
import { NEW_ORCHESTRATION_PATH } from '../components/CommandPalette';
import { Combobox, Select, Switch } from '@claudio/ui/components/controls';
import { AccountList } from '@claudio/chat-ui/composer/AccountList';
import { accountRow } from '@claudio/chat-ui/lib/account-choice';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { Illustration } from '@claudio/ui/components/illustrations';
import { useProjectScope } from '../lib/project-scope';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { ErrorBox, Field, Segmented, usePageTitle } from '@claudio/ui/components/ui';
import { ModelCombobox, PERMISSION_MODES } from '../components/ui';
import { EffortField } from '../components/EffortPicker';
import { useEffortUnavailable } from '../lib/provider-status';
import { CLAUDE_CODE_ID } from '../lib/provider-state';
import { useProviders } from '../lib/providers';
import { upperFirst } from '@claudio/chat-ui/lib/agent';
import { modeLabel } from '@claudio/chat-ui/lib/wire-words';
import { OptionsPanel, StartComposer, StatusChips } from '@claudio/chat-ui/composer/Composer';
import type { RichEditorHandle } from '@claudio/chat-ui/composer/editor/RichEditor';

type Kind = 'chat' | 'orchestration';

/** Each example with the tint of what it asks for: reading, searching, fixing. */
const EXAMPLES: ReadonlyArray<{ key: 'one' | 'two' | 'three'; icon: LucideIcon; tone: 'info' | 'idle' | 'ok' }> = [
  { key: 'one', icon: MessageSquare, tone: 'info' },
  { key: 'two', icon: Search, tone: 'idle' },
  { key: 'three', icon: Check, tone: 'ok' },
];

/**
 * Where a chat starts: what it is for, the box to write the first message in, and a few things to
 * ask. Nothing is a form to fill in: the defaults start a chat, and everything that can be chosen
 * is one press away on the chips of the box. On a phone the box sits at the bottom, where the
 * chat's own box will be once it starts.
 */
export function NewChat() {
  const { t } = useTranslation('chats');
  const { t: tc } = useTranslation('chat');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const projects = useProjects(false);
  const scope = useProjectScope();
  const overview = useOverview();
  const narrow = useMediaQuery(NARROW);
  // A prompt another page prepared (the fix of failing checks, with the project's flow off) arrives in the route's state
  const handed = (useLocation().state as { prompt?: unknown } | null)?.prompt;
  const [initialPrompt] = useState(typeof handed === 'string' ? handed : '');
  const files = useAttachments();
  const box = useRef<RichEditorHandle>(null);
  const [cwd, setCwd] = useState(params.get('cwd') ?? scope.project?.path ?? '');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<Effort | ''>('');
  // '' lets the rotation policy choose; only offered once there is more than one account to choose between
  const [account, setAccount] = useState('');
  const accounts = useAccounts().data ?? [];
  // Chosen is the row in use; '' (automatic) matches none of them
  const accountRows = accounts.map((a) => accountRow(a, { account, model: null }, undefined));
  const [permissionMode, setPermissionMode] = useState<PermissionMode | ''>('');
  const [askHere, setAskHere] = useState(true);
  const [appendSystemPrompt, setAppendSystemPrompt] = useState('');
  const [tools, setTools] = useState<ToolChoices>({});
  const [options, setOptions] = useState(false);
  usePageTitle(t('new.title'));
  const provider = useProviders().data?.find((p) => p.id === CLAUDE_CODE_ID);
  const hasMcp = !provider || provider.capabilities.includes('mcp');
  const effortUnavailable = useEffortUnavailable(CLAUDE_CODE_ID);
  const agent = provider?.label ?? tc('agent.generic');
  const modes: readonly PermissionMode[] = provider?.permissionModes ?? PERMISSION_MODES;
  const known = (projects.data ?? []).find((p) => p.path === cwd.trim());
  // The servers offered are the ones the chat will see from its directory
  const toolScope = { projectId: known?.id };

  const start = useMutation({
    mutationFn: (prompt: string) => {
      const opts: NewChatRequest = { prompt, permissionPrompts: askHere ? 'host' : 'none' };
      if (files.ids.length) opts.attachments = files.ids;
      if (cwd.trim()) opts.cwd = cwd.trim();
      if (model.trim()) opts.model = model.trim();
      if (effort && !effortUnavailable) opts.effort = effort;
      if (account) opts.account = account;
      if (permissionMode) opts.permissionMode = permissionMode;
      if (appendSystemPrompt.trim()) opts.appendSystemPrompt = appendSystemPrompt.trim();
      if (tools.toolPreset !== undefined) opts.toolPreset = tools.toolPreset;
      if (tools.mcp) opts.mcp = tools.mcp;
      if (tools.claudioMcp) opts.claudioMcp = true;
      return api.createChat(opts);
    },
    onSuccess: (chat) => navigate(`/chats/${chat.id}`),
  });

  const system = overview.data?.system;
  const systemMode = system?.defaultPermissionMode;
  const defaultMode = systemMode && modes.includes(systemMode) ? systemMode : modes[0];
  const defaultModeWord = defaultMode ? modeLabel(defaultMode) : '…';
  const directory = cwd.trim() || system?.workspaceDir || t('new.wrapperWorkspace');
  // What the CLI reported the last time a chat started in that directory: a new chat gets the same
  const where = cwd.trim() || system?.workspaceDir || '';
  const environment = useQuery({ queryKey: keys.environments(where), queryFn: () => api.environments(where), enabled: Boolean(where) });
  const commands = environment.data?.[0]?.slashCommands ?? [];
  const skills = environment.data?.[0]?.skills;
  // The chips: where it runs, with what — the same words the chat's own chips show
  const place = known?.name ?? directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory;
  const words = [place, model.trim() || tc('newChat.defaultModel'), permissionMode ? modeLabel(permissionMode) : tc('newChat.defaultMode', { mode: defaultModeWord })];

  const pick = (example: string) => {
    box.current?.setText(example);
    box.current?.focus();
  };

  const kind = (
    <Segmented<Kind>
      label={tc('newChat.kind')}
      value="chat"
      onChange={(next) => next === 'orchestration' && navigate(NEW_ORCHESTRATION_PATH)}
      options={[
        { value: 'chat', label: <KindLabel icon={MessageSquare}>{tc('newChat.kindChat')}</KindLabel> },
        { value: 'orchestration', label: <KindLabel icon={Network}>{tc('newChat.kindOrchestration')}</KindLabel> },
      ]}
    />
  );

  const chips = (
    <OptionsPanel
      title={t('new.title')}
      open={options}
      onOpenChange={setOptions}
      trigger={
        <button type="button" className="composer-status" aria-expanded={options} onClick={() => setOptions(true)}>
          <StatusChips label={t('new.options')} words={words} accent={-1} icon={<FolderOpen size={13} strokeWidth={1.75} aria-hidden />} />
        </button>
      }
    >
      <div className="form new-chat-options">
        <div className="form-grid">
          <Field label={t('new.workingDirectory')} hint={t('new.workingDirectoryHint', { dir: system?.workspaceDir ?? t('new.wrapperWorkspace') })}>
            <Combobox
              aria-label={t('new.workingDirectory')}
              placeholder="/path/to/project"
              value={cwd}
              onChange={setCwd}
              options={(projects.data ?? []).filter((p) => p.exists).map((p) => ({ value: p.path, label: p.name, hint: p.path }))}
            />
          </Field>
          <Field label={t('new.model')} hint={t('new.modelHint')}>
            <ModelCombobox account={account || null} aria-label={t('new.model')} placeholder={t('new.modelPlaceholder')} value={model} onChange={setModel} />
          </Field>
          <EffortField value={effort} onChange={setEffort} model={model} use="chat" unavailable={effortUnavailable} />
          <Field label={t('new.permissionMode')} hint={t('new.permissionModeHint')}>
            <Select<PermissionMode | ''>
              aria-label={t('new.permissionMode')}
              value={permissionMode}
              onChange={setPermissionMode}
              options={[
                { value: '', label: t('new.permissionModeDefault', { mode: defaultModeWord }) },
                ...modes.map((m) => ({ value: m, label: modeLabel(m) })),
              ]}
            />
          </Field>
        </div>
        {accounts.length > 1 && (
          // The rows the "+" menu of a chat offers, so an account reads the same wherever it is chosen
          <Field label={t('new.account')} hint={t('new.accountHint')}>
            <AccountList rows={accountRows} model={model.trim() || null} chosen={account} auto={t('new.accountAuto')} label={t('new.account')} onChoose={setAccount} />
          </Field>
        )}
        <Field label={t('new.appendSystemPrompt')} hint={t('new.optional')}>
          <textarea rows={2} value={appendSystemPrompt} onChange={(e) => setAppendSystemPrompt(e.target.value)} />
        </Field>
        {hasMcp && <ChatToolsPicker value={tools} onChange={setTools} scope={toolScope} />}
        <Switch checked={askHere} onChange={setAskHere}>
          {t('new.askHere')}
        </Switch>
      </div>
    </OptionsPanel>
  );

  // The first message is usually long: Enter breaks the line and Ctrl/⌘+Enter starts the chat
  const composer = (
    <StartComposer
      editor={box}
      layout="start"
      files={files}
      commands={commands}
      {...(skills ? { skills } : {})}
      initialText={initialPrompt}
      autoFocus={!narrow}
      label={t('new.prompt')}
      placeholder={tc('newChat.placeholder')}
      sendLabel={{ idle: t('new.start'), pending: t('new.starting'), uploading: t('new.uploading') }}
      startLabel={tc('newChat.start')}
      pending={start.isPending}
      onStart={(message) => start.mutate(message)}
      status={chips}
      error={<ErrorBox error={start.error} title={t('new.startError')} />}
      note={<p className="new-where">{tc('newChat.where', { dir: directory })}</p>}
    />
  );

  const hero = (
    <div className="new-hero">
      <Illustration name="welcome" size={narrow ? 'sm' : 'md'} />
      <h1 className="new-hero-title text-display">
        <Trans t={tc} i18nKey={narrow ? 'newChat.heroShort' : 'newChat.hero'} components={{ grad: <span className="grad-text" /> }} />
      </h1>
      <p className="new-hero-lead">{tc('newChat.lead', { agent: upperFirst(agent) })}</p>
    </div>
  );

  const examples = (
    <section className="new-welcome-examples" aria-labelledby="new-examples">
      <h2 id="new-examples" className="section-label">
        {tc('newChat.examples')}
      </h2>
      <div className="new-welcome-grid">
        {EXAMPLES.map(({ key, icon: Icon, tone }) => {
          const example = t(`new.welcome.examples.${key}`);
          return (
            <button key={key} type="button" className="new-welcome-example" onClick={() => pick(example)}>
              <span className={`new-welcome-example-icon tone-${tone}`} aria-hidden>
                <Icon {...ICON_SM} />
              </span>
              <span className="new-welcome-example-text">{example}</span>
            </button>
          );
        })}
      </div>
    </section>
  );

  if (narrow) {
    return (
      <div className="run-layout new-chat is-narrow glow-top">
        <section className="run-main" aria-label={t('new.title')}>
          <header className="new-chat-head">
            <Tooltip content={tc('newChat.close')}>
              <Link to="/chats" className="icon-btn" aria-label={tc('newChat.close')}>
                <X {...ICON} />
              </Link>
            </Tooltip>
            {kind}
          </header>
          <div className="run-stage">
            <div className="run-scroll new-chat-scroll" data-scroll-root>
              {hero}
              {examples}
            </div>
          </div>
          {composer}
        </section>
      </div>
    );
  }

  return (
    <div className="run-layout new-chat">
      <section className="run-main" aria-label={t('new.title')}>
        <div className="run-stage">
          <div className="run-scroll new-chat-scroll glow-top" data-scroll-root>
            {hero}
            {kind}
            {composer}
            {examples}
          </div>
        </div>
      </section>
    </div>
  );
}

function KindLabel({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <span className="new-kind">
      <Icon size={13} strokeWidth={1.75} aria-hidden />
      {children}
    </span>
  );
}
