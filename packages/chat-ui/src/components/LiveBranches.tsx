import type { ChatChildren } from '@claudio/shared';
import { Bot, Check, ChevronRight, CircleAlert, CircleStop, Terminal } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Collapsible } from '@claudio/ui/components/controls/Collapsible';
import { Sheet } from '@claudio/ui/components/controls/Sheet';
import { ICON_SM } from '@claudio/ui/components/icons';
import { AnimatePresence, EASE_OUT, motion } from '@claudio/ui/components/motion';
import { ProgressBar } from '@claudio/ui/components/ProgressBar';
import { Spinner } from '@claudio/ui/components/Spinner';
import { formatDuration } from '@claudio/ui/lib/format';
import { activityTarget, activityVerb, formatElapsed } from '@claudio/ui/lib/live';
import { NARROW, useMediaQuery } from '@claudio/ui/lib/media';
import { useClockTick, useMotionLevel } from '@claudio/ui/lib/motion';
import type { ProgressStatus } from '@claudio/ui/lib/progress';
import { branchCounts, branchElapsed, liveBranches, newestBranch, nextExpiry, type Branch, type BranchCounts } from '../lib/chat-branches';

/** Where the strip's fold is remembered: `'open' | 'closed'`, closed when nothing is stored. */
export const BRANCHES_STORAGE_KEY = 'claudio-chat-branches';

/** A screen reader hears what changed in the strip, and no more often than this. */
const ANNOUNCE_EVERY_MS = 5000;

function readFold(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(BRANCHES_STORAGE_KEY) === 'open';
  } catch {
    // Storage blocked: the strip starts folded, as it does for anyone the first time
    return false;
  }
}

function writeFold(open: boolean): void {
  try {
    localStorage.setItem(BRANCHES_STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // Storage blocked: the fold holds for this page only
  }
}

/** The count of what runs, by kind, leaving out the kinds there are none of: "2 agents · 1 background task". */
export function useCountLine(counts: BranchCounts): string {
  const { t } = useTranslation('chat');
  return [
    counts.agents > 0 ? t('branches.agents', { count: counts.agents }) : null,
    counts.tasks > 0 ? t('branches.tasks', { count: counts.tasks }) : null,
    counts.workflows > 0 ? t('branches.workflows', { count: counts.workflows }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The verb of a subagent's line, lower case as it sits mid-line ("Explore · reading …"). */
function useVerb(): (branch: Branch) => { verb: string; target: string } {
  const { t, i18n } = useTranslation('primitives');
  return (branch) => {
    if (!branch.activity) return { verb: t('activity.working').toLocaleLowerCase(i18n.language), target: '' };
    return { verb: t(`activity.${activityVerb(branch.activity)}`).toLocaleLowerCase(i18n.language), target: activityTarget(branch.activity) };
  };
}

/** How long it has run: a ticking `m:ss` while it runs, its final length once it has ended. */
function BranchClock({ branch, words = false }: { branch: Branch; words?: boolean }) {
  const running = branch.status === 'running';
  const tick = useClockTick(running ? 1000 : 60_000);
  const ms = useMemo(() => branchElapsed(branch, Date.now()), [branch, tick]);
  return <>{words && !running ? formatDuration(ms) : formatElapsed(ms)}</>;
}

const STATE_ICON = { completed: Check, failed: CircleAlert, stopped: CircleStop } as const;

function SettledIcon({ status }: { status: keyof typeof STATE_ICON }) {
  const Icon = STATE_ICON[status];
  return <Icon {...ICON_SM} className={`chat-branch-icon is-${status}`} />;
}

/** Its state: the braille spinner while it runs, else an icon in its tone beside its word. */
function BranchState({ branch, word }: { branch: Branch; word: string }) {
  if (branch.status === 'running') {
    return (
      <span className="state">
        <Spinner />
      </span>
    );
  }
  return (
    <>
      <span className="state">
        <SettledIcon status={branch.status} />
      </span>
      <span className="word">{word}</span>
    </>
  );
}

function BranchRow({ branch }: { branch: Branch }) {
  const { t } = useTranslation('chat');
  const verbOf = useVerb();
  const line = branch.kind === 'agent' && branch.status === 'running' ? verbOf(branch) : null;
  // The spaces between the cells are not drawn (the row is flex) but keep its name in words
  return (
    <>
      <BranchState branch={branch} word={t(`branches.state.${branch.status}`)} />{' '}
      <span className="badge chat-branch-kind">{branch.label}</span>{' '}
      <span className={`chat-branch-desc ${branch.mono ? 'mono' : ''}`.trimEnd()}>{branch.description}</span>{' '}
      <span className="chat-branch-act">
        {line && <span className="verb">{line.verb}</span>}
        {line?.target ? ` ${line.target}` : ''}
        {branch.kind === 'workflow' && branch.progress && branch.status === 'running' ? <WorkflowFacts branch={branch} /> : null}
      </span>{' '}
      <span className="chat-branch-time">
        <BranchClock branch={branch} />
      </span>
    </>
  );
}

function WorkflowFacts({ branch }: { branch: Branch }) {
  const { t } = useTranslation('chat');
  const progress = branch.progress;
  if (!progress || progress.total === 0) return null;
  return <>{progress.phase > 0 ? t('branches.workflowFacts', { done: progress.done, total: progress.total, n: progress.phase }) : t('branches.workflowAgents', { done: progress.done, total: progress.total })}</>;
}

function BranchList({ branches, onOpen }: { branches: Branch[]; onOpen: (branch: Branch) => void }) {
  const { t } = useTranslation('chat');
  const level = useMotionLevel();
  const byKey = useMemo(() => new Map(branches.map((branch) => [branch.key, branch])), [branches]);
  return (
    <AnimatePresence initial={false}>
      {branches.map((branch) => {
        const owner = branch.parent ? byKey.get(branch.parent) : undefined;
        return (
          <motion.button
            key={branch.key}
            type="button"
            className={`chat-branch-row is-${branch.status} ${owner ? 'is-nested' : ''}`.trimEnd()}
            // Named by what it shows, so a voice user can say the words they see; the indent that
            // says whose it is cannot be read, so a nested row says its owner off screen
            onClick={() => onOpen(branch)}
            exit={level === 'full' ? { height: 0, opacity: 0 } : { opacity: 0 }}
            transition={{ duration: level === 'full' ? 0.2 : 0, ease: EASE_OUT }}
          >
            <BranchRow branch={branch} />
            {owner && <span className="sr-only"> · {t('branches.nested', { owner: owner.description })}</span>}
          </motion.button>
        );
      })}
    </AnimatePresence>
  );
}

/** Holds a value back until enough time has passed since the last one it let through. */
function useThrottled(value: string): string {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const since = Date.now() - last.current;
    const show = () => {
      last.current = Date.now();
      setShown(value);
    };
    if (since >= ANNOUNCE_EVERY_MS) {
      show();
      return;
    }
    const timer = setTimeout(show, ANNOUNCE_EVERY_MS - since);
    return () => clearTimeout(timer);
  }, [value]);
  return shown;
}

/**
 * What the chat has running beside it, over the composer: every subagent, background command and
 * workflow that runs, or ended under five seconds ago. One folded line by default (the count and
 * the newest activity), and the person's fold is remembered; the list opens under it, or as a sheet
 * on a phone. With nothing to show it is not on the page at all.
 */
export const LiveBranches = memo(function LiveBranches({ branches: children, onOpen }: { branches: ChatChildren; onOpen: (branch: Branch) => void }) {
  const [now, setNow] = useState(() => Date.now());
  const branches = useMemo(() => liveBranches(children, Date.now()), [children, now]);
  // A branch that ended leaves after its grace: the page looks again when the first one is due
  const expiry = nextExpiry(branches, Date.now());
  useEffect(() => {
    if (expiry === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, expiry - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [expiry]);
  if (branches.length === 0) return null;
  return <Strip branches={branches} onOpen={onOpen} />;
});

function Strip({ branches, onOpen }: { branches: Branch[]; onOpen: (branch: Branch) => void }) {
  const { t } = useTranslation('chat');
  const phone = useMediaQuery(NARROW);
  const [open, setOpen] = useState(readFold);
  const [sheet, setSheet] = useState(false);
  const counts = branchCounts(branches);
  const count = useCountLine(counts);
  const newest = newestBranch(branches);
  const verbOf = useVerb();
  const line = newest?.kind === 'agent' && newest.activity ? verbOf(newest) : null;
  const running = branches.some((branch) => branch.status === 'running');
  // With nothing left running, the bar says how the last one to end finished
  const settled = running ? null : branches.reduce<Branch | null>((last, branch) => (!last || (branch.endedAt ?? '') > (last.endedAt ?? '') ? branch : last), null);
  const announcement = useThrottled([count, newest ? (line ? `${newest.label} ${line.verb} ${line.target}` : newest.description) : ''].filter(Boolean).join(' · '));

  const now: ReactNode = newest ? (
    <span className="chat-branches-now">
      {line ? (
        <>
          {newest.label} · <span className="verb">{line.verb}</span>
          {line.target ? ` ${line.target}` : ''}
        </>
      ) : (
        newest.description
      )}
      {' · '}
      <BranchClock branch={newest} />
    </span>
  ) : null;
  const bar = (
    <>
      {settled && settled.status !== 'running' ? <SettledIcon status={settled.status} /> : <Spinner />}
      <span className="chat-branches-count">{count || (settled ? t(`branches.state.${settled.status}`) : '')}</span>
      {now}
    </>
  );
  const select = (branch: Branch) => {
    setSheet(false);
    onOpen(branch);
  };

  if (phone) {
    return (
      <div className="chat-branches is-phone">
        <span className="sr-only" role="status">
          {announcement}
        </span>
        <button type="button" className="chat-branches-bar" aria-expanded={sheet} aria-haspopup="dialog" onClick={() => setSheet(true)}>
          {bar}
          <ChevronRight {...ICON_SM} className="collapsible-chevron" />
          <span className="sr-only">{t('branches.show')}</span>
        </button>
        <Sheet open={sheet} onOpenChange={setSheet} title={t('branches.title')} description={count || undefined} side="bottom" className="chat-branches-sheet">
          <div className="chat-branches-list" role="group" aria-label={t('branches.title')}>
            <BranchList branches={branches} onOpen={select} />
          </div>
        </Sheet>
      </div>
    );
  }
  return (
    <div className="chat-branches">
      <span className="sr-only" role="status">
        {announcement}
      </span>
      <Collapsible
       
        triggerClassName="chat-branches-bar"
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          writeFold(next);
        }}
        title={
          <>
            {bar}
            <span className="sr-only">{open ? t('branches.hide') : t('branches.show')}</span>
          </>
        }
      >
        <div className="chat-branches-list" role="group" aria-label={t('branches.title')}>
          <BranchList branches={branches} onOpen={onOpen} />
        </div>
      </Collapsible>
    </div>
  );
}

// ---------- the card under a step ----------

const SEGMENT: Record<'running' | 'completed' | 'failed', ProgressStatus> = { completed: 'done', running: 'running', failed: 'failed' };

/**
 * A branch a step started, as the card the conversation keeps where the delegation happened: what
 * it is, how it stands (the spinner and the live rail while it runs, its final word and length once
 * it has ended), and a way to its panel. Never a gradient: the rail says it runs.
 */
export const BranchCard = memo(function BranchCard({ branch, onOpen }: { branch: Branch; onOpen?: (branch: Branch) => void }) {
  const { t } = useTranslation('chat');
  const verbOf = useVerb();
  const running = branch.status === 'running';
  const line = branch.kind === 'agent' && running && branch.activity ? verbOf(branch) : null;
  const mark =
    branch.kind === 'agent' ? <Bot {...ICON_SM} /> : branch.kind === 'task' ? <Terminal {...ICON_SM} /> : branch.description.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2).toUpperCase();
  const lead = branch.kind === 'agent' ? branch.label : branch.kind === 'task' ? (branch.command ?? branch.label) : null;
  const StateIcon = branch.status === 'running' ? null : STATE_ICON[branch.status];
  return (
    <div className={`chat-launch is-${branch.kind} ${running ? 'live-rail is-running' : ''}`.trimEnd()}>
      <div className="chat-launch-head">
        <span className="chat-launch-mark" aria-hidden>
          {mark}
        </span>
        <span className="chat-launch-what">
          <span className="chat-launch-name ellipsis">{branch.description}</span>
          <span className="chat-launch-state">
            {StateIcon ? <StateIcon {...ICON_SM} className={`chat-branch-icon is-${branch.status}`} /> : <Spinner />}
            <span className={`chat-launch-status is-${branch.status}`}>{t(`branches.state.${branch.status}`)}</span>
            <span className="chat-launch-facts">
              {lead !== null && `${lead} · `}
              {branch.kind === 'workflow' && branch.progress && branch.progress.total > 0 && (
                <>
                  <WorkflowFacts branch={branch} />
                  {' · '}
                </>
              )}
              {line && (
                <>
                  <span className="verb">{line.verb}</span>
                  {line.target ? ` ${line.target}` : ''}
                  {' · '}
                </>
              )}
              <BranchClock branch={branch} words />
            </span>
          </span>
        </span>
        {onOpen && (
          <button type="button" className="btn btn-small chat-launch-open" onClick={() => onOpen(branch)} aria-label={t('branches.open', { what: branch.description })}>
            {t('branches.openButton')}
            <ChevronRight {...ICON_SM} />
          </button>
        )}
      </div>
      {branch.kind === 'workflow' && branch.segments.length > 0 && (
        <ProgressBar variant="segments" size="sm" decorative cells={branch.segments.map((status) => SEGMENT[status])} />
      )}
    </div>
  );
});
