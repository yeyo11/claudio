// A project is a git repository and its worktrees are its children (docs/plans/projects-as-repositories.md).
// Chats that ran in a worktree the CLI made under the main checkout, started from a sibling linked
// worktree (`originalCwd`), are one suggestion for the repository, never one for the sibling. A
// suggestion can be hidden and brought back. The wizard says a worktree is not the repository and
// offers the main checkout. The Worktrees tab lists the main checkout first, then the others, and a
// worktree's chats are one click away.
//
// Not covered here: re-pointing a project that was imported inside a worktree (D12). Importing is
// refused for such a path now, and the harness cannot seed `projects.json` under a running server, so
// that flow is covered by core's tests (repoint in packages/core/test/projects.test.ts) until a spec
// can restart the server with a seeded document.
//
// It builds real repositories under the home folder (the sandbox is scratch, never suggested) and seeds transcripts in its Claude
// config directory, and removes everything at the end: other specs count what the sandbox holds.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION = 'e2e-repos-session';
const line = (o) => JSON.stringify(o);
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' }).toString();
const slug = (path) => path.replace(/[^a-zA-Z0-9]/g, '-');

/** A repository with a sibling linked worktree and a worktree the CLI would have made under it. */
function seedRepo(root) {
  const main = join(root, 'claudio-e2e');
  const sibling = join(root, 'claudio-e2e-stage');
  const cli = join(main, '.claude', 'worktrees', 's1');
  mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  writeFileSync(join(main, 'README.md'), 'e2e\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'initial commit');
  git(main, 'worktree', 'add', '-q', '-b', 'stage', sibling);
  git(main, 'worktree', 'add', '-q', '-b', 'worktree-s1', cli);
  return { main, sibling, cli };
}

/** A chat in the CLI's worktree that records where the person started `claude --worktree`: the sibling. */
function seedTranscript(configDir, { cli, sibling }) {
  const dir = join(configDir, 'projects', slug(cli));
  mkdirSync(dir, { recursive: true });
  const at = (s) => new Date(Date.now() - 60_000 + s * 1000).toISOString();
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    [
      line({ type: 'worktree-state', worktreeSession: { worktreePath: cli, originalCwd: sibling, worktreeName: 's1', worktreeBranch: 'worktree-s1' } }),
      line({ type: 'user', uuid: 'r-1', timestamp: at(0), cwd: cli, message: { role: 'user', content: 'Tidy the readme' } }),
      line({
        type: 'assistant',
        uuid: 'r-2',
        timestamp: at(1),
        cwd: cli,
        message: { role: 'assistant', id: 'msg-r-2', model: 'claude-sonnet-5', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 5, output_tokens: 5 } },
      }),
      '',
    ].join('\n'),
  );
  return dir;
}

export default async ({ page, api, check, dirs }) => {
  // Not under the sandbox: it lives in the temp dir, which suggestions never offer (D8). The server runs
  // as the same user with the same $HOME, and everything is removed at the end.
  const root = join(homedir(), `claudio-e2e-repos-${process.pid}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const repo = seedRepo(root);
  const transcripts = seedTranscript(dirs.configDir, repo);
  let projectId = null;
  const hidden = [];

  try {
    // ---- the API: one suggestion for the repository, never one for the sibling worktree
    const listed = await api.request('GET', '/projects/candidates');
    check(listed.status === 200, `the suggestions are served (${listed.status})`);
    const ours = listed.body.filter((c) => c.path.endsWith('claudio-e2e') || c.path.endsWith('claudio-e2e-stage'));
    check(ours.length === 1 && ours[0].kind === 'repository' && ours[0].path.endsWith('claudio-e2e'), `one suggestion, for the main checkout (${JSON.stringify(ours.map((c) => c.path))})`);
    check(ours[0]?.worktreeCount >= 1, `it counts the worktree the chat ran in (${ours[0]?.worktreeCount})`);
    const key = ours[0]?.key;

    // ---- the Projects page: the repository's row, hidden and brought back
    await page.viewport(1440, 1024);
    await page.goto('/projects', 1500);
    const rowOf = `[...document.querySelectorAll('main .candidate-row')].find((r) => r.querySelector('strong')?.textContent === 'claudio-e2e')`;
    const open = async () => {
      // With projects already in the sandbox the suggestions are the nudge, folded until asked for
      const folded = await page.eval(`return !document.querySelector('main .project-candidates') && !!document.querySelector('main .project-callout .btn')`);
      if (folded && !(await page.eval(`return !!(${rowOf})`))) await page.click('main .project-callout .btn', undefined, 500);
    };
    await open();
    await page.waitFor(`return !!(${rowOf})`, { label: 'the repository is suggested' });
    const meta = await page.eval(`return (${rowOf}).innerText`);
    check(/worktree/.test(meta), `the row says how many worktrees the chats ran in (${meta.replace(/\n/g, ' · ')})`);
    check(!(await page.eval(`return [...document.querySelectorAll('main .candidate-row strong')].some((s) => s.textContent === 'claudio-e2e-stage')`)), 'the sibling worktree is not offered');

    await page.click('main .candidate-row [aria-label="Hide claudio-e2e"]', undefined, 600);
    check(!(await page.eval(`return !!(${rowOf})`)), 'hiding removes the row at once');
    hidden.push(key);
    const undo = await page.eval(`return [...document.querySelectorAll('.toast-action')].map((b) => b.textContent.trim()).join(',')`);
    check(undo === 'Undo', `the toast offers to undo (${undo})`);
    await page.click('.toast-action', undefined, 800);
    await open();
    await page.waitFor(`return !!(${rowOf})`, { label: 'the suggestion is back after Undo' });
    hidden.pop();

    // ---- the wizard: a worktree is not the repository, and the way to the main checkout is one click
    await page.goto(`/projects/new?path=${encodeURIComponent(repo.sibling)}`, 1200);
    await page.waitFor(`return !!document.querySelector('main .wizard-inspect.field-error')`, { label: 'the wizard says the path is a worktree', timeout: 8000 });
    const refusal = await page.text('main .wizard-inspect.field-error');
    check(/worktree of claudio-e2e/.test(refusal), `it names the repository (${refusal.replace(/\n/g, ' ')})`);
    check(await page.eval(`return document.querySelector('main .wizard-create').disabled`), 'Create stays disabled while the path is a worktree');
    await page.click('main .wizard-inspect-action', undefined, 800);
    const typed = await page.eval(`return document.querySelector('main input[aria-label="Directory"]')?.value`);
    check(typed.endsWith('claudio-e2e') && !typed.endsWith('stage'), `"Use …" replaces the path with the main checkout (${typed})`);
    await page.waitFor(`return !document.querySelector('main .wizard-inspect.field-error') && /Git repository/.test(document.querySelector('main .wizard-inspect')?.innerText ?? '')`, { label: 'the main checkout is a repository', timeout: 8000 });

    // ---- the Worktrees tab: the main checkout first, then the others
    const imported = await api.post('/projects/import', { path: repo.main });
    check(imported.status === 201 || imported.status === 200, `the main checkout imports (${imported.status})`);
    projectId = imported.body.id;
    await page.goto(`/?project=${encodeURIComponent(projectId)}&view=worktrees`, 1500);
    await page.waitFor(`return !!document.querySelector('main .worktree-row')`, { label: 'the worktree rows' });
    const rows = await page.eval(`return [...document.querySelectorAll('main .worktree-row')].map((r) => ({ main: r.classList.contains('is-main'), text: r.innerText, newChat: !!r.querySelector('.worktree-new') }))`);
    check(rows[0]?.main && /main/.test(rows[0].text) && !rows[0].newChat, 'the main checkout comes first, marked "main", with no New chat here');
    const cliRow = rows.find((r) => /worktree-s1/.test(r.text));
    check(!!cliRow && cliRow.newChat, 'the CLI worktree has its branch and New chat here');
    check(/1 chat/.test(cliRow?.text ?? ''), `it counts the chat that ran in it (${(cliRow?.text ?? '').replace(/\n/g, ' · ')})`);
    check(!!rows.find((r) => /stage/.test(r.text)), 'the sibling worktree is a child of the repository too');

    // ---- the chats of one worktree
    await page.click('main .worktree-chats', undefined, 1200);
    check((await page.eval(`return location.search`)).includes('worktree='), 'the chat count leads to the worktree\'s chats');
    check(/Worktree:/.test(await page.text('main')), 'the list says it is narrowed to a worktree');
  } finally {
    if (projectId) await api.request('DELETE', `/projects/${encodeURIComponent(projectId)}`);
    for (const k of hidden) await api.post('/projects/candidates/unhide', { key: k });
    rmSync(transcripts, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
};
