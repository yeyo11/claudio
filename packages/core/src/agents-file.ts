import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readFrontmatter, readFrontmatterList } from './team.ts';

/**
 * The definition a session is given for `--agents`, built from an agent file's text. It carries what
 * the file says of the agent (its tools, the tools it is denied, as a list in either YAML form) and
 * the model the caller sets, so a file's own `model` never runs a role on a model its screen does not
 * show. Written to `dir` (0700) named by its content, so the same definition is one file.
 */
export async function agentsDefinitionFile(content: string, agent: string, model: string | null | undefined, dir: string): Promise<string> {
  const fields = readFrontmatter(content);
  const prompt = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim();
  const tools = readFrontmatterList(content, 'tools');
  const disallowedTools = readFrontmatterList(content, 'disallowedTools');
  const definition = {
    [agent]: {
      description: fields.description || agent,
      prompt: prompt || fields.description || agent,
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
