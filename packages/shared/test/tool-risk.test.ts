import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isSecretPath, toolRisk, type ToolRiskContext, type ToolRiskFactor, type ToolRiskLevel } from '../src/index.ts';

const CTX: ToolRiskContext = { cwd: '/home/x/p', roots: ['/home/x/worktrees/t1'] };

interface Case {
  name: string;
  tool?: string;
  input: Record<string, unknown>;
  level: ToolRiskLevel;
  /** Exactly these factors, heaviest first; omitted means not checked */
  factors?: ToolRiskFactor[];
  ctx?: ToolRiskContext;
}

const bash = (name: string, command: string, level: ToolRiskLevel, factors?: ToolRiskFactor[], ctx?: ToolRiskContext): Case => ({ name, input: { command }, level, ...(factors ? { factors } : {}), ...(ctx ? { ctx } : {}) });
const file = (name: string, tool: string, path: string, level: ToolRiskLevel, factors?: ToolRiskFactor[], ctx?: ToolRiskContext): Case => ({
  name,
  tool,
  input: tool === 'NotebookEdit' ? { notebook_path: path } : { file_path: path },
  level,
  ...(factors ? { factors } : {}),
  ...(ctx ? { ctx } : {}),
});

const CASES: Case[] = [
  // ---- irreversible, and the regenerable exception
  bash('rm -rf of a build output is low', 'rm -rf node_modules', 'low', []),
  bash('rm -rf of several regenerable targets is low', 'rm -rf dist build .next coverage', 'low', []),
  bash('rm -rf of a nested regenerable target is low', 'rm -rf packages/a/node_modules', 'low', []),
  bash('rm -rf of an absolute regenerable target inside the directory is low', 'rm -rf /home/x/p/dist', 'low', []),
  bash('rm -rf of the contents of a regenerable target is low', 'rm -rf dist/*', 'low', []),
  bash('rm -rf of tmp under the directory is low', 'rm -rf ./tmp', 'low', []),
  bash('rm -rf of a regenerable target and something else is not', 'rm -rf node_modules src', 'high', ['irreversible', 'wide-scope']),
  bash('rm -rf of anything else is irreversible and wide', 'rm -rf src', 'high', ['irreversible', 'wide-scope']),
  bash('rm -r with the long flag is recursive', 'rm --recursive src', 'high', ['irreversible', 'wide-scope']),
  bash('rm of one file inside the directory is low', 'rm notes.txt', 'low', []),
  bash('rm of a file outside the directory is irreversible and outside', 'rm /etc/hosts', 'high', ['irreversible', 'outside-workdir']),
  bash('rm -rf of /tmp is outside, so tmp is not regenerable there', 'rm -rf /tmp/work', 'high', ['irreversible', 'outside-workdir', 'wide-scope']),
  bash('rm -rf of a glob in the root is the widest', 'rm -rf /*', 'high', ['irreversible', 'outside-workdir', 'wide-scope']),
  bash('rm -rf of home is outside', 'rm -rf ~/projects', 'high', ['irreversible', 'outside-workdir', 'wide-scope']),
  bash('rm -rf of a parent directory is outside', 'rm -rf ../other', 'high', ['irreversible', 'outside-workdir', 'wide-scope']),
  bash('rm of an unset variable is not outside', 'rm $FILE', 'low', []),
  bash('rm -rf of a variable is still recursive', 'rm -rf "$DIR"', 'high', ['irreversible', 'wide-scope']),
  bash('git reset --hard', 'git reset --hard HEAD~1', 'high', ['irreversible']),
  bash('git reset --soft is fine', 'git reset --soft HEAD~1', 'low', []),
  bash('git clean -fd', 'git clean -fd', 'high', ['irreversible']),
  bash('git clean -n is a dry run', 'git clean -nfd', 'low', []),
  bash('git branch -D', 'git branch -D old', 'high', ['irreversible']),
  bash('git branch -d is fine', 'git branch -d old', 'low', []),
  bash('git checkout -- . discards work', 'git checkout -- .', 'high', ['irreversible']),
  bash('git checkout of a branch is fine', 'git checkout main', 'low', []),
  bash('git restore . discards work', 'git restore .', 'high', ['irreversible']),
  bash('git restore --staged . only unstages', 'git restore --staged .', 'low', []),
  bash('git stash drop', 'git stash drop', 'high', ['irreversible']),
  bash('git stash clear', 'git stash clear', 'high', ['irreversible']),
  bash('git stash push is fine', 'git stash push -m wip', 'low', []),
  bash('git with global options is read past them', 'git -C /home/x/p reset --hard', 'high', ['irreversible']),
  bash('find -delete', 'find . -name "*.orig" -delete', 'high', ['irreversible', 'wide-scope']),
  bash('dd to a device', 'dd if=/dev/zero of=/dev/sda', 'high', ['irreversible']),
  bash('dd without an output file reads only', 'dd if=/dev/urandom bs=1 count=4', 'low', []),
  bash('mkfs', 'mkfs.ext4 /dev/sdb1', 'high', ['irreversible']),
  bash('shred', 'shred -u secrets.txt', 'high', ['irreversible']),
  bash('truncate', 'truncate -s 0 app.log', 'high', ['irreversible']),
  bash('SQL drop table', 'psql -c "DROP TABLE users"', 'high', ['irreversible']),
  bash('SQL truncate table', "sqlite3 app.db 'truncate table logs'", 'high', ['irreversible']),
  bash('SQL delete without where', 'mysql -e "delete from orders"', 'high', ['irreversible']),
  bash('SQL delete with where is fine', 'mysql -e "delete from orders where id = 4"', 'low', []),
  bash('SQL select is fine', 'psql -c "select 1"', 'low', []),
  bash('docker rm', 'docker rm -f web', 'high', ['irreversible']),
  bash('docker volume rm', 'docker volume rm data', 'high', ['irreversible']),
  bash('docker system prune', 'docker system prune -af', 'high', ['irreversible']),
  bash('docker ps is fine', 'docker ps -a', 'low', []),
  bash('kubectl delete', 'kubectl delete pod web', 'high', ['irreversible']),
  bash('terraform destroy', 'terraform destroy -auto-approve', 'high', ['irreversible']),

  // ---- history-rewrite and leaves-machine
  bash('git push --force', 'git push --force origin main', 'high', ['history-rewrite', 'leaves-machine']),
  bash('git push -f', 'git push -f', 'high', ['history-rewrite', 'leaves-machine']),
  bash('git push --force-with-lease', 'git push --force-with-lease origin feat', 'high', ['history-rewrite', 'leaves-machine']),
  bash('git push of a +refspec is a force', 'git push origin +main', 'high', ['history-rewrite', 'leaves-machine']),
  bash('git push alone leaves the machine', 'git push origin feat', 'high', ['leaves-machine']),
  bash('git push --dry-run is low', 'git push --dry-run origin main', 'low', []),
  bash('git push -n is low', 'git push -n', 'low', []),
  bash('git rebase', 'git rebase -i HEAD~3', 'high', ['history-rewrite']),
  bash('git commit --amend', 'git commit --amend --no-edit', 'high', ['history-rewrite']),
  bash('git commit is fine', 'git commit -m "wip"', 'low', []),
  bash('git filter-branch', 'git filter-branch --tree-filter x', 'high', ['history-rewrite']),
  bash('git filter-repo', 'git filter-repo --path src', 'high', ['history-rewrite']),
  bash('npm publish', 'npm publish', 'high', ['leaves-machine']),
  bash('pnpm publish with flags first', 'pnpm -r publish --access public', 'high', ['leaves-machine']),
  bash('yarn npm publish', 'yarn npm publish', 'high', ['leaves-machine']),
  bash('npm publish --dry-run is low', 'npm publish --dry-run', 'low', []),
  bash('npm install is fine', 'npm install left-pad', 'low', []),
  bash('docker push', 'docker push acme/web:1', 'high', ['leaves-machine']),
  bash('gh pr create', 'gh pr create --title x --body y', 'high', ['leaves-machine']),
  bash('gh pr merge', 'gh pr merge 12 --squash', 'high', ['leaves-machine']),
  bash('gh pr comment through a repo flag', 'gh -R acme/web pr comment 3 -b hi', 'high', ['leaves-machine']),
  bash('gh pr view is fine', 'gh pr view 12', 'low', []),
  bash('gh release create', 'gh release create v1', 'high', ['leaves-machine']),
  bash('gh issue create', 'gh issue create -t x', 'high', ['leaves-machine']),
  bash('gh api with a write method', 'gh api -X DELETE repos/a/b/issues/1', 'high', ['leaves-machine']),
  bash('gh api with a field', 'gh api repos/a/b/issues -f title=x', 'high', ['leaves-machine']),
  bash('gh api read is fine', 'gh api repos/a/b/issues', 'low', []),
  bash('glab mr create', 'glab mr create -t x', 'high', ['leaves-machine']),
  bash('glab release create', 'glab release create v1', 'high', ['leaves-machine']),
  bash('curl -X POST', 'curl -X POST https://api.example.com/x', 'high', ['leaves-machine']),
  bash('curl -XPUT attached', 'curl -XPUT https://api.example.com/x', 'high', ['leaves-machine']),
  bash('curl with data', "curl -d '{\"a\":1}' https://api.example.com/x", 'high', ['leaves-machine']),
  bash('curl --data-binary', 'curl --data-binary @file https://api.example.com/x', 'high', ['leaves-machine']),
  bash('curl -F', 'curl -F file=@a.png https://api.example.com/x', 'high', ['leaves-machine']),
  bash('curl -T', 'curl -T a.zip https://api.example.com/x', 'high', ['leaves-machine']),
  bash('curl -sSd in a cluster', 'curl -sSd x https://api.example.com/x', 'high', ['leaves-machine']),
  bash('curl GET is fine', 'curl -s https://example.com', 'low', []),
  bash('curl -H does not read the header as a flag', 'curl -H "X-Data: 1" https://example.com', 'low', []),
  bash('wget --post-data', 'wget --post-data=a=1 https://example.com', 'high', ['leaves-machine']),
  bash('scp to a host', 'scp build.tgz me@host.example:/srv', 'high', ['leaves-machine']),
  bash('scp between local paths is fine', 'scp a b', 'low', []),
  bash('rsync to a host', 'rsync -av dist/ host.example:/srv/app', 'high', ['leaves-machine']),
  bash('rsync -n is a dry run', 'rsync -avn dist/ host.example:/srv/app', 'low', []),
  bash('rsync local is fine', 'rsync -av a/ b/', 'low', []),
  bash('ssh with a command', 'ssh host.example systemctl restart app', 'high', ['leaves-machine']),
  bash('ssh with a flag value and a host only is a shell', 'ssh -i key.pem host.example', 'low', []),
  bash('kubectl apply', 'kubectl apply -f deploy.yaml', 'high', ['leaves-machine']),
  bash('kubectl apply --dry-run is low', 'kubectl apply -f deploy.yaml --dry-run=client', 'low', []),
  bash('terraform apply', 'terraform apply', 'high', ['leaves-machine']),
  bash('aws s3 sync to a bucket', 'aws s3 sync dist s3://bucket/app', 'high', ['leaves-machine']),
  bash('aws s3 ls is fine', 'aws s3 ls', 'low', []),

  // ---- privilege and width
  bash('sudo adds privilege', 'sudo apt-get install -y jq', 'high', ['privilege']),
  bash('doas adds privilege', 'doas reboot', 'high', ['privilege']),
  bash('sudo with a user flag is read past', 'sudo -u www ls', 'high', ['privilege']),
  bash('su -c scores the inner command too', "su -c 'rm -rf /srv/x'", 'high', ['irreversible', 'privilege', 'outside-workdir', 'wide-scope']),
  bash('su alone', 'su', 'high', ['privilege']),
  bash('sudo rm -rf of root has the most factors', 'sudo rm -rf /', 'high', ['irreversible', 'privilege', 'outside-workdir', 'wide-scope']),
  bash('chmod 777', 'chmod 777 run.sh', 'high', ['privilege']),
  bash('chmod -R', 'chmod -R 755 .', 'high', ['privilege', 'wide-scope']),
  bash('chown -R', 'chown -R me:me /srv/x', 'high', ['privilege', 'wide-scope']),
  bash('chmod +x is fine', 'chmod +x run.sh', 'low', []),
  bash('xargs rm adds width', 'git ls-files -o | xargs rm -rf', 'high', ['irreversible', 'wide-scope']),

  // ---- secrets in Bash
  bash('cat of .env', 'cat .env', 'medium', ['secrets']),
  bash('cat of .env.example is fine', 'cat .env.example', 'low', []),
  bash('tail of a key', 'tail -n 5 ~/.ssh/id_rsa', 'medium', ['secrets']),
  bash('printenv', 'printenv', 'medium', ['secrets']),
  bash('bare env', 'env', 'medium', ['secrets']),
  bash('env running a command is that command', 'env FOO=1 ls', 'low', []),
  bash('echo of a token variable', 'echo "$GITHUB_TOKEN"', 'medium', ['secrets']),
  bash('echo of a token variable that is single quoted is text', "echo '$GITHUB_TOKEN'", 'low', []),
  bash('echo of another variable is fine', 'echo $HOME', 'low', []),

  // ---- quotes, heredocs and wrappers
  bash('a quoted rm is text', 'echo "rm -rf /"', 'low', []),
  bash('a single quoted rm is text', "echo 'git push --force'", 'low', []),
  bash('a commit message is text', 'git commit -m "remove: rm -rf node_modules, then git push --force"', 'low', []),
  bash('a heredoc body is text', "cat <<'EOF' > notes.md\nrm -rf /\ngit push --force\nEOF", 'low', []),
  bash('a commit message heredoc is text', 'git commit -m "$(cat <<\'EOF\'\nsudo rm -rf /\nEOF\n)"', 'low', []),
  bash('a command after a heredoc still counts', "cat <<EOF > a\nhi\nEOF\ngit push --force", 'high', ['history-rewrite', 'leaves-machine']),
  bash('a here-string is not a heredoc', 'grep x <<< "rm -rf /" && git reset --hard', 'high', ['irreversible']),
  bash('segments split on &&', 'ls && git reset --hard', 'high', ['irreversible']),
  bash('segments split on ||', 'false || git push -f', 'high', ['history-rewrite', 'leaves-machine']),
  bash('segments split on ;', 'ls; rm -rf src', 'high', ['irreversible', 'wide-scope']),
  bash('segments split on pipes', 'echo y | git clean -fd', 'high', ['irreversible']),
  bash('segments split on newlines', 'ls\ngit stash clear', 'high', ['irreversible']),
  bash('a command substitution is scored', 'echo $(git reset --hard)', 'high', ['irreversible']),
  bash('a redirect to /dev/null does not split', 'ls 2>&1 > /dev/null', 'low', []),
  bash('a variable prefix is stripped', 'CI=1 git push --force', 'high', ['history-rewrite', 'leaves-machine']),
  bash('timeout is stripped', 'timeout 30 git reset --hard', 'high', ['irreversible']),
  bash('time and nice are stripped', 'time nice -n 5 git clean -fd', 'high', ['irreversible']),
  bash('env prefix is stripped', 'env A=1 B=2 git stash clear', 'high', ['irreversible']),
  bash('a comment is ignored', 'ls # rm -rf /', 'low', []),
  bash('an empty command is low', '', 'low', []),

  // ---- cd
  bash('cd to an absolute directory makes a relative rm outside', 'cd /etc && rm hosts', 'high', ['irreversible', 'outside-workdir']),
  bash('cd to an unknown variable leaves paths unknown', 'cd $DIR && rm hosts', 'low', []),
  bash('cd into a subdirectory stays inside', 'cd src && rm a.ts', 'low', []),
  bash('cd out with .. is outside', 'cd .. && rm -rf x', 'high', ['irreversible', 'outside-workdir', 'wide-scope']),
  bash('cd into a root is inside', 'cd /home/x/worktrees/t1 && rm a.ts', 'low', []),

  // ---- outside the directory, roots and unknown directories
  bash('without a known directory nothing is outside', 'rm /etc/hosts', 'low', [], { cwd: null }),
  bash('a Windows path is outside', 'rm "C:\\Users\\x\\a.txt"', 'high', ['irreversible', 'outside-workdir']),
  bash('a path in a worktree root is inside', 'rm /home/x/worktrees/t1/a.ts', 'low', []),
  bash('a sibling that shares a prefix is outside', 'rm /home/x/p2/a.ts', 'high', ['irreversible', 'outside-workdir']),

  // ---- edit tools
  file('Write outside the directory is high', 'Write', '/etc/hosts', 'high', ['outside-workdir']),
  file('Edit of a file inside is low', 'Edit', '/home/x/p/src/a.ts', 'low', []),
  file('Edit of a relative file is low', 'Edit', 'src/a.ts', 'low', []),
  file('Write in a worktree root is low', 'Write', '/home/x/worktrees/t1/src/a.ts', 'low', []),
  file('Write that climbs out of the directory is high', 'Write', '../other/a.ts', 'high', ['outside-workdir']),
  file('Write to a home path is high', 'Write', '~/.bashrc', 'high', ['outside-workdir']),
  file('Write with no known directory is low', 'Write', '/etc/hosts', 'low', [], { cwd: null }),
  file('MultiEdit outside is high', 'MultiEdit', '/usr/local/bin/x', 'high', ['outside-workdir']),
  file('NotebookEdit outside is high', 'NotebookEdit', '/opt/n.ipynb', 'high', ['outside-workdir']),
  file('CI workflow is medium', 'Write', '.github/workflows/ci.yml', 'medium', ['sensitive-path']),
  file('a workflow by absolute path is medium', 'Edit', '/home/x/p/.github/workflows/ci.yml', 'medium', ['sensitive-path']),
  file('other .github files are low', 'Write', '.github/CODEOWNERS', 'low', []),
  file('.gitlab-ci.yml is medium', 'Write', '.gitlab-ci.yml', 'medium', ['sensitive-path']),
  file('Jenkinsfile is medium', 'Write', 'Jenkinsfile', 'medium', ['sensitive-path']),
  file('.circleci is medium', 'Write', '.circleci/config.yml', 'medium', ['sensitive-path']),
  file('.husky is medium', 'Write', '.husky/pre-commit', 'medium', ['sensitive-path']),
  file('git hooks are medium', 'Write', '.git/hooks/pre-push', 'medium', ['sensitive-path']),
  file('.gitignore is low', 'Write', '.gitignore', 'low', []),
  file('Claude settings are medium', 'Edit', '.claude/settings.json', 'medium', ['sensitive-path']),
  file('Claude local settings are medium', 'Edit', '.claude/settings.local.json', 'medium', ['sensitive-path']),
  file('other Claude files are low', 'Write', '.claude/agents/dev.md', 'low', []),
  file('.mcp.json is medium', 'Write', '.mcp.json', 'medium', ['sensitive-path']),
  file('.env is medium', 'Write', '.env', 'medium', ['sensitive-path']),
  file('.env.local is medium', 'Write', 'apps/web/.env.local', 'medium', ['sensitive-path']),
  file('.env.example is low', 'Write', '.env.example', 'low', []),
  file('.env.sample is low', 'Write', '.env.sample', 'low', []),
  file('.env.template is low', 'Write', '.env.template', 'low', []),
  file('a pem key is medium', 'Write', 'certs/server.pem', 'medium', ['sensitive-path']),
  file('id_rsa is medium', 'Write', 'keys/id_rsa.pub', 'medium', ['sensitive-path']),
  file('id_ed25519 is medium', 'Write', 'keys/id_ed25519', 'medium', ['sensitive-path']),
  file('.npmrc is medium', 'Write', '.npmrc', 'medium', ['sensitive-path']),
  file('.netrc is medium', 'Write', '.netrc', 'medium', ['sensitive-path']),
  file('CLAUDE.md is low', 'Write', 'CLAUDE.md', 'low', []),
  file('an outside sensitive file has both factors and is high', 'Write', '/home/x/.ssh/config', 'high', ['outside-workdir', 'sensitive-path']),

  // ---- reads
  file('Read of .env is medium secrets', 'Read', '.env', 'medium', ['secrets']),
  file('Read of .env.production is medium', 'Read', '/home/x/p/.env.production', 'medium', ['secrets']),
  file('Read of .env.example is low', 'Read', '.env.example', 'low', []),
  file('Read of a key is medium', 'Read', '/home/x/.ssh/id_ed25519', 'medium', ['secrets']),
  file('Read of source is low', 'Read', 'src/a.ts', 'low', []),
  file('Read of CI config is low', 'Read', '.github/workflows/ci.yml', 'low', []),
  { name: 'Grep with a secret glob is medium', tool: 'Grep', input: { pattern: 'password', glob: '**/.env*' }, level: 'medium', factors: ['secrets'] },
  { name: 'Grep for the word env is low', tool: 'Grep', input: { pattern: '.env', path: 'src' }, level: 'low', factors: [] },
  { name: 'Glob of secret files is medium', tool: 'Glob', input: { pattern: '**/*.pem' }, level: 'medium', factors: ['secrets'] },
  { name: 'Glob of sources is low', tool: 'Glob', input: { pattern: 'src/**/*.ts' }, level: 'low', factors: [] },

  // ---- MCP tools
  { name: 'MCP delete is medium irreversible', tool: 'mcp__github__delete_repo', input: {}, level: 'medium', factors: ['irreversible'] },
  { name: 'MCP create leaves the machine at medium', tool: 'mcp__github__create_issue', input: {}, level: 'medium', factors: ['leaves-machine'] },
  { name: 'MCP merge is medium', tool: 'mcp__github__merge_pull_request', input: {}, level: 'medium', factors: ['leaves-machine'] },
  { name: 'MCP camelCase verbs count', tool: 'mcp__linear__deleteIssue', input: {}, level: 'medium', factors: ['irreversible'] },
  { name: 'MCP list is low', tool: 'mcp__github__list_issues', input: {}, level: 'low', factors: [] },
  { name: 'MCP get is low', tool: 'mcp__github__get_file_contents', input: {}, level: 'low', factors: [] },
  { name: 'MCP search is low', tool: 'mcp__docs__search', input: {}, level: 'low', factors: [] },
  { name: 'an unknown MCP verb is low', tool: 'mcp__x__frobnicate', input: {}, level: 'low', factors: [] },
  { name: 'the first verb decides', tool: 'mcp__x__list_then_delete', input: {}, level: 'low', factors: [] },
  { name: 'a server with underscores is read right', tool: 'mcp__my_server__drop_table', input: {}, level: 'medium', factors: ['irreversible'] },
  { name: 'Claudio’s own server is scored by the same verbs', tool: 'mcp__claudio__create_work_item', input: {}, level: 'medium', factors: ['leaves-machine'] },

  // ---- tools that are always low
  ...['Agent', 'Task', 'Workflow', 'TodoWrite', 'Skill', 'WebFetch', 'WebSearch', 'ExitPlanMode', 'SomeNewTool'].map((tool): Case => ({ name: `${tool} is low`, tool, input: { command: 'rm -rf /', file_path: '/etc/hosts' }, level: 'low', factors: [] })),
  { name: 'a Bash call with no command is low', tool: 'Bash', input: {}, level: 'low', factors: [] },
  { name: 'a Bash command that is not a string is low', tool: 'Bash', input: { command: 42 }, level: 'low', factors: [] },
];

for (const c of CASES) {
  test(c.name, () => {
    const risk = toolRisk({ name: c.tool ?? 'Bash', input: c.input }, c.ctx ?? CTX);
    assert.equal(risk.level, c.level, `${risk.reason} (score ${String(risk.score)})`);
    if (c.factors) assert.deepEqual(risk.factors, c.factors);
  });
}

test('the table is at least 60 cases', () => {
  assert.ok(CASES.length >= 60, String(CASES.length));
});

test('the acceptance cases', () => {
  assert.equal(toolRisk({ name: 'Bash', input: { command: 'rm -rf node_modules' } }, CTX).level, 'low');
  const force = toolRisk({ name: 'Bash', input: { command: 'git push --force origin main' } }, CTX);
  assert.equal(force.level, 'high');
  assert.ok(force.factors.includes('history-rewrite') && force.factors.includes('leaves-machine'));
  assert.equal(toolRisk({ name: 'Bash', input: { command: 'echo "rm -rf /"' } }, CTX).level, 'low');
  const hosts = toolRisk({ name: 'Write', input: { file_path: '/etc/hosts' } }, { cwd: '/home/x/p' });
  assert.equal(hosts.level, 'high');
  assert.deepEqual(hosts.factors, ['outside-workdir']);
  assert.equal(toolRisk({ name: 'Write', input: { file_path: '.github/workflows/ci.yml' } }, CTX).level, 'medium');
  assert.equal(toolRisk({ name: 'mcp__github__delete_repo', input: {} }, CTX).level, 'medium');
  const env = toolRisk({ name: 'Read', input: { file_path: '.env' } }, CTX);
  assert.equal(env.level, 'medium');
  assert.deepEqual(env.factors, ['secrets']);
});

test('score is the heaviest weight plus ten per extra factor, capped at 100', () => {
  const one = toolRisk({ name: 'Bash', input: { command: 'git reset --hard' } }, CTX);
  assert.equal(one.score, 70);
  const two = toolRisk({ name: 'Bash', input: { command: 'git push --force' } }, CTX);
  assert.equal(two.score, 80);
  const many = toolRisk({ name: 'Bash', input: { command: 'sudo rm -rf /' } }, CTX);
  assert.equal(many.score, 100);
  assert.equal(toolRisk({ name: 'Read', input: { file_path: '.env' } }, CTX).score, 40);
  assert.equal(toolRisk({ name: 'Write', input: { file_path: '.github/workflows/ci.yml' } }, CTX).score, 35);
});

test('levels start at 30 and 60', () => {
  assert.equal(toolRisk({ name: 'Write', input: { file_path: '.husky/x' } }, CTX).level, 'medium');
  assert.equal(toolRisk({ name: 'Bash', input: { command: 'git push' } }, CTX).score, 60);
  assert.equal(toolRisk({ name: 'Bash', input: { command: 'git push' } }, CTX).level, 'high');
  assert.equal(toolRisk({ name: 'Bash', input: { command: 'ls' } }, CTX).score, 0);
});

test('an MCP call never passes medium, whatever its factor weighs', () => {
  const risk = toolRisk({ name: 'mcp__x__delete_everything', input: {} }, CTX);
  assert.equal(risk.level, 'medium');
  assert.ok(risk.score < 60);
});

test('wide-scope alone is not a risk', () => {
  assert.equal(toolRisk({ name: 'Bash', input: { command: 'ls -R *' } }, CTX).level, 'low');
  assert.deepEqual(toolRisk({ name: 'Bash', input: { command: 'ls -R *' } }, CTX).factors, []);
});

test('the first factor is the heaviest, and a tie keeps the declared order', () => {
  const risk = toolRisk({ name: 'Bash', input: { command: 'git push --force' } }, CTX);
  assert.equal(risk.factors[0], 'history-rewrite');
  assert.equal(risk.reasonCode, 'risk.history-rewrite');
});

test('the reason names the part of the input that fired, in one clipped English line', () => {
  const risk = toolRisk({ name: 'Bash', input: { command: `ls && git reset --hard ${'x'.repeat(500)}` } }, CTX);
  assert.match(risk.reason, /git reset --hard/);
  assert.ok(!risk.reason.includes('ls &&'));
  assert.ok(!risk.reason.includes('\n'));
  assert.ok(risk.reason.length <= 300);
  assert.equal(risk.params?.command && String(risk.params.command).length <= 200, true);
});

test('a call that fired nothing says so', () => {
  const risk = toolRisk({ name: 'Bash', input: { command: 'ls' } }, CTX);
  assert.equal(risk.reasonCode, 'risk.none');
  assert.deepEqual(risk.params, { command: 'ls' });
});

test('params carry the path of a file call and the name of an MCP call', () => {
  assert.deepEqual(toolRisk({ name: 'Write', input: { file_path: '/etc/hosts' } }, CTX).params, { path: '/etc/hosts' });
  assert.deepEqual(toolRisk({ name: 'mcp__a__b', input: {} }, CTX).params, { tool: 'mcp__a__b' });
});

test('only the first 64 KiB of an input is scored', () => {
  const padding = 'a'.repeat(70 * 1024);
  assert.equal(toolRisk({ name: 'Bash', input: { command: `echo ${padding}; rm -rf src` } }, CTX).level, 'low');
  assert.equal(toolRisk({ name: 'Bash', input: { command: `rm -rf src; echo ${padding}` } }, CTX).level, 'high');
  assert.equal(toolRisk({ name: 'Write', input: { file_path: `${padding}/.env` } }, CTX).level, 'low');
});

test('a very long unterminated quote or heredoc does not hang', () => {
  const started = Date.now();
  toolRisk({ name: 'Bash', input: { command: `echo "${'x'.repeat(60 * 1024)}` } }, CTX);
  toolRisk({ name: 'Bash', input: { command: `cat <<EOF\n${'line\n'.repeat(10 * 1024)}` } }, CTX);
  assert.ok(Date.now() - started < 2000);
});

test('isSecretPath tells credentials from their examples', () => {
  for (const path of ['.env', 'a/.env.local', '.ssh/config', 'k.pem', 'k.p12', 'id_rsa', '.aws/credentials', '.netrc', '.pypirc']) assert.equal(isSecretPath(path), true, path);
  for (const path of ['.env.example', 'envelope.ts', 'src/key.ts', '.envrc', 'README.md']) assert.equal(isSecretPath(path), false, path);
});
