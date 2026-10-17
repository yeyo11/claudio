---
created_at: 2026-10-17T03:00:00Z
updated_at: 2026-10-17T03:00:00Z
tags:
    - plan
    - e2e
    - flaky
    - diagnostics
    - ci
    - harness
---
# A failed e2e wait says why the page is blank

On the CI runners, twice in a row of runs, a spec timed out right after `page.goto(...)` with the page
an empty dark background: the body's colour and nothing else.

- `home.spec.mjs`: "timed out waiting for: Home with All projects", after
  `page.goto('/?project=all')` (run 38961790693, shard 4, right after `events.spec.mjs`).
- `composer.spec.mjs`: "timed out waiting for: the box after a reload", after
  `page.goto('/chats/<id>')` on the page it was already on (run 38992626011 attempt 1, shard 1,
  right after `collaborators.spec.mjs`). The same page had loaded in about half a second three
  seconds earlier.

It never happened locally, and the report said nothing more than the timeout.

## Why the report was empty

The harness collected the main tab's uncaught exceptions and `console.error` calls, but only
read them after a spec **passed**, to fail it on them. A spec that failed on a timeout or an
assertion threw first, and what the page had logged was dropped unread. Failed requests were never
collected at all: `Network` was only enabled while a spec blocked URLs, and `Log` (where Chrome
reports a resource that failed to load, a refused script or a CSP violation) never was.

## What a failed wait reports now

`page.waitFor` (and with it `click`, `fill`, `focus` and every other wait of the driver) appends a
description of the page to its timeout:

```
timed out waiting for: Home with All projects (at http://127.0.0.1:8809/?project=all)
page: http://127.0.0.1:8809/?project=all, readyState complete, title "Claudio", service worker http://127.0.0.1:8809/sw.js
#root: <div id="root"></div>
console errors:
  …
console log:
  error (network) Failed to load resource: the server responded with a status of 404 … /assets/Home-….js
failed requests:
  404 GET http://127.0.0.1:8809/assets/Home-….js (from the service worker)
still open:
  GET http://127.0.0.1:8809/api/settings/app (Fetch, not sent, 19.8 s)
  GET http://127.0.0.1:8809/api/events (EventSource, 200, 19.5 s)
server: GET /api/health answered 200 in 4 ms
```

- **page**: where the tab is, whether its document finished loading, and which service worker
  controls it. If the page does not answer within 5 s, the line says so: a busy main thread or a
  dead renderer is a finding in itself, and the network half is still reported.
- **#root**: the first 600 characters of the app's root. An empty root tells "nothing rendered"
  apart from a fallback, an error screen or a page that drew something else.
- **console errors**: the uncaught exceptions and `console.error` calls, the ones that would
  have failed a passing spec, each cut to its first four lines.
- **console log**: Chrome's own error and warning entries (`Log.entryAdded`).
- **failed requests**: every request that failed (`net::…`, a blocked reason, cancelled) or got
  a 4xx/5xx answer, and whether the service worker gave that answer.
- **still open**: every request with no end yet, the oldest first, with its age. A request that
  has a status but has not finished is a stream. One with no answer is either `sent` (it went out
  on a connection and the server has not answered) or `not sent` (no connection took it yet: it is
  queued in the browser). Chrome allows one host six connections over HTTP/1.1, so a page whose
  requests stay `not sent` has lost its connections to something else (see
  `packages/ui/src/lib/page-cache.ts` for the case the app already handles).
- **server**: after any failed wait, the runner asks the main server for `/api/health` and says
  how fast it answered, or that it did not answer within 5 s. A page waiting on a server that does
  not answer is then told apart from a page the server answered.

The record starts over each time the tab's main frame starts loading a new document, so what the
previous page did (its streams cancelled on the way out) does not show up as the new page's
problem. A spec that fails on an assertion, not a wait, also prints the console errors it would
have failed on.

None of this changes when a spec passes or fails. The console check is the same, and Chrome's
`Log` entries and failed requests are reported, never counted. `Network` stays enabled for the
whole run; `page.blockUrls` no longer turns it off when it lifts its block.

## What the next blank page will tell

The app draws nothing (`App` returns `null`) while it waits on two reads: the auth probe, which
gives up after 1.5 s, and `GET /api/settings/app`, which decides whether the setup assistant
stands in for the app. With no root error boundary, an error thrown while rendering also leaves the
root empty. The report tells these apart:

| The report shows | Cause |
| --- | --- |
| `#root` empty, `console errors` holding a render error | a render-time exception unmounted the app |
| `/api/settings/app` `sent, no response`, server slow or not answering | the server stalled |
| `/api/settings/app` or `/api/…` `not sent` | the browser's connections to the origin are all taken |
| a script `not sent`/`sent, no response`, or a `failed requests` chunk | the module graph never finished loading (service worker or server) |
| `page: did not answer within 5 s` | the renderer's main thread is blocked |

## What was tried to reproduce it

None of these runs showed a blank page:

- 50 navigations to Home with All projects and 25 composer reloads with a draft, under a 6×
  `Emulation.setCPUThrottlingRate`, beside three heavy specs.
- The exact sequences of both failing shards (shard 1 up to `composer.spec.mjs`, shard 4 up to
  `home.spec.mjs`), side by side under a 4× throttle.
- 16 copies each of `home.spec.mjs` and `composer.spec.mjs` over four shards at 2×, beside
  `a11y-team`, `documents` and `events`, on a machine at a load average of 60.

So the cause is not named yet, and this change makes the next CI failure name it. The harness's own
test (`e2e/harness.test.mjs`) checks the report against a real page that logs an error, gets a 404,
and has its six connections held by event streams so that a seventh request stays `not sent`.

## Related

- [[plans/e2e-harness-waits.md]]: waits on conditions, not on time.
- [[plans/ci-e2e-shards.md]]: the four shards the failures came from.
- [[plans/mobile.md]]: the service worker that serves the app shell.
