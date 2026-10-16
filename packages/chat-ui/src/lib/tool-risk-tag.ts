import type { ToolRisk, ToolRiskFactor } from '@claudio/shared';

/** What a risk draws as: nothing for low, a muted word for medium, a bad one with a shield for high. */
export interface RiskTagView {
  tone: 'bad' | 'muted';
  /** High carries the shield beside its word; the tone alone never says it */
  shield: boolean;
  level: 'high' | 'medium';
  /** The first factor, whose word is the tag's text */
  factor: ToolRiskFactor;
}

export function riskTagOf(risk: ToolRisk | null | undefined): RiskTagView | null {
  const factor = risk?.factors[0];
  if (!risk || !factor || risk.level === 'low') return null;
  return risk.level === 'high' ? { tone: 'bad', shield: true, level: 'high', factor } : { tone: 'muted', shield: false, level: 'medium', factor };
}

export type Translate = (key: string, options?: Record<string, string | number>) => string;

/** Every factor that fired, in words, heaviest first. */
export function riskFactorWords(t: Translate, risk: ToolRisk): string {
  return risk.factors.map((factor) => t(`risk.factor.${factor}`)).join(', ');
}

/** The tooltip and the prompt's line: the level, then why. The input itself is on the row beside it. */
export function riskReason(t: Translate, risk: ToolRisk): string {
  const view = riskTagOf(risk);
  if (!view) return '';
  return t('risk.reason', { level: t(`risk.level.${view.level}`), factors: riskFactorWords(t, risk) });
}
