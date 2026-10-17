import type { ResourceKind } from '@claudio/shared';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api, keys, type Scope } from '../../../api';
import { formatNumber } from '@claudio/ui/lib/format';
import { settingsAddress } from '../settingsGroups';
import { SettingsDetailRow } from './Section';

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
 * The row of one resource kind on its group's screen: what the kind is, how many the account has in
 * its config directory, and the way to its editor. The count waits for the list, never a guess.
 */
export function ResourceRow({ kind }: { kind: ResourceKind }) {
  const { t } = useTranslation(['config']);
  const { data } = useQuery({ queryKey: keys.resources(USER_SCOPE, kind), queryFn: () => api.resources(USER_SCOPE, kind) });
  return (
    <SettingsDetailRow
      // Each kind is a detail of its group under its own name (settingsGroups.ts)
      to={settingsAddress(GROUP_OF[kind], undefined, kind)}
      label={t(`resources.kinds.${kind}.row`)}
      note={data ? formatNumber(data.length) : undefined}
      setting={`${kind}.list`}
    />
  );
}
