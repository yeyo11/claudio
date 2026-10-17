import { useLocation } from 'react-router-dom';
import { DecisionsTab } from '../DecisionsTab';
import type { GroupScreenProps } from './Section';

/**
 * Settings → Decisions (§7). A placeholder over today's tab until w5 builds the screen: the
 * Supervisor's old address lands on its section, and History is the detail.
 */
export function Decisions({ detail }: GroupScreenProps<'decisions'>) {
  const { hash } = useLocation();
  if (detail === 'history') return <DecisionsTab section="history" />;
  return <DecisionsTab {...(hash === '#point-supervisor-intervene' ? { section: 'supervisor' as const } : {})} />;
}
