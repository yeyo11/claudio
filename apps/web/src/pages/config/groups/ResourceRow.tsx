import type { ResourceKind } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys, type Scope } from '../../../api';
import { formatNumber } from '@claudio/ui/lib/format';
import { sectionLabel, settingsAddress } from '../settingsGroups';
import { SettingsRowSection } from './Section';

const USER_SCOPE: Scope = {};

/** Where each kind's editor lives: rules and output styles are instructions, the rest extensions. */
const GROUP_OF: Record<ResourceKind, 'instructions' | 'extensions'> = {
  rules: 'instructions',
  'output-styles': 'instructions',
  skills: 'extensions',
  agents: 'extensions',
  commands: 'extensions',
  workflows: 'extensions',
};

/**
 * One resource kind on its group's screen, as a section that is one row: the kind, what it is, how
 * many the account has in its config directory, and the way to its editor. The count waits for the
 * list, never a guess.
 */
export function ResourceRow({ kind }: { kind: ResourceKind }) {
  const { t } = useTranslation(['config']);
  const { data } = useQuery({ queryKey: keys.resources(USER_SCOPE, kind), queryFn: () => api.resources(USER_SCOPE, kind) });
  return (
    <SettingsRowSection
      id={kind}
      // Each kind is a detail of its group under its own name (settingsGroups.ts)
      to={settingsAddress(GROUP_OF[kind], undefined, kind)}
      label={t(sectionLabel(kind))}
      description={t(`resources.kinds.${kind}.row`)}
      note={data ? formatNumber(data.length) : undefined}
      setting={`${kind}.list`}
    />
  );
}
