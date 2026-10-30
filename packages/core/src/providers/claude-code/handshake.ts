import type { ProviderCapability } from '@claudio/shared';
import { satisfiesRange } from '../detector.ts';
import type { CapabilityConfirmation, SessionInit } from '../driver.ts';
import { claudeCodeManifest } from './manifest.ts';

/**
 * What `system/init` of a session Claudio was starting anyway says about the installed CLI. A
 * handshake of its own would spend tokens, so this is the only one. The capabilities nobody can
 * read off the init (interrupt, fork, effort...) stay declared until a run exercises them.
 *
 * An empty tool list is an init we could not read, not a CLI that has no tools, so it contradicts
 * nothing.
 */
export function confirmClaudeInit(init: SessionInit): CapabilityConfirmation {
  const declared = claudeCodeManifest.capabilities;
  const range = claudeCodeManifest.versions.range;
  // A version outside what the driver is tested against confirms nothing: the detector reports it
  if (init.version && range && satisfiesRange(init.version, range) !== 'in') {
    return { version: init.version, confirmed: [], missing: [] };
  }

  const confirmed: ProviderCapability[] = [];
  const missing: ProviderCapability[] = [];
  const check = (capability: ProviderCapability, present: boolean, contradicts: boolean): void => {
    if (!declared.includes(capability)) return;
    if (present) confirmed.push(capability);
    else if (contradicts) missing.push(capability);
  };

  const hasTools = init.tools.length > 0;
  check('subagents', init.tools.includes('Task') || init.tools.includes('Agent'), hasTools);
  // 2.1.287 leaves `Workflow` out of the init of sessions that do have every other tool, so its
  // absence is not evidence the CLI lacks it: like a server, it only confirms
  check('workflowTool', init.tools.includes('Workflow'), false);
  // No servers configured is the usual case, so only a server confirms; it never contradicts
  check('mcp', init.mcpServers.length > 0, false);
  check('structuredOutput', init.structuredOutput, false);
  return { version: init.version, confirmed, missing };
}

/**
 * Whether a session reads back each message it takes. Claudio launches every process with
 * `--replay-user-messages` (args.ts), which every CLI in the driver's range honours (read back on
 * 2.1.288 and 2.1.312, docs/chat-delivery.md): the version the init reports decides, not whether the
 * first turn happened to read anything back. A version the init leaves out, or one outside the range,
 * says nothing.
 */
export function claudeReadsBack(version: string | null): boolean | null {
  const range = claudeCodeManifest.versions.range;
  if (!version || !range) return null;
  return satisfiesRange(version, range) === 'in' ? true : null;
}

/** The flags the guards load their hooks with, and the capability each one proves */
const HELP_FLAGS: Array<[ProviderCapability, RegExp]> = [
  ['settingsFlag', /^\s+--settings\s/m],
  ['hookEvents', /^\s+--include-hook-events\b/m],
];

/**
 * What `claude --help` says about the flags the guards need. A help that lists neither flag is one we
 * could not read (or a CLI too old for the driver), so only a help that lists some of the options
 * contradicts a declared capability.
 */
export function confirmClaudeHelp(help: string, version: string | null = null): CapabilityConfirmation {
  const declared = claudeCodeManifest.capabilities;
  const confirmed: ProviderCapability[] = [];
  const missing: ProviderCapability[] = [];
  const readable = /^\s+--(?:print|model|output-format)\b/m.test(help);
  for (const [capability, pattern] of HELP_FLAGS) {
    if (!declared.includes(capability)) continue;
    if (pattern.test(help)) confirmed.push(capability);
    else if (readable) missing.push(capability);
  }
  return { version, confirmed, missing };
}
