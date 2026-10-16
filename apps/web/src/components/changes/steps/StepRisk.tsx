import type { ToolRisk } from '@claudio/shared';
import { ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { riskReason, riskTagOf, type Translate } from '@claudio/chat-ui/lib/tool-risk-tag';
import { Tooltip } from '@claudio/ui/components/controls';
import { Tag } from '@claudio/ui/components/ui';

/** The risk strings are `steps.risk.*` here; the keys the shared helper asks for are looked up under it. */
export function useRiskWords(): Translate {
  const { t } = useTranslation('changes');
  return (key, options) => String(t(`steps.${key}` as 'steps.label', options));
}

/**
 * How risky the step's call was, as a tag after its path: the first factor's word, `bad` with a
 * shield when high and muted when medium. Static, and nothing for a step that carries no risk.
 */
export function StepRisk({ risk, inLink = false }: { risk: ToolRisk | undefined; inLink?: boolean }) {
  const words = useRiskWords();
  const view = riskTagOf(risk);
  if (!risk || !view) return null;
  return (
    <Tooltip content={riskReason(words, risk)}>
      {/* In a list row the link is the one stop; elsewhere the reason must be reachable by keyboard */}
      <span className="edit-step-risk" data-risk={view.level} {...(inLink ? {} : { tabIndex: 0 })}>
        <Tag tone={view.tone} {...(view.shield ? { icon: ShieldAlert } : {})}>
          {words(`risk.factor.${view.factor}`)}
        </Tag>
      </span>
    </Tooltip>
  );
}
