import type { CSSProperties } from 'react';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { TeamMember } from '@claudio/shared';
import { isKnownRole, roleFallbackName, roleHue, roleInitials, templateResponsibilityRole } from './model';

/** A role's name in the interface language: the template's roles are translated, any other is shown as written. */
export function useRoleName(): (role: string) => string {
  const { t } = useTranslation('team');
  return useCallback((role: string) => (isKnownRole(role) ? t(`roles.${role}`) : roleFallbackName(role)), [t]);
}

/**
 * A member's responsibility as the interface shows it: the template's own in the person's language,
 * by role, since core keeps it in English for Claude; one someone edited, as it was written.
 */
export function useResponsibility(): (member: Pick<TeamMember, 'role' | 'responsibility'>) => string {
  const { t } = useTranslation('team');
  return useCallback(
    (member: Pick<TeamMember, 'role' | 'responsibility'>) => {
      const role = templateResponsibilityRole(member);
      return role ? t(`responsibilities.${role}`) : member.responsibility;
    },
    [t],
  );
}

/**
 * A team role: a neutral squircle with its initials in mono, and the role's own hue only on the
 * diamond in its corner. A person stays a round monogram, so a board never mixes the two up.
 */
export function RoleAvatar({
  role,
  size = 'md',
  label,
  decorative = false,
}: {
  role: string;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  label?: string;
  /** Beside the role's name in words, where saying it again would read the name twice */
  decorative?: boolean;
}) {
  const name = useRoleName()(role);
  const said = label ?? name;
  const named = decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': said };
  return (
    <span className={`role-avatar ${size === 'md' ? '' : `role-avatar-${size}`}`.trim()} style={{ '--hue': roleHue(role) } as CSSProperties} {...named} title={said}>
      {roleInitials(role)}
    </span>
  );
}

/** The model a role runs on, in mono and neutral: a model is a choice, not a state. */
export function ModelTag({ model }: { model: string }) {
  return <span className={`model-tag ${/opus/i.test(model) ? 'is-opus' : ''}`.trim()}>{model}</span>;
}
