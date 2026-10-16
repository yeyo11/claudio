---
created_at: 2026-09-25T18:30:00Z
updated_at: 2026-10-16T12:00:00Z
tags:
    - notifications
    - push
    - decision
---
# Notifications: what is kept, and what interrupts

Claudio has two separate controls for notifications:

- **The kinds** (*Notify me when*) decide what the bell keeps at all.
- **The interruption level** decides which of those notifications also break into someone's work:
  a toast in the page, a system notification while the tab is hidden, and a push to a phone.

Before the level existed, the only choice for interruptions was a single on/off switch for toasts.
Every `normal` notification popped up, including the most frequent one: a chat finishing its turn.
Push filtered only by kind, so a phone was woken even for a subagent finishing in the background.
That was the "too invasive" complaint.

## The levels

`interrupts(notification, level)` in `packages/shared/src/notifications.ts` decides:

| Level | Interrupts for |
| --- | --- |
| `all` | Everything except `low` (background tasks, subagents and workflows finishing) |
| `important` (default) | `high` (a chat waiting for you, health turned red), anything with tone `bad` (a failure), an orchestration ending, an integration conflict |
| `urgent` | `high` only |
| `silent` | Nothing |

`low` never interrupts at any level, as it never did for toasts.

## Spend alerts, and urgency with risk

Plan: [plans/agent-run-improvements.md](plans/agent-run-improvements.md).

- **`spend.alert`.** An event with `level` `warn` (the day's spend reached 75 % of the daily cap) or
  `exhausted` (the cap was reached), emitted once per day and level; the rows are in `spend_alerts`
  (`packages/core/src/index.ts`). The web turns it into a notification draft: `warn` is a normal
  notification, `exhausted` is high.
- **Urgency with risk.** `notification.urgency` also receives `risk`: the riskiest medium-or-high tool
  call of the chat in its last ten minutes, masked and clipped to 300 characters
  (`PushService.recentRisk` in `packages/core/src/push.ts`). A call that is high risk can make a
  notification more urgent; the score never blocks anything. See
  [decision-engine.md](decision-engine.md) for the consent this changed.

## Decisions

- **One function for the page and for the push sender.** The web runs `interrupts` before showing a
  toast or a browser notification. The server runs it for each subscription before pushing. This
  follows the same rule as `notificationsFor`: the phone and the open page must never disagree
  about what is worth an interruption.
- **The level travels with each push subscription** (a `level` column in `push_subscriptions`, a
  `level` field in `POST /api/push/subscriptions`), because it is chosen per install. The page sends
  it again whenever it changes.
- **`important` is the default.** Rows and preferences saved before the level existed get it too,
  except for someone who had turned toasts off: they get `silent`. Moving everyone else to `all`
  would have kept exactly the behaviour that was found too loud.

## Related

[[plans/mobile.md]] · [[desktop.md]]
