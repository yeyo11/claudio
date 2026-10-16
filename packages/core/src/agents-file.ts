import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFrontmatter, readFrontmatterList } from './team.ts';

/** One agent as `--agents` reads it */
export interface AgentDefinition {
  description: string;
  prompt: string;
  model?: string | null;
  tools?: string[];
  disallowedTools?: string[];
}

/** Written to `dir` (0700) named by its content, so the same definition is one file */
async function writeAgentsFile(dir: string, name: string, agent: AgentDefinition): Promise<string> {
  const { description, prompt, model, tools, disallowedTools } = agent;
  const definition = {
    [name]: {
      description,
      prompt,
      ...(model ? { model } : {}),
      ...(tools?.length ? { tools } : {}),
      ...(disallowedTools?.length ? { disallowedTools } : {}),
    },
  };
  const body = `${JSON.stringify(definition, null, 2)}\n`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${createHash('sha256').update(body).digest('hex').slice(0, 16)}.json`);
  await writeFile(file, body, { mode: 0o600 });
  return file;
}

/**
 * The file `--agents` takes for one agent, under `<dataDir>/flow-agents/`. Named by its content, so
 * the same definition is one file; the directory is one place so the check that a chat may read
 * only its own agents file needs no second root.
 */
export async function agentsFileFor(dataDir: string, name: string, agent: AgentDefinition): Promise<string> {
  return writeAgentsFile(join(dataDir, 'flow-agents'), name, agent);
}

/**
 * The definition a session is given for `--agents`, built from an agent file's text. It carries what
 * the file says of the agent (its tools, the tools it is denied, as a list in either YAML form) and
 * the model the caller sets, so a file's own `model` never runs a role on a model its screen does not
 * show. Written to `dir` (0700) named by its content, so the same definition is one file.
 */
export async function agentsDefinitionFile(content: string, agent: string, model: string | null | undefined, dir: string): Promise<string> {
  const fields = readFrontmatter(content);
  const prompt = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
  return writeAgentsFile(dir, agent, {
    description: fields.description || agent,
    prompt: prompt || fields.description || agent,
    model,
    tools: readFrontmatterList(content, 'tools') ?? undefined,
    disallowedTools: readFrontmatterList(content, 'disallowedTools') ?? undefined,
  });
}
