import type { ServerProfile } from '@claudio/shared';

interface SubsystemRule {
  full: boolean;
  headless: boolean;
  /** Why the headless profile keeps or drops it (docs/plans/headless-image.md, "Inventory") */
  why: string;
}

/**
 * What the core and the server start on their own, and in which profile. A headless Claudio serves
 * one project's one-shot model turns (D1), so whatever only feeds a screen, a code host, a team's
 * work or an update it never serves stays off there: fewer timers and processes, and nothing that
 * reads a chat's transcript besides the chat's caller. The one table both the gate and the plan's
 * inventory read.
 */
export const SUBSYSTEMS = {
  sampler: { full: true, headless: false, why: "Samples the machine for the Machine page's charts (`/api/system/history`), which headless does not serve" },
  spend: { full: true, headless: true, why: 'The daily spend cap a headless start requires (D4)' },
  decisionPruning: { full: true, headless: true, why: "Trims the decision history's old rows; a timer and nothing else" },
  decisionResolvers: { full: true, headless: false, why: 'Resolves the outcomes of decisions the flow, orchestrations and reviews asked; none run in headless' },
  healthMonitor: { full: true, headless: true, why: "Reads live chats' health signals, which the chat views carry" },
  supervisor: { full: true, headless: false, why: 'Hints a chat with text its caller did not send; a confined API chat runs its caller\'s policy only (D14)' },
  changeWatcher: { full: true, headless: false, why: "Watches orchestrations' working trees for the Changes view; no orchestrations in headless" },
  lessonQueue: { full: true, headless: false, why: "Mines chats' transcripts for lessons with model turns of its own; a headless chat's transcript holds a repository's content and is its caller's alone" },
  lessons: { full: true, headless: false, why: "Keeps the lessons delivered to projects' chats; no projects in headless" },
  pullRequestWatcher: { full: true, headless: false, why: 'Polls code hosts for pull requests; no gh or glab in the image and no code-host routes' },
  schedules: { full: true, headless: false, why: 'Starts scheduled chats and orchestrations; no schedule routes in headless' },
  rotation: { full: true, headless: true, why: 'Moves work between accounts at a usage limit: several accounts and rotation stay (D3)' },
  collaborators: { full: true, headless: false, why: 'The iroh collaborators host; not in the image, and no collaborator routes' },
  terminalStrays: { full: true, headless: false, why: 'Ends shells a previous server left; headless opens no terminals' },
  guardSelfTest: { full: true, headless: true, why: "Checks the guard program before the first launch: the confined API chat's declared-tools rule runs in it (D14.5)" },
  guardSweep: { full: true, headless: true, why: "Removes the guard folder's rules and settings files no live process names, a week after their last use; confined API chats write them too" },
  serverUpdates: { full: true, headless: false, why: 'In-app server updates: the image is the version (D6)' },
  accountsWatch: { full: true, headless: true, why: "Reads each account's usage cache and models list, which sign-in, rotation and the model list need" },
  orchestrationRecovery: { full: true, headless: false, why: 'Resumes orchestrations a restart cut off; none in headless' },
  evals: { full: true, headless: false, why: 'Loads the instruction evals; no eval routes in headless' },
  flow: { full: true, headless: false, why: "Resumes the work items' flow runs; no work items in headless" },
  assistant: { full: true, headless: false, why: 'Resumes the Claudio assistant; no assistant in headless' },
  transcriptWarmRead: { full: true, headless: true, why: "Reads every transcript once at start, so the first `GET /api/chats` does not wait for it" },
  chatRetention: { full: false, headless: true, why: 'Deletes chats 30 days after their last activity, rows and transcripts, since both hold what they read of a repository (D15)' },
  cliVersionWatch: { full: true, headless: false, why: "Asks the registry for Claude Code's latest version daily; the image pins the CLI and serves no install route" },
  releaseWatch: { full: true, headless: false, why: "Asks GitHub for Claudio's latest release daily; the image is the version (D6)" },
  providersWatch: { full: true, headless: true, why: 'Detects the CLI and its sign-in, which `/api/ready`, `/api/health` and `/api/system` answer from' },
  codeHostsWatch: { full: true, headless: false, why: 'Detects gh and glab; neither is in the image' },
  tunnel: { full: true, headless: false, why: "Claudio's own Tailscale tunnel; the image sets CLAUDIO_TUNNEL=off and the host's proxy serves it" },
} as const satisfies Record<string, SubsystemRule>;

export type Subsystem = keyof typeof SUBSYSTEMS;

/** Whether a profile starts a subsystem */
export function runsIn(profile: ServerProfile, subsystem: Subsystem): boolean {
  return SUBSYSTEMS[subsystem][profile];
}
