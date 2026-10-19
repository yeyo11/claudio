Raw `get_usage` control responses, recorded on Claude Code 2.1.302 with `controlRequest` (no prompt, no turn).

- `get-usage-max.json`: a signed-in Max account.
- `get-usage-refused-oauth-token.json`: `CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-invalid`, empty config dir.
- `get-usage-refused-api-key.json`: `ANTHROPIC_API_KEY=sk-ant-api03-invalid`, empty config dir.
- `get-usage-refused-signed-out.json`: no credential, empty config dir.
- `get-usage-refused-offline.json`: the invalid OAuth token with `HTTPS_PROXY` on a closed port (the CLI waited 18 s, then answered the same).

All four "refused" files answer success with `rate_limits_available: false`: the request cannot tell a refused credential from an unreachable network, so it can confirm a credential but never refuse one.
