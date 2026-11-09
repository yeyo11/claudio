import { COLLAB_TOOLS } from './collab-tools.ts';
import type { ClaudioMcpToolName } from './names.ts';
import { TOOLS, type Tool } from './tools.ts';
import { WRITE_TOOLS } from './write-tools.ts';

/**
 * What each tool of Claudio's server does, in one sentence: the first of its description. The
 * assistant's guide is built from these, so it promises what a tool does and nothing a tool does not
 * (report §4.10): a capability is added to the guide by adding the tool.
 */
export interface Capability {
  tool: ClaudioMcpToolName;
  /** `read` runs without asking; `write` asks the person each time; `collab` reads a teammate's copy */
  kind: 'read' | 'write' | 'collab';
  says: string;
}

/** The description up to its first full stop followed by a space, or all of it */
export function firstSentence(description: string): string {
  const end = description.search(/\.(\s|$)/);
  return end < 0 ? description : description.slice(0, end + 1);
}

const of = (tools: readonly Tool[], kind: Capability['kind']): Capability[] => tools.map((tool) => ({ tool: tool.name, kind, says: firstSentence(tool.description) }));

/**
 * `OWNER_TOOLS` are left out: the API answers them only for a chat the person switched Claudio's
 * server on for (D12 of docs/plans/claudio-servers.md), never for the assistant, so its guide does not
 * promise them. Such a chat reads them from the server's own list, descriptions included.
 */
export const CAPABILITIES: readonly Capability[] = [...of(TOOLS, 'read'), ...of(WRITE_TOOLS, 'write'), ...of(COLLAB_TOOLS, 'collab')];
