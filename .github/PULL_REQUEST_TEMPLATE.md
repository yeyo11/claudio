## What this changes

<!-- The behaviour that is different afterwards, and why it needed to change. -->

## How it was verified

<!-- The commands you ran and what they said. Paste the output for anything that is not obvious. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] `pnpm build`
- [ ] The e2e specs it touches, through Sluice (`sluice run e2e -- <specs>`) or on GitHub (`pnpm e2e:remote <specs>`) (if it touches the UI or a route); the pull request runs the whole suite
- [ ] `pnpm --filter @claudio/api openapi:schemas` (if it touches a shared type)
- [ ] A summary and a tag in `apps/api/src/openapi/routes.ts` and a row in `docs/rest-api.md` (if it adds or changes a route)
- [ ] A document under `docs/` for the feature or decision

## Notes for the reviewer

<!-- Trade-offs you weighed, anything you left out on purpose, anything you are unsure about. -->
