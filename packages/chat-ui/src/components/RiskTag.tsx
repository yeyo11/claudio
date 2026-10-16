import { toolRisk, type ToolRisk } from '@claudio/shared';
import { ShieldAlert } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip } from '@claudio/ui/components/controls/Tooltip';
import { Tag } from '@claudio/ui/components/ui';
import { useRiskContext } from '../lib/agent';
import { riskReason, riskTagOf, type Translate } from '../lib/tool-risk-tag';

/** The risk words are looked up by a key built from the factor, which the typed `t` cannot follow. */
function useRiskWords(): { t: Translate; tag: (key: `risk.factor.${string}`) => string } {
  const { t } = useTranslation('chat');
  const words: Translate = (key, options) => String(t(key as 'risk.reason', options));
  return { t: words, tag: (key) => words(key) };
}

/** How risky a call is, scored from its input where the chat works. Null for low, and for what is not a call. */
export function useToolRisk(name: string | null, input: unknown): ToolRisk | null {
  const ctx = useRiskContext();
  return useMemo(() => {
    if (name === null || !input || typeof input !== 'object' || Array.isArray(input)) return null;
    const risk = toolRisk({ name, input: input as Record<string, unknown> }, ctx);
    return risk.level === 'low' ? null : risk;
  }, [name, input, ctx]);
}

/**
 * The risk of a call as a tag: the word of its first factor, in `bad` with a shield when high and
 * muted when medium, with the whole reason in a tooltip. Static, and a reading aid only: nothing is
 * blocked by it. Draws nothing for low.
 */
export function RiskTag({ risk }: { risk: ToolRisk | null | undefined }) {
  const { t, tag } = useRiskWords();
  const view = riskTagOf(risk);
  if (!risk || !view) return null;
  return (
    <Tooltip content={riskReason(t, risk)}>
      {/* Not a stop of its own: it sits in a row's trigger or beside the prompt's visible reason, and the word is its name */}
      <span className="risk-tag" data-risk={view.level}>
        <Tag tone={view.tone} {...(view.shield ? { icon: ShieldAlert } : {})}>
          {tag(`risk.factor.${view.factor}`)}
        </Tag>
      </span>
    </Tooltip>
  );
}

/** The line of a permission prompt: the tag, and the reason in a sentence beside it. */
export function RiskLine({ risk }: { risk: ToolRisk | null }) {
  const { t } = useRiskWords();
  if (!risk || !riskTagOf(risk)) return null;
  return (
    <div className="permission-risk">
      <RiskTag risk={risk} />
      <span className="muted small">{riskReason(t, risk)}</span>
    </div>
  );
}
