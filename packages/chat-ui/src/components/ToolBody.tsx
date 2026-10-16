import { Check, Circle, CircleDot } from 'lucide-react';
import { Fragment, Suspense, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Highlighted } from '@claudio/ui/components/highlight';
import { CodeBlock } from '@claudio/ui/components/CodeBlock';
import { Collapsible } from '@claudio/ui/components/controls/Collapsible';
import { ICON_SM } from '@claudio/ui/components/icons';
import { CopyButton, Tag } from '@claudio/ui/components/ui';
import { formatBytes, formatDuration } from '@claudio/ui/lib/format';
import { useRiskContext } from '../lib/agent';
import { useChatUi } from '../lib/context';
import type { StepCall } from '../lib/chat-steps';
import {
  agentInBackground,
  agentReport,
  asInput,
  capText,
  checklistOf,
  fieldsOf,
  langOfPath,
  lensOf,
  patchCounts,
  READ_CAP_LINES,
  readResult,
  readSearch,
  readText,
  relativePath,
  searchOptions,
  type ChecklistStatus,
  type Field,
  type TreeNode,
} from '../lib/tool-lens';
import { RichText } from './Transcript';

/*
 * The body of an opened tool call, read as what happened (docs/plans/tool-rows-and-live-branches.md
 * §3.2): one or two labelled zones per tool, and a quiet "Raw" that swaps them for the input's JSON
 * and the result's text. Which lens and what each one draws is decided in lib/tool-lens.ts.
 */

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

function Zone({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="call-zone">
      <span className="call-label">{label}</span>
      {children}
    </div>
  );
}

/** "Show all {{count}} lines": the one way past a cap, a ghost button under what was cut. */
function ShowAll({ count, onShow }: { count: number; onShow: () => void }) {
  const { t } = useTranslation('chat');
  return (
    <button type="button" className="btn btn-ghost btn-small call-more" onClick={onShow}>
      {t('transcript.call.showAll', { count })}
    </button>
  );
}

/** Text that may be long, cut at the cap until the reader asks for the rest. */
function Capped({ text, children }: { text: string; children: (shown: string) => ReactNode }) {
  const [all, setAll] = useState(false);
  const capped = capText(text);
  return (
    <>
      {children(all ? text : capped.text)}
      {capped.cut && !all && <ShowAll count={capped.lines} onShow={() => setAll(true)} />}
    </>
  );
}

function Term({ text, className = 'call-term' }: { text: string; className?: string }) {
  const { t } = useTranslation('chat');
  return <Capped text={text}>{(shown) => <pre className={className}>{shown || t('transcript.empty')}</pre>}</Capped>;
}

/** The error a failed call came back with, as the row always showed it. */
function ErrorResult({ text }: { text: string }) {
  const { t } = useTranslation('chat');
  return (
    <Zone label={t('transcript.call.output')}>
      <Capped text={text}>{(shown) => <CodeBlock tone="error" code={shown || t('transcript.empty')} />}</Capped>
    </Zone>
  );
}

type Tokens = NonNullable<Highlighted>;

/** Colours a read file off the main bundle, like `CodeBlock`; until then the lines show plain. */
function useLineTokens(code: string, lang: string | undefined): Tokens | null {
  const [done, setDone] = useState<{ code: string; tokens: Tokens } | null>(null);
  useEffect(() => {
    if (!lang) return;
    let live = true;
    import('@claudio/ui/components/highlight')
      .then((m) => m.highlight(code, lang))
      .then((tokens) => {
        if (live && tokens) setDone({ code, tokens });
      })
      .catch(() => {
        // colour is a nicety: the plain lines are already on screen
      });
    return () => {
      live = false;
    };
  }, [code, lang]);
  return done && done.code === code ? done.tokens : null;
}

/**
 * A file as it was read: highlighted in its extension's language, each line numbered from where the
 * read started. The numbers are drawn by the stylesheet, so copying the code leaves them out.
 */
function NumberedCode({ lines, startLine, lang }: { lines: string[]; startLine: number; lang: string | undefined }) {
  const { t } = useTranslation('primitives');
  const code = lines.join('\n');
  const tokens = useLineTokens(code, lang);
  const width = String(startLine + lines.length - 1).length;
  const style = { counterReset: `call-ln ${startLine - 1}`, '--ln-w': `${width}ch`, ...(tokens?.base ?? {}) } as CSSProperties;
  return (
    <div className="code-block">
      <div className="code-block-bar">
        <CopyButton text={code} label={t('ui.copyCode')} />
      </div>
      <pre className="code call-lines" role="group" aria-label={lang ? t('codeBlock.labelLang', { lang }) : t('codeBlock.label')} tabIndex={0} data-lang={lang} style={style}>
        {lines.map((line, i) => {
          const runs = tokens?.lines[i];
          // A line is a grid row (its number, its text): the text is one cell however many runs it has
          return (
            <span key={i}>
              <span>
                {runs
                  ? runs.map((run, j) =>
                      typeof run === 'string' ? (
                        <Fragment key={j}>{run}</Fragment>
                      ) : (
                        <span key={j} style={run.style as CSSProperties}>
                          {run.content}
                        </span>
                      ),
                    )
                  : line}
              </span>
            </span>
          );
        })}
      </pre>
    </div>
  );
}

function TreeList({ nodes }: { nodes: TreeNode[] }) {
  const { t } = useTranslation('chat');
  return (
    <ul className="call-tree">
      {nodes.map((node, i) =>
        'more' in node ? (
          <li key={`more-${i}`} className="muted">
            … {t('transcript.call.items', { count: node.more })}
          </li>
        ) : 'children' in node ? (
          <li key={node.key}>
            <span className="k">{node.key}</span> <span className="muted">{node.size}</span>
            <TreeList nodes={node.children} />
          </li>
        ) : (
          <li key={node.key}>
            <span className="k">{node.key}</span> <span className={node.tone === 'scalar' ? 'v n' : 'v'}>{node.leaf}</span>
          </li>
        ),
      )}
    </ul>
  );
}

function FieldValue({ field }: { field: Field }) {
  const { value } = field;
  switch (value.kind) {
    case 'text':
      return <span className="call-field">{value.text}</span>;
    case 'scalar':
      return <span className="call-field mono">{value.text}</span>;
    case 'block':
      return (
        <div className="call-field">
          <CodeBlock code={value.text} />
        </div>
      );
    case 'tree':
      return (
        <div className="call-field">
          <TreeList nodes={value.nodes} />
        </div>
      );
  }
}

/** The input of a tool nobody wrote a lens for: each key, and its value as what it is. */
function Fields({ input }: { input: unknown }) {
  const fields = useMemo(() => fieldsOf(input), [input]);
  if (fields.length === 0) return null;
  return (
    <div className="call-fields">
      {fields.map((field) => (
        <Fragment key={field.key}>
          <span className="call-field-key">{field.key}</span>
          <FieldValue field={field} />
        </Fragment>
      ))}
    </div>
  );
}

/** A result's text read for what it is: a key tree when it is JSON, Markdown when it looks like it, else as it came. */
function ReadResult({ text }: { text: string }) {
  const { t } = useTranslation('chat');
  const reading = useMemo(() => readResult(text), [text]);
  if (!text.trim()) return <p className="muted small">{t('transcript.empty')}</p>;
  if (reading.kind === 'json') return <TreeList nodes={reading.nodes} />;
  if (reading.kind === 'markdown') return <Capped text={reading.text}>{(shown) => <RichText text={shown} />}</Capped>;
  return <Term text={reading.text} />;
}

function GenericLens({ call }: { call: StepCall }) {
  const { t } = useTranslation('chat');
  const hasInput = fieldsOf(call.input).length > 0;
  return (
    <>
      {hasInput && (
        <Zone label={t('transcript.call.input')}>
          <Fields input={call.input} />
        </Zone>
      )}
      {call.result && (
        <Zone label={t('transcript.call.output')}>
          <ReadResult text={call.result.content} />
        </Zone>
      )}
    </>
  );
}

function BashLens({ call }: { call: StepCall }) {
  const { t } = useTranslation('chat');
  const o = asInput(call.input);
  const timeout = typeof o.timeout === 'number' ? o.timeout : null;
  const detail = call.result?.detail?.kind === 'command' ? call.result.detail : null;
  const background = Boolean(detail?.backgroundTaskId) || o.run_in_background === true;
  return (
    <>
      <Zone label={t('transcript.call.input')}>
        <CodeBlock code={str(o.command)} lang="bash" />
        {(timeout !== null || o.run_in_background === true) && (
          <div className="call-meta">
            {timeout !== null && <span>{`timeout ${formatDuration(timeout)}`}</span>}
            {o.run_in_background === true && <span>{t('transcript.call.background')}</span>}
          </div>
        )}
      </Zone>
      {call.result &&
        (background && detail ? (
          <Zone label={t('transcript.call.output')}>
            <p className="small muted">{t('transcript.call.launched')}</p>
          </Zone>
        ) : (
          <>
            <Zone label={t('transcript.call.output')}>
              <Term text={call.result.content} />
              {detail?.interrupted && (
                <span>
                  <Tag tone="warn">{t('transcript.call.interrupted')}</Tag>
                </span>
              )}
            </Zone>
            {detail?.stderr && (
              <Zone label={t('transcript.call.errors')}>
                <Term text={detail.stderr} className="call-stderr" />
              </Zone>
            )}
          </>
        ))}
    </>
  );
}

function ReadLens({ call }: { call: StepCall }) {
  const { t } = useTranslation('chat');
  const [all, setAll] = useState(false);
  const result = call.result;
  const read = useMemo(() => (result ? readText(result.content, result.detail, call.input) : null), [result, call.input]);
  if (!result || !read) return null;
  const o = asInput(call.input);
  const path = result.detail?.kind === 'file' ? result.detail.path : str(o.file_path) || str(o.notebook_path);
  const cut = read.lines.length > READ_CAP_LINES && !all;
  return (
    <Zone label={t('transcript.call.output')}>
      <NumberedCode lines={cut ? read.lines.slice(0, READ_CAP_LINES) : read.lines} startLine={read.startLine} lang={langOfPath(path)} />
      {cut && <ShowAll count={read.lines.length} onShow={() => setAll(true)} />}
    </Zone>
  );
}

function EditLens({ call }: { call: StepCall }) {
  const { t } = useTranslation('chat');
  const { slots } = useChatUi();
  const { cwd } = useRiskContext();
  const detail = call.result?.detail?.kind === 'patch' ? call.result.detail : null;
  // A transcript older than the CLI's recorded patch has nothing exact to draw: its input is the record
  if (!detail?.patch) return <GenericLens call={call} />;
  const { Diff } = slots;
  const counts = patchCounts(detail.patch);
  return (
    <Zone label={t('transcript.call.change')}>
      <Suspense fallback={<pre className="call-term">{detail.patch}</pre>}>
        <Diff path={detail.path} patch={detail.patch} />
      </Suspense>
      <div className="call-meta">
        <span>{relativePath(detail.path, cwd)}</span>
        {counts.additions > 0 && <span className="obs-add">+{counts.additions}</span>}
        {counts.deletions > 0 && <span className="obs-del">−{counts.deletions}</span>}
        {asInput(call.input).replace_all === true && <span>replace_all</span>}
      </div>
    </Zone>
  );
}

function SearchLens({ call }: { call: StepCall }) {
  const { t } = useTranslation('chat');
  const { cwd } = useRiskContext();
  const o = asInput(call.input);
  const options = searchOptions(call.input);
  const result = call.result;
  const reading = useMemo(() => (result ? readSearch(call.name, call.input, result.content, result.detail, cwd) : null), [call.name, call.input, result, cwd]);
  return (
    <>
      <Zone label={t('transcript.call.input')}>
        <div className="call-meta">
          <span>{str(o.pattern)}</span>
          {str(o.path) && <span>{relativePath(str(o.path), cwd)}</span>}
          {options.map((option) => (
            <span key={option}>{option}</span>
          ))}
        </div>
      </Zone>
      {result && reading && (
        <Zone label={t('transcript.call.output')}>
          {reading.mode === 'files' ? (
            reading.files.length > 0 ? (
              <FileList files={reading.files} />
            ) : (
              <p className="muted small">{result.content.trim() || t('transcript.empty')}</p>
            )
          ) : reading.mode === 'count' ? (
            <>
              <p className="small">{t('transcript.call.matches', { count: reading.total })}</p>
              {reading.text && <Term text={reading.text} />}
            </>
          ) : reading.text ? (
            <Capped text={reading.text}>{(shown) => <CodeBlock code={shown} />}</Capped>
          ) : (
            <p className="muted small">{result.content.trim() || t('transcript.empty')}</p>
          )}
        </Zone>
      )}
    </>
  );
}

const FILES_SHOWN = 50;

function FileList({ files }: { files: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, FILES_SHOWN);
  return (
    <>
      <ul className="call-files">
        {shown.map((file, i) => (
          <li key={`${i}-${file}`} title={file}>
            {file}
          </li>
        ))}
      </ul>
      {files.length > shown.length && <ShowAll count={files.length} onShow={() => setAll(true)} />}
    </>
  );
}

function FetchLens({ call }: { call: StepCall }) {
  const { t } = useTranslation('chat');
  const o = asInput(call.input);
  const detail = call.result?.detail?.kind === 'fetch' ? call.result.detail : null;
  const facts = [detail?.status != null ? String(detail.status) : null, detail?.bytes != null ? formatBytes(detail.bytes) : null].filter(Boolean);
  return (
    <>
      <Zone label={t('transcript.call.input')}>
        <span className="call-meta">{str(o.url)}</span>
        {str(o.prompt) && <p className="small">{str(o.prompt)}</p>}
      </Zone>
      {call.result && (
        <Zone label={t('transcript.call.output')}>
          <Capped text={call.result.content}>{(shown) => <RichText text={shown} />}</Capped>
          {facts.length > 0 && <div className="call-meta">{facts.join(' · ')}</div>}
        </Zone>
      )}
    </>
  );
}

function WebSearchLens({ call }: { call: StepCall }) {
  const { t } = useTranslation('chat');
  return (
    <>
      <Zone label={t('transcript.call.input')}>
        <p className="small">{str(asInput(call.input).query)}</p>
      </Zone>
      {call.result && (
        <Zone label={t('transcript.call.output')}>
          <Capped text={call.result.content}>{(shown) => <RichText text={shown} />}</Capped>
        </Zone>
      )}
    </>
  );
}

function AgentLens({ call }: { call: StepCall }) {
  const { t } = useTranslation('chat');
  const o = asInput(call.input);
  const detail = call.result?.detail?.kind === 'agent' ? call.result.detail : null;
  const background = agentInBackground(call.input, call.result?.detail);
  const model = detail?.model ?? (str(o.model) || null);
  const prompt = str(o.prompt);
  return (
    <>
      <Zone label={t('transcript.call.input')}>
        <span className="call-meta">
          {str(o.subagent_type) && <Tag>{str(o.subagent_type)}</Tag>}
          {model && <Tag>{model}</Tag>}
          {background && <Tag>{t('transcript.call.background')}</Tag>}
        </span>
        {prompt && (
          <Collapsible className="fold" title={<span className="call-label">{t('transcript.call.prompt')}</span>}>
            <RichText text={prompt} />
          </Collapsible>
        )}
      </Zone>
      {call.result && (
        <Zone label={t('transcript.call.output')}>
          {background ? <p className="small muted">{t('transcript.call.launched')}</p> : <ReadResult text={agentReport(call.result.content)} />}
        </Zone>
      )}
    </>
  );
}

const CHECK_ICON: Record<ChecklistStatus, typeof Circle> = { pending: Circle, inProgress: CircleDot, completed: Check };

function TodoLens({ call }: { call: StepCall }) {
  const { t } = useTranslation('chat');
  const items = useMemo(() => checklistOf(call.name, call.input), [call.name, call.input]);
  if (items.length === 0) return <GenericLens call={call} />;
  return (
    <Zone label={t('transcript.call.input')}>
      <ul className="call-checklist">
        {items.map((item, i) => {
          const Icon = CHECK_ICON[item.status];
          return (
            <li key={i} className={`is-${item.status}`}>
              <Icon {...ICON_SM} aria-hidden />
              <span>{item.text}</span>
              <span className="word">{t(`transcript.call.status.${item.status}`)}</span>
            </li>
          );
        })}
      </ul>
    </Zone>
  );
}

const LENS_VIEWS = { bash: BashLens, read: ReadLens, edit: EditLens, search: SearchLens, fetch: FetchLens, websearch: WebSearchLens, agent: AgentLens, todo: TodoLens, generic: GenericLens };

/** What the row always showed: the input's JSON and the result's text, for whoever needs them. */
export function RawBody({ call }: { call: StepCall }) {
  const { t } = useTranslation('chat');
  return (
    <>
      {call.name !== null && (
        <Zone label={t('transcript.call.input')}>
          <CodeBlock code={JSON.stringify(call.input, null, 2)} lang="json" />
        </Zone>
      )}
      {call.result && (
        <Zone label={t('transcript.call.output')}>
          <Capped text={call.result.content}>{(shown) => <CodeBlock tone={call.result?.isError ? 'error' : undefined} code={shown || t('transcript.empty')} />}</Capped>
        </Zone>
      )}
    </>
  );
}

/**
 * The opened body of a call. A failed call's result is its error, whatever the tool: the lens keeps
 * the call zone and shows the error as the row always did. `running` is a call still waiting for it.
 */
export function ToolBody({ call, running }: { call: StepCall; running: boolean }) {
  const { t } = useTranslation('chat');
  const [raw, setRaw] = useState(false);
  const failed = call.result?.isError === true;
  const Lens = LENS_VIEWS[lensOf(call.name)];
  return (
    <div className="call-body">
      {raw ? (
        <RawBody call={call} />
      ) : failed && call.result ? (
        <>
          {call.name !== null && <Lens call={{ ...call, result: null }} />}
          <ErrorResult text={call.result.content} />
        </>
      ) : (
        <Lens call={call} />
      )}
      {running && <p className="muted small">{t('transcript.callWaiting')}</p>}
      {call.name !== null && (
        <button type="button" className="btn btn-ghost btn-small call-raw" onClick={() => setRaw((on) => !on)}>
          {raw ? t('transcript.call.lens') : t('transcript.call.raw')}
        </button>
      )}
    </div>
  );
}
