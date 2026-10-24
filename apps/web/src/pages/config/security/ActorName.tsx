import { useTranslation } from 'react-i18next';
import { FullText } from '@claudio/ui/components/FullText';

/**
 * The actors the server writes as words rather than ids (`actorFor` in core's auth, the API's
 * `anonymous`): anything else (`token:<id>`, `chat:<id>`, an OIDC subject) is a literal.
 */
const ACTOR_WORDS = ['local', 'desktop', 'env', 'claudio', 'anonymous'] as const;
type ActorWord = (typeof ACTOR_WORDS)[number];
export const isActorWord = (actor: string): actor is ActorWord => (ACTOR_WORDS as readonly string[]).includes(actor);

/**
 * Who did something, worded the same in the audit log and the terminal's history: a known actor in
 * the reader's language and in sans, an id in mono with its full text when it is cut.
 */
export function ActorName({ actor, wordClassName, literalClassName = 'mono' }: { actor: string; wordClassName?: string; literalClassName?: string }) {
  const { t } = useTranslation('config');
  return isActorWord(actor) ? <span className={wordClassName}>{t(`security.audit.actors.${actor}`)}</span> : <FullText className={literalClassName}>{actor}</FullText>;
}
