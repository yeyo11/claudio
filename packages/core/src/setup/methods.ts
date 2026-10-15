import type { SetupTool, SetupToolMethods } from '@agentry/shared';

/**
 * How each tool signs in, and only through what its vendor ships for programs (the one rule). The
 * table is docs/plans/in-app-setup.md's, "What each vendor allows"; docs/setup.md keeps it with its
 * sources. A device-code row runs the vendor's documented command with no terminal, as gh, glab and
 * Tailscale do.
 */
export interface ToolLogin {
  methods: SetupToolMethods;
  /**
   * The CLI's own key login, reading the key on stdin, or for a `file` tool the command the
   * `--auth-key=file:<path>` argument is added to; null for a tool whose key Agentry keeps
   */
  keyCommand: ((host: string) => string[]) | null;
  /** The documented device-code sign-in; null where there is none */
  deviceCommand: ((host: string) => string[]) | null;
  /** The documented sign-out command; null where the vault alone holds the credential or there is none */
  signOutCommand: ((host: string) => string[]) | null;
}

const row = (tool: SetupTool, methods: Partial<Omit<SetupToolMethods, 'tool'>>): SetupToolMethods => ({
  tool,
  key: 'env',
  variables: [],
  exclusive: false,
  device: false,
  deviceVia: null,
  needsHost: false,
  defaultHost: null,
  signOut: true,
  signOutKeyOnly: false,
  ...methods,
});

export const TOOL_LOGINS: Readonly<Record<SetupTool, ToolLogin>> = {
  // `claude setup-token` makes the OAuth token on the person's own machine; `auth login` needs a
  // terminal, so there is no device row. Either variable signs the CLI in, never both at once.
  'claude-code': {
    methods: row('claude-code', { key: 'env', variables: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'], exclusive: true }),
    keyCommand: null,
    deviceCommand: null,
    signOutCommand: () => ['auth', 'logout'],
  },
  gh: {
    methods: row('gh', { key: 'stdin', device: true, needsHost: true, defaultHost: 'github.com' }),
    keyCommand: (host) => ['auth', 'login', '--with-token', '--hostname', host],
    deviceCommand: (host) => ['auth', 'login', '--web', '--hostname', host],
    signOutCommand: (host) => ['auth', 'logout', '--hostname', host],
  },
  // `--device` needs GitLab 17.9 or later on the host
  glab: {
    methods: row('glab', { key: 'stdin', device: true, needsHost: true, defaultHost: 'gitlab.com' }),
    keyCommand: (host) => ['auth', 'login', '--hostname', host, '--stdin'],
    deviceCommand: (host) => ['auth', 'login', '--device', '--hostname', host],
    signOutCommand: (host) => ['auth', 'logout', '--hostname', host],
  },
  // `youtrack-app` reads the instance and a permanent token from its environment (recorded)
  youtrack: {
    methods: row('youtrack', { key: 'env', variables: ['YOUTRACK_TOKEN'], needsHost: true }),
    keyCommand: null,
    deviceCommand: null,
    signOutCommand: null,
  },
  // Only the tailscaled the image runs for Agentry (`CoreConfig.tailscaleManaged`); the argument is
  // the node's name. `up` with no terminal prints a login URL and waits until the node is Running
  // (recorded, fixtures/logins/tailscale-up.*). `--reset` because `up` refuses flags that differ
  // from what the daemon kept unless every one is named again, and Agentry is its only user.
  // `--auth-key` takes `file:<path>` (1.102 `up --help`), which keeps the key out of argv; the
  // daemon keeps the node key it gets, so the auth key is used once and never stored (decision 4).
  // `logout` expires the node key and takes the node off the tailnet.
  tailscale: {
    methods: row('tailscale', { key: 'file', device: true }),
    keyCommand: (name) => ['up', '--reset', `--hostname=${name}`],
    deviceCommand: (name) => ['up', '--reset', `--hostname=${name}`],
    signOutCommand: () => ['logout'],
  },
};

export function setupMethods(): SetupToolMethods[] {
  return Object.values(TOOL_LOGINS).map((login) => ({
    ...login.methods,
    variables: [...login.methods.variables],
  }));
}

/** The variables of a tool that may not be set together; empty for every tool but Claude Code */
export function exclusiveVariables(tool: string): readonly string[] {
  const login = (TOOL_LOGINS as Readonly<Record<string, ToolLogin | undefined>>)[tool];
  return login?.methods.exclusive ? login.methods.variables : [];
}

export function isSetupTool(value: unknown): value is SetupTool {
  return typeof value === 'string' && Object.hasOwn(TOOL_LOGINS, value);
}
