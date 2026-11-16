// tsx compiles test files with the classic runtime; this one renders JSX like the app does
/** @jsxRuntime automatic */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { LiveWork } from '@claudio/shared';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useTranslation } from 'react-i18next';
import { setLanguage } from '../src/i18n';
import { QuitQuestion, useQuitLiveSentence } from '../src/components/QuitQuestion';
import { parseLiveWork } from '../src/lib/updates';

// The desktop's quit question (docs/plans/survive-restarts.md, D1). The shell's side, what it does
// with each answer, is tested in apps/desktop/test/quit.test.ts; here, what the page says.

(globalThis as { React?: typeof React }).React = React;

function Sentence({ live }: { live: LiveWork }) {
  return <>{useQuitLiveSentence()(live)}</>;
}

type QuitKey = 'quit.keep' | 'quit.stop' | 'quit.noticeTitle';

function Copy({ k }: { k: QuitKey }) {
  const { t } = useTranslation('shell');
  return <>{t(k)}</>;
}

const say = (node: React.ReactNode, lang: 'en' | 'es' = 'en') => {
  setLanguage(lang);
  return renderToStaticMarkup(<>{node}</>);
};

test('the question names what is live, in both languages, and skips what is not', () => {
  const live = { working: 2, waiting: 0, running: 1, terminals: 1 };
  assert.equal(say(<Sentence live={live} />), '2 chats are working, 1 orchestration is running, 1 terminal is open');
  assert.equal(say(<Sentence live={live} />, 'es'), '2 chats están trabajando, 1 orquestación está en marcha, 1 terminal está abierta');
  assert.equal(say(<Sentence live={{ working: 0, waiting: 1, running: 0, terminals: 0 }} />), '1 chat is waiting for an answer');
});

test('keeping the work is the action that names its result, and stopping says it quits too', () => {
  assert.equal(say(<Copy k="quit.keep" />), 'Keep working in the background');
  assert.equal(say(<Copy k="quit.stop" />), 'Stop all work and quit');
  // Spanish buttons are infinitives (GLOSSARY.md)
  assert.equal(say(<Copy k="quit.keep" />, 'es'), 'Seguir en segundo plano');
  assert.equal(say(<Copy k="quit.stop" />, 'es'), 'Detener todo y salir');
  assert.equal(say(<Copy k="quit.noticeTitle" />, 'es'), 'Claudio sigue trabajando');
});

test('outside the desktop app, or before the shell asks, the question draws nothing', () => {
  assert.equal(say(<QuitQuestion />), '');
});

test('only counts reach the question: anything else from the shell is no question at all', () => {
  assert.deepEqual(parseLiveWork({ working: 3, waiting: -1, running: 'x', terminals: 1.7 }), { working: 3, waiting: 0, running: 0, terminals: 1 });
  assert.equal(parseLiveWork(null), null);
  assert.equal(parseLiveWork('2 working'), null);
});
