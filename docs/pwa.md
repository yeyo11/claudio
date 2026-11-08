---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-11-08T18:00:00Z
tags:
    - pwa
    - phone
    - push
    - notifications
---
# On a phone: the installable app and push

Claudio installs to a home screen as a progressive web app: the same bundle the API already serves,
with its own icon and no address bar. No app store, no native shell, nothing extra to build.

- **Android (Chrome, Edge)**: open Claudio and press **Install Claudio** in Settings → General → Install. The
  browser's own menu offers the same thing, as *Install app*.
- **iPhone and iPad (Safari)**: open Claudio, tap **Share**, then **Add to Home Screen**. iOS has no
  install API, so no button on a page can do it for you — Settings → General → Install says those two taps.
- **A desktop browser** installs it the same way, from the same tab.

Once installed it starts standalone and paints its own shell from the service worker's cache instead
of a white screen while the bundle downloads. Nothing about the client/server contract changes: the
same relative `/api` calls, the same `Authorization` header, the same two event streams. The worker
caches the shell only — it never answers a request under `/api`, `/docs` or `/openapi.json`, so
`GET /api/events` streams exactly as it does in a tab.

**Being told while the app is closed.** Settings → General → Notifications has an *Also push to this device*
switch. The browser subscribes with a VAPID key this server made for itself, and from then on a chat
that stops for a permission prompt puts a notification on the phone even with Claudio closed; tapping
it opens that prompt, not just the chat. The per-kind preferences and the interruption level above
the switch decide what is worth waking a device for, and the list below it shows every install registered, this one marked,
each with **Test** and **Remove**. A window that is open and focused shows its usual toast and no
push, so the same news never arrives twice. A test push, and every push on an iPhone or iPad, is
shown even then: a test has no toast of its own, and iOS revokes a subscription whose pushes show
nothing.

Push needs a **secure origin**: `https://…` or `localhost`. On `http://192.168.1.10:8797` — how most
people run Claudio on a LAN — the browser has no service worker at all, so there is no push and no
cached shell; the Settings page says so and names the origin rather than showing a switch that does
nothing. [docs/deploy.md](deploy.md) has the TLS proxy that fixes it. On iPhone and iPad, a push
reaches an app on the Home Screen only, never a Safari tab: install first, then turn the switch on
from the app that starts.

**No domain or proxy?** With Tailscale on this machine and on the phone, Settings → Access & safety → Remote access
serves Claudio on your tailnet at `https://<machine>.<tailnet>.ts.net:8444`, an HTTPS origin with a
real certificate, and so push. Turn on authentication first: the tunnel refuses to open without it.
The tailnet needs MagicDNS and HTTPS certificates on, and the address stays the same while the
machine keeps its name. Only devices on your tailnet can reach it. See
[docs/tunnel.md](tunnel.md).

## When the server cannot be reached

A phone away from home without Tailscale, or a laptop with no network, used to get a half-blank app
with an error in every widget. Two things the app used to blur are now apart
([plans/remote-updates.md](plans/remote-updates.md), D9):

- **A new version.** The server answers, with another version or without an old chunk: the banner
  *Claudio was updated to X* with **Reload** ([updates.md](updates.md#after-an-update-stale-chunks)).
- **No answer at all.** A network error, not an HTTP status. A reload cannot fix it, so none is
  offered: a screen of its own (`Unreachable`, an `Empty` with the `offline` illustration) takes the
  page's place and leaves the shell, and the pages behind it are held, not unmounted.

One failed call is only a suspicion. The page confirms it by probing `/api/health` (open, cheap,
8 s timeout); any HTTP answer, even an error status, proves the server is there, and only a probe
with no answer flips the screen on. The store is `apps/web/src/lib/reachability.ts`; the request
layer, the first auth check, the events feed and the lazy-chunk errors all feed it, and while it is
on, no widget, route or reload banner prints a network error of its own.

The words depend on the cause. With `navigator.onLine === false`: **No connection**, "This device has
no internet connection." Otherwise: **Can't reach Claudio**, "*address* isn't answering. If you're
away from home, turn on Tailscale or join your local network." (the address, `location.host`, in the
mono face). Below: "Retrying in N s" and **Retry now**. It retries by itself with a back-off from 2 s
doubling to 30 s, and at once on `online`, on focus and when the tab becomes visible. When the server
answers again the app goes on **without a reload**: queries are refetched and the events feed
reopens; if the version changed meanwhile, the update banner appears then. Before the app has
started, the boot guard's plain fallback says the same words when the network was the cause.
The servers feature will reuse the component for a remote that is offline while the hub is up.
Specs: `apps/web/test/{reachability,unreachable-screen}.test.tsx` and `e2e/specs/unreachable.spec.mjs`.

How the screens adapt to a phone is in [phone-layout.md](phone-layout.md) and the design system;
what is worth a push, and the interruption levels, in [notifications.md](notifications.md). Until
2026-10-17 this page was the README's "On a phone".

## Related

[[notifications.md]] · [[push-while-open.md]] · [[phone-layout.md]] · [[tunnel.md]] · [[deploy.md]] · [[desktop.md]] · [[known-limitations.md]]
