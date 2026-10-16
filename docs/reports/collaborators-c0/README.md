# Collaborators, stage C0: the iroh spike

The code and the raw results of stage C0 of [plans/collaborators.md](../../plans/collaborators.md),
run on 2026-10-16. The findings are written up in the plan's **§7.2 C0 facts**; this folder keeps what
they were measured with, so they can be rerun.

- `spike/`: the throwaway Node scripts (`serve.mjs`, `client.mjs`, `tput.mjs`, `relay-test.mjs`,
  `buf-test.mjs`, `load-check.mjs`, `w-conn.mjs`, `w-test.mjs`) and their `package.json`. Not part of
  the workspace: `cd spike && npm install`, then see `spike/README.md`.
- `results/`: the raw reports of the relay-only and id-only runs and the two-NAT run log
  (`nat-run.log`). Endpoint ids, tickets and IP addresses are replaced by `<endpoint-id-N>`,
  `<ticket>`, `<ip>` and `<ipv6>`; nothing else was changed.

Not kept: the tickets file and the server logs, which held only tickets.
