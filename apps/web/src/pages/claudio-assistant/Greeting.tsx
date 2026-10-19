import { useTranslation } from 'react-i18next';
import { ClaudioMascot } from '@claudio/ui/components/icons';

/**
 * The first message of every chat of the Claudio assistant, drawn from i18n and not a model turn:
 * it is instant, the same every time, and the chat's title stays the person's first prompt.
 */
export function AssistantGreeting() {
  const { t } = useTranslation('assistant');
  return (
    <div className="as-greeting">
      <ClaudioMascot size={24} />
      <p>{t('claudio.greeting')}</p>
    </div>
  );
}
