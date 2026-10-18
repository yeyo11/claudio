import { Clock, ExternalLink, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ICON, ICON_SM } from '@claudio/ui/components/icons';
import type { LoginFailure } from '../../lib/setup';

export type PanelLayout = 'inline' | 'sheet' | 'card';

/** The panel's box: under the row on a desktop, the body of a Sheet on a phone, or a card's content. */
export function PanelFrame({ label, layout = 'inline', choice, children }: { label: string; layout?: PanelLayout; choice: ReactNode; children: ReactNode }) {
  const { t } = useTranslation('setup');
  const title = t('panel.title', { label });
  if (layout === 'sheet') {
    return (
      <div className="prov-sheet-body signin-sheet-body">
        {choice}
        {children}
      </div>
    );
  }
  if (layout === 'card') {
    return (
      <div className="signin-card-body" role="group" aria-label={title}>
        {choice && <div className="signin-panel-head">{choice}</div>}
        {children}
      </div>
    );
  }
  return (
    <div className="prov-bin signin-panel" role="group" aria-label={title}>
      <div className="signin-panel-head">
        <span className="section-label grow">{title}</span>
        {choice}
      </div>
      {children}
    </div>
  );
}

export function ExternalText({ href, children, className = 'c-accent signin-link' }: { href: string; children: ReactNode; className?: string }) {
  const { t } = useTranslation('setup');
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLink {...ICON_SM} />
      <span className="sr-only"> ({t('panel.opensNewTab')})</span>
    </a>
  );
}


export function FailureNote({ failure, label }: { failure: LoginFailure; label: string }) {
  const { t } = useTranslation('setup');
  const Icon = failure.tone === 'warn' ? Clock : TriangleAlert;
  return (
    <div className={`signin-result${failure.tone === 'warn' ? ' warn' : ''}`} role="alert" data-code={failure.code}>
      <Icon {...ICON} className="ico" />
      <div className="signin-result-text">
        <span>{t(`panel.fail.${failure.code}`, { label })}</span>
        <span className="mono">{failure.code}</span>
      </div>
    </div>
  );
}

