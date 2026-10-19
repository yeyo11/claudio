import { useMutation } from '@tanstack/react-query';
import { FolderGit2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { Effort } from '@claudio/shared';
import { OptionsPanel, StartComposer, StatusChips } from '@claudio/chat-ui/composer/Composer';
import type { RichEditorHandle } from '@claudio/chat-ui/composer/editor/RichEditor';
import { api } from '../../api';
import { EffortField, effortWords } from '../../components/EffortPicker';
import { ModelPicker } from '../../components/ModelPicker';
import { PhoneHeader } from '../../components/shell/PhoneHeader';
import { useProjectScope } from '../../lib/project-scope';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import { Illustration } from '@claudio/ui/components/illustrations';
import { ErrorBox, Field, usePageTitle } from '@claudio/ui/components/ui';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { STARTERS } from './model';
import { Recents } from './Recents';

/** The model a chat of the assistant starts with unless the person picks another (the core's default too) */
const DEFAULT_MODEL = 'sonnet';

/**
 * `/assistant`: Claudio's greeting, the box to ask in, what the assistant can do as suggestions, and its recent chats. The
 * box is New chat's (`StartComposer` with `layout="start"`), centred under the greeting, without what
 * the assistant cannot use: no files, commands, servers, account or permission mode, since the core starts it confined. The project in
 * scope is context and not a requirement: the chip clears it before the first prompt. Starting
 * creates the chat in the core and opens it, where the chat's own composer takes over.
 */
export function ClaudioAssistant() {
  const { t } = useTranslation('assistant');
  const navigate = useNavigate();
  const narrow = useMediaQuery(NARROW);
  const { project } = useProjectScope();
  const [dropped, setDropped] = useState(false);
  const context = dropped ? null : project;
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [effort, setEffort] = useState<Effort | ''>('');
  const box = useRef<RichEditorHandle>(null);
  usePageTitle(t('claudio.title'));

  const start = useMutation({
    mutationFn: (prompt: string) => api.startClaudioAssistantChat({ prompt, projectId: context?.id ?? null, model, ...(effort ? { effort } : {}) }),
    onSuccess: (chat) => navigate(`/chats/${chat.id}`),
  });

  const composer = (
    <StartComposer
      editor={box}
      layout="start"
      autoFocus={!narrow}
      label={t('claudio.message')}
      placeholder={t('claudio.placeholder')}
      sendLabel={{ idle: t('claudio.send'), pending: t('claudio.starting') }}
      pending={start.isPending}
      onStart={(prompt) => start.mutate(prompt)}
      error={<ErrorBox error={start.error} title={t('claudio.startError')} />}
      status={
        <>
          {context && (
            <span className="composer-status-word as-context">
              <FolderGit2 {...ICON_SM} aria-hidden />
              <span className="ellipsis">{t('claudio.context', { name: context.name })}</span>
              <button type="button" className="x" aria-label={t('claudio.clearContext')} onClick={() => setDropped(true)}>
                <X {...ICON_SM} aria-hidden />
              </button>
            </span>
          )}
          <StartOptions model={model} onModel={setModel} effort={effort} onEffort={setEffort} />
        </>
      }
    />
  );

  return (
    <div className="run-layout as-entry">
      <section className="run-main" aria-label={t('claudio.title')}>
        {narrow && <PhoneHeader title={t('claudio.title')} back={{ fallback: '/' }} />}
        <div className="run-stage">
          <div className="run-scroll as-scroll glow-top" data-scroll-root>
            <div className="as-body">
              <Hello narrow={narrow} />
              {/* New chat's order: the greeting, the box, then what to ask; on a phone the box sits at the foot */}
              {!narrow && composer}
              <section className="as-starters-section" aria-labelledby="as-starters-label">
                <h2 id="as-starters-label" className="section-label">
                  {t('claudio.starters')}
                </h2>
                <div className="as-starters">
                  {STARTERS.map(({ key, icon: Icon }) => (
                    <button
                      key={key}
                      type="button"
                      className="as-starter"
                      onClick={() => {
                        box.current?.setText(t(`claudio.starter.${key}.ask`));
                        box.current?.focus();
                      }}
                    >
                      <Icon {...ICON} aria-hidden />
                      <span className="as-starter-body">
                        <span className="as-starter-title">{t(`claudio.starter.${key}.title`)}</span>
                        <span className="as-starter-ask">{t(`claudio.starter.${key}.ask`)}</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
              <Recents narrow={narrow} />
            </div>
          </div>
        </div>
        {narrow && composer}
      </section>
    </div>
  );
}

/**
 * The chips under the box, as a chat's: `sonnet · medium · recommended`, one button that opens the
 * model and the effort. Only those two: the assistant runs with the permission mode, tools and
 * servers the core gives it, so a chat's mode chip has nothing to say here.
 */
function StartOptions({ model, onModel, effort, onEffort }: { model: string; onModel: (model: string) => void; effort: Effort | ''; onEffort: (effort: Effort | '') => void }) {
  const { t } = useTranslation('assistant');
  const { t: tc } = useTranslation('components');
  // The chat's own words for its line: what is chosen here is how the assistant's chat will run
  const { t: chat } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const words = [model, effort || effortWords(tc, model, 'assistant', { set: false }).unset];
  return (
    <OptionsPanel
      title={chat('status.liveTitle')}
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button type="button" className="composer-status" aria-expanded={open} onClick={() => setOpen(true)}>
          <StatusChips label={chat('status.open')} words={words} accent={-1} />
        </button>
      }
    >
      <div className="form">
        <div className="form-grid">
          <Field label={t('claudio.model')}>
            <ModelPicker value={model} onChange={onModel} aria-label={t('claudio.model')} />
          </Field>
          <EffortField value={effort} onChange={onEffort} model={model} use="assistant" aria-label={t('claudio.effort')} />
        </div>
      </div>
    </OptionsPanel>
  );
}

/** The greeting block: Claudio, the title and the line. No live figures: Home and the status bar say what is running */
function Hello({ narrow }: { narrow: boolean }) {
  const { t } = useTranslation('assistant');
  return (
    <div className="as-hello">
      <Illustration name="claudio" size={narrow ? 'sm' : 'md'} />
      <h1 className="as-hello-title">{t('claudio.hello')}</h1>
      <p className="as-hello-sub">{t('claudio.sub')}</p>
    </div>
  );
}
