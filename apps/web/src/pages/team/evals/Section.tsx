import { useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Team } from '@claudio/shared';
import { useEvalFiles } from '../../../api';
import { teamSearch } from '../model';
import { EvalEditor } from './Editor';
import { EvalHistory } from './History';
import { EvalList } from './List';
import { peekProposed } from './run-model';
import { RunView } from './Run';
import { StartEval } from './Start';

/**
 * The Evals section of the Team tab, by its address: the list; one eval (`&eval=<name>`) with its
 * history; one run (`&run=<id>`). `&for=<agent>` is the entry from a member's page, which filters
 * the list to that agent and offers to run its evals over the text the page handed over. The start
 * dialog opens over whichever of them asked for it, and only a click on it starts anything.
 */
export function EvalsSection({ projectId, team, switcher }: { projectId: string; team: Team; switcher: ReactNode }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const files = useEvalFiles(projectId);
  const evalName = params.get('eval');
  const runId = params.get('run');
  const forAgent = params.get('for');
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState(false);
  const [starting, setStarting] = useState<{ name: string; proposed: string | null } | null>(null);

  const go = (next: Parameters<typeof teamSearch>[1], replace = false) => navigate({ search: teamSearch(params, next) }, { replace });
  const closeEval = () => {
    setCreating(false);
    setHistory(false);
    go({ eval: null, run: null }, true);
  };

  let page: ReactNode;
  if (runId)
    page = <RunView key={runId} projectId={projectId} runId={runId} onBack={() => go({ run: null })} />;
  else if (evalName && history)
    page = <EvalHistory projectId={projectId} name={evalName} onBack={() => setHistory(false)} onOpenRun={(id) => go({ eval: evalName, run: id })} />;
  else if (evalName || creating)
    page = (
      <EvalEditor
        key={evalName ?? 'new'}
        projectId={projectId}
        team={team}
        name={evalName}
        existing={(files.data ?? []).map((file) => file.name)}
        initialAgent={forAgent}
        onBack={closeEval}
        onSaved={(name) => {
          setCreating(false);
          go({ eval: name }, true);
        }}
        onRun={() => evalName && setStarting({ name: evalName, proposed: null })}
        onHistory={() => setHistory(true)}
      />
    );
  else
    page = (
      <EvalList
        projectId={projectId}
        toolbar={switcher}
        agent={forAgent}
        onOpen={(name) => go({ eval: name })}
        onNew={() => setCreating(true)}
        onClearAgent={() => go({ for: null }, true)}
        onEvaluate={forAgent ? (name) => setStarting({ name, proposed: peekProposed(sessionStorage, projectId, forAgent) }) : undefined}
      />
    );

  return (
    <>
      {page}
      {starting && (
        <StartEval
          projectId={projectId}
          name={starting.name}
          initialProposed={starting.proposed}
          onClose={() => setStarting(null)}
          onEditor={() => {
            setStarting(null);
            go({ eval: starting.name, run: null });
          }}
          onStarted={(run) => {
            setStarting(null);
            go({ eval: starting.name, run: run.id });
          }}
        />
      )}
    </>
  );
}
