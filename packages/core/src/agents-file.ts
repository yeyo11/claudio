import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One agent as `--agents` reads it */
export interface AgentDefinition {
  description: string;
  prompt: string;
  model: string;
  tools?: string[];
  disallowedTools?: string[];
}

/**
 * The file `--agents` takes for one agent, under `<dataDir>/flow-agents/`. Named by its content, so
 * the same definition is one file; the directory is one place so the check that a chat may read
 * only its own agents file needs no second root.
 */
export async function agentsFileFor(dataDir: string, name: string, agent: AgentDefinition): Promise<string> {
  const { description, prompt, model, tools, disallowedTools } = agent;
  const definition = {
    [name]: {
      description,
      prompt,
      model,
      ...(tools?.length ? { tools } : {}),
      ...(disallowedTools?.length ? { disallowedTools } : {}),
    },
  };
  const body = `${JSON.stringify(definition, null, 2)}\n`;
  const dir = join(dataDir, 'flow-agents');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${createHash('sha256').update(body).digest('hex').slice(0, 16)}.json`);
  await writeFile(file, body, { mode: 0o600 });
  return file;
}
