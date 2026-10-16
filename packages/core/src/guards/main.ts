/*
 * The guard program: the PreToolUse and SessionStart hook Claudio hands the CLI. It reads one hook
 * input on stdin, checks the rules file against the hash on its own command line, and answers with an
 * exit code and a stderr line only (docs/plans/guards.md, "The guard program"). Exit 2 is the one
 * code the CLI treats as a block, so every failure path ends there. Only `node:` imports and the pure
 * modules next to it; erasable syntax only, so it runs from source or from a bundle.
 */
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { decide } from './decide.ts';
import { DEFAULT_LIMITS, type Decision, type GuardRuleId, type GuardRulesFile, parseHookInput } from './input.ts';

const MARK = 'claudio-guard/1';

interface Args {
  rules: string | null;
  sha256: string | null;
  event: string | null;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { rules: null, sha256: null, event: null };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (value === undefined) continue;
    if (argv[i] === '--rules') args.rules = value;
    else if (argv[i] === '--sha256') args.sha256 = value;
    else if (argv[i] === '--event') args.event = value;
    else continue;
    i += 1;
  }
  return args;
}

/** Writes synchronously and ends the process: nothing may be left buffered when the exit comes */
function finish(code: 0 | 2, lines: string[]): never {
  try {
    writeSync(2, `${lines.join('\n')}\n`);
  } catch {
    // stderr gone: the exit code still blocks
  }
  process.exit(code);
}

/** One token for a marker line: ids from stdin never carry spaces or newlines into it */
const token = (value: string | undefined): string => (value && /^[\w.:-]{1,128}$/.test(value) ? value : '-');

function blockLines(rule: GuardRuleId, reason: string, matcher: string, id: string | undefined): string[] {
  return [`Claudio guard blocked this (${rule}): ${reason.replace(/\s+/g, ' ').slice(0, 400)}`, `${MARK} block ${token(id)} ${rule} ${matcher}`];
}

const failClosed = (matcher: string, reason: string, id?: string): never => finish(2, blockLines('integrity', reason, matcher, id));

/** The error's class only: its message may hold part of a command or a secret */
const errorClass = (error: unknown): string => (error instanceof Error && /^\w{1,40}$/.test(error.name) ? error.name : 'Error');

function guardError(error: unknown, id?: string): never {
  return failClosed('integrity.guard-error', `guard-error: ${errorClass(error)}`, id);
}

let toolUseId: string | undefined;
process.on('uncaughtException', (error) => guardError(error, toolUseId));
process.on('unhandledRejection', (error) => guardError(error, toolUseId));

let timer: NodeJS.Timeout | null = null;
function setDeadline(ms: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => failClosed('integrity.deadline', 'deadline', toolUseId), ms);
}

function isRulesFile(value: unknown): value is GuardRulesFile {
  if (typeof value !== 'object' || value === null) return false;
  const file = value as Record<string, unknown>;
  const limits = file.limits;
  return (
    file.version === 1 &&
    (file.mode === 'enforce' || file.mode === 'observe') &&
    Array.isArray(file.rules) &&
    Array.isArray(file.roots) &&
    Array.isArray(file.knownSecretSha256) &&
    typeof limits === 'object' &&
    limits !== null &&
    Object.values(limits).every((n) => typeof n === 'number' && n > 0)
  );
}

/** The rules file when its hash matches the one on the command line; null otherwise, which blocks every call */
function loadRules(args: Args): { rules: GuardRulesFile; sha: string } | null {
  if (!args.rules || !args.sha256) return null;
  try {
    const bytes = readFileSync(args.rules);
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (sha !== args.sha256.toLowerCase()) return null;
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRulesFile(parsed)) return null;
    parsed.limits = { ...DEFAULT_LIMITS, ...parsed.limits };
    return { rules: parsed, sha };
  } catch {
    return null;
  }
}

/** All of stdin, or null as soon as it holds more than `max` bytes */
async function readStdin(max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const part = chunk as Buffer;
    total += part.length;
    if (total > max) return null;
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

/** Stable text of a value: object keys sorted, so the same input always hashes the same */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const map = value as Record<string, unknown>;
    return `{${Object.keys(map)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(map[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A person's one-use "Allow once" for this run, rule and tool input. The file is named by the three
 * and holds an expiry; taking it is unlinking it, so two calls cannot both use it. `integrity` is
 * never allowed.
 */
function takeAllowance(rules: GuardRulesFile, sessionId: string | undefined, rule: GuardRuleId, toolName: string, toolInput: unknown): boolean {
  if (!rules.allowDir || rule === 'integrity' || !sessionId || !/^[\w-]{1,128}$/.test(sessionId)) return false;
  const inputHash = createHash('sha256').update(stable({ tool: toolName, input: toolInput })).digest('hex').slice(0, 32);
  const file = join(rules.allowDir, `${sessionId}.${rule}.${inputHash}.json`);
  try {
    const body = JSON.parse(readFileSync(file, 'utf8')) as { expiresAt?: unknown };
    unlinkSync(file);
    return typeof body.expiresAt === 'number' && body.expiresAt > Date.now();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  setDeadline(DEFAULT_LIMITS.deadlineMs);
  const loaded = loadRules(args);
  if (!loaded) return failClosed('integrity.rules-unavailable', 'rules-unavailable');
  const { rules, sha } = loaded;
  setDeadline(rules.limits.deadlineMs);

  const bytes = await readStdin(rules.limits.maxInputBytes);
  if (!bytes) return failClosed('integrity.input-too-large', 'input-too-large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    parsed = null;
  }

  if (args.event === 'session-start') {
    const id = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).session_id : undefined;
    return finish(0, [`${MARK} armed ${token(typeof id === 'string' ? id : undefined)} ${sha.slice(0, 16)} ${rules.rules.join(',')}`]);
  }
  if (args.event !== 'pre-tool-use') return failClosed('integrity.bad-input', 'bad-input');

  const input = parseHookInput(parsed);
  if (!input) return failClosed('integrity.bad-input', 'bad-input');
  toolUseId = input.tool_use_id;
  const decision: Decision = decide(rules, input);
  const id = token(input.tool_use_id);
  if (decision.verdict === 'pass') return finish(0, [`${MARK} pass ${id}`]);

  const rule = decision.rule ?? 'integrity';
  const matcher = decision.matcher ?? `${rule}.unknown`;
  if (takeAllowance(rules, input.session_id, rule, input.tool_name, input.tool_input)) return finish(0, [`${MARK} allowed-once ${id} ${rule} ${matcher}`]);
  if (rules.mode === 'observe') return finish(0, [`${MARK} observe ${id} ${rule} ${matcher}`]);
  return finish(2, blockLines(rule, decision.reason ?? 'blocked', matcher, input.tool_use_id));
}

main().catch((error: unknown) => guardError(error, toolUseId));
