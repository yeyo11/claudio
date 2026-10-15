import { Fragment, useEffect, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { HighlightScheduler } from '../lib/highlight-scheduler';
import { Lru } from '../lib/lru';
import { CopyButton } from './ui';

type Tokens = NonNullable<Awaited<ReturnType<typeof import('./highlight').highlight>>>;

/**
 * Blocks already coloured, by language and code. A row of a windowed transcript mounts again each
 * time it scrolls back into view, and a streamed answer becomes the stored one as a new component:
 * without this both would show plain and colour a beat later, every time.
 */
const coloured = new Lru<string, Tokens>(300);
/** Longer than any block worth keeping around twice: its tokens would dwarf the rest of the cache. */
const MAX_CACHED_CHARS = 50_000;
const cacheKey = (lang: string, code: string) => `${lang}\u0000${code}`;

const scheduler = new HighlightScheduler();

/**
 * Highlights off the main bundle, at most once per pass while the code grows and once more on the
 * final code. While a block is still streaming, the part already coloured stays coloured and only
 * the new tail shows plain.
 */
function useHighlight(code: string, lang: string | undefined, enabled: boolean): { tokens: Tokens; rest: string } | null {
  const [done, setDone] = useState<{ code: string; tokens: Tokens } | null>(null);
  const cached = enabled && lang ? coloured.get(cacheKey(lang, code)) : undefined;
  const latest = useRef(code);
  latest.current = code;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!enabled || !lang || cached !== undefined || done?.code === code) return;
    const plan = scheduler.next({ hasResult: done !== null, length: code.length });
    // A throttle keeps the timer it has; only a huge block starts its wait again on every change
    if (timer.current !== undefined) {
      if (!plan.restartOnChange) return;
      clearTimeout(timer.current);
    }
    const run = () => {
      timer.current = undefined;
      const snapshot = latest.current;
      import('./highlight')
        .then((m) => m.highlight(snapshot, lang))
        .then((tokens) => {
          if (!tokens || !live.current) return;
          if (snapshot.length <= MAX_CACHED_CHARS) coloured.set(cacheKey(lang, snapshot), tokens);
          setDone({ code: snapshot, tokens });
          // The code moved on while this pass ran: one more, so the last version is coloured too
          if (latest.current !== snapshot && timer.current === undefined) {
            timer.current = setTimeout(run, scheduler.next({ hasResult: true, length: latest.current.length }).delay);
          }
        })
        .catch(() => {
          // colour is a nicety: the plain block is already on screen
        });
    };
    timer.current = setTimeout(run, plan.delay);
  }, [code, lang, enabled, cached, done]);

  if (cached) return { tokens: cached, rest: '' };
  if (!done || !code.startsWith(done.code)) return null;
  return { tokens: done.tokens, rest: code.slice(done.code.length) };
}

/**
 * Code surface with a copy button. `header` gives it the always-visible bar with the language that
 * chat answers get; tool payloads keep the quieter bar that shows on hover.
 */
export function CodeBlock({ code, lang, tone, header = false }: { code: string; lang?: string; tone?: 'error'; header?: boolean }) {
  const { t } = useTranslation('primitives');
  const highlighted = useHighlight(code, lang, tone !== 'error');
  return (
    <div className={`code-block ${tone === 'error' ? 'is-error' : ''} ${header ? 'has-header' : ''}`}>
      <div className="code-block-bar">
        {(lang || header) && <span className="code-lang">{lang || 'text'}</span>}
        <CopyButton text={code} label={t('ui.copyCode')} />
      </div>
      {/* Highlighted, the block carries the foreground colour, which the bare runs inherit */}
      {/* Focusable so long lines can be scrolled from the keyboard; a group, not a landmark, since a transcript holds many */}
      <pre className="code" role="group" aria-label={lang ? t('codeBlock.labelLang', { lang }) : t('codeBlock.label')} tabIndex={0} data-lang={lang || undefined} style={highlighted ? (highlighted.tokens.base as CSSProperties) : undefined}>
        {highlighted ? (
          <>
            {highlighted.tokens.lines.map((line, i) => (
              <Fragment key={i}>
                {i > 0 && '\n'}
                {line.map((run, j) =>
                  typeof run === 'string' ? (
                    run
                  ) : (
                    <span key={j} style={run.style as CSSProperties}>
                      {run.content}
                    </span>
                  ),
                )}
              </Fragment>
            ))}
            {highlighted.rest}
          </>
        ) : (
          code
        )}
      </pre>
    </div>
  );
}
