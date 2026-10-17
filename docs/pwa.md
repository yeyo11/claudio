---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-10-17T12:00:00Z
tags:
    - pwa
    - phone
    - push
    - notifications
---
# On a phone: the installable app and push

Claudio installs to a home screen as a progressive web app: the same bundle the API already serves,
with its own icon and no address bar. No app store, no native shell, nothing extra to build.

- **Android (Chrome, Edge)**: open Claudio and press **Install Claudio** in Settings → Install. The
  browser's own menu offers the same thing, as *Install app*.
- **iPhone and iPad (Safari)**: open Claudio, tap **Share**, then **Add to Home Screen**. iOS has no
  install API, so no button on a page can do it for you — Settings → Install says those two taps.
- **A desktop browser** installs it the same way, from the same tab.

Once installed it starts standalone and paints its own shell from the service worker's cache instead
of a white screen while the bundle downloads. Nothing about the client/server contract changes: the
same relative `/api` calls, the same `Authorization` header, the same two event streams. The worker
caches the shell only — it never answers a request under `/api`, `/docs` or `/openapi.json`, so
`GET /api/events` streams exactly as it does in a tab.

**Being told while the app is closed.** Settings → Notifications has an *Also push to this device*
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

**No domain or proxy?** With Tailscale on this machine and on the phone, Settings → Remote access
serves Claudio on your tailnet at `https://<machine>.<tailnet>.ts.net:8444`, an HTTPS origin with a
real certificate, and so push. Turn on authentication first: the tunnel refuses to open without it.
The tailnet needs MagicDNS and HTTPS certificates on, and the address stays the same while the
machine keeps its name. Only devices on your tailnet can reach it. See
[docs/tunnel.md](tunnel.md).

How the screens adapt to a phone is in [phone-layout.md](phone-layout.md) and the design system;
what is worth a push, and the interruption levels, in [notifications.md](notifications.md). Until
2026-10-17 this page was the README's "On a phone".

## Related

[[notifications.md]] · [[push-while-open.md]] · [[phone-layout.md]] · [[tunnel.md]] · [[deploy.md]] · [[desktop.md]] · [[known-limitations.md]]
