---
created_at: 2026-11-14T15:00:00Z
updated_at: 2026-11-14T15:00:00Z
tags:
    - decision
    - accounts
    - rotation
    - credits
    - rate-limit
    - one-rule
    - spike
---
# Decision: what Claudio may rely on to know that a turn is paid from credits

Task t5 of [the limit-resume and credits plan](../plans/limit-resume-and-credits.md): spikes S1 and S4,
both free (no turn, no token, no credit). Task t6 builds the `overage` account state and t7 stops a
turn that crosses into credits (the owner's D3 and D4: credits are never spent unless the person
switched that on for the account, and under `never` such a turn is stopped at once). This document
says which fields those tasks may stand on, under [the one rule](../../CLAUDE.md): only what the
vendor ships for programs counts.

## Question

1. Does the vendor document `isUsingOverage`, `overageStatus` and `overageDisabledReason` on the
   `rate_limit_event`, and what does `errorCode: credits_required` look like? (S1)
2. Does `get_usage` on an account at its limit answer the reset and `is_enabled` reliably, and how long
   does it take? (S4)

## S1: the published typings and reference

Read: `@anthropic-ai/claude-agent-sdk` **0.3.325** (`npm pack`, extracted in an empty temp directory,
read only, nothing executed; it is the `latest` and `next` tag on 2026-11-14), file `sdk.d.ts`; and the
[TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript), section
`SDKRateLimitEvent`. The installed CLI is **2.1.322**.

### What the typings declare (`sdk.d.ts` 0.3.325)

```typescript
/** Rate limit event emitted when rate limit info changes. */
export declare type SDKRateLimitEvent = {
    type: 'rate_limit_event';
    /** Rate limit information for claude.ai subscription users. */
    rate_limit_info: SDKRateLimitInfo;
    uuid: UUID;
    session_id: string;
};

/** Rate limit information for claude.ai subscription users. */
export declare type SDKRateLimitInfo = {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;
    rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage';
    utilization?: number;
    overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
    overageResetsAt?: number;
    overageDisabledReason?: 'overage_not_provisioned' | 'org_level_disabled' | 'org_level_disabled_until' | 'out_of_credits' | 'seat_tier_level_disabled' | 'member_level_disabled' | 'seat_tier_zero_credit_limit' | 'group_zero_credit_limit' | 'member_zero_credit_limit' | 'org_service_level_disabled' | 'no_limits_configured' | 'fetch_error' | 'unknown';
    isUsingOverage?: boolean;
    overageInUse?: boolean;
    overageEnabled?: boolean;
    surpassedThreshold?: number;
    /** Which spend limit blocked the request when it is not the member's own cap: 'group_pool' means a pooled group budget shared by the member's team is used up (the denial otherwise looks like the member's own monthly cap). Absent on a plain member denial and from older CLIs. */
    limitScope?: 'service' | 'channel' | 'group_pool';
    errorCode?: 'credits_required';
    canUserPurchaseCredits?: boolean;
    hasChargeableSavedPaymentMethod?: boolean;
};
```

Only `limitScope` carries a doc comment. **Every other field, including the three the plan asked
about, is typed with no comment**: the typings name them and their values, they do not say what they
mean. `unifiedWindows`, which Claudio parses for the windows, is **not typed at all**.

### What the reference documents (prose)

The reference's `SDKRateLimitEvent` lists only `status`, `resetsAt`, `utilization`, `errorCode`,
`canUserPurchaseCredits`, `hasChargeableSavedPaymentMethod` and `overageEnabled`, and says:

> When `errorCode` is `"credits_required"`, the rejection is from a claude.ai subscription whose
> included usage is exhausted, and the session cannot continue until the user buys usage credits.
> `canUserPurchaseCredits` indicates whether the authenticated user can buy credits for the account, and
> `hasChargeableSavedPaymentMethod` indicates whether a saved payment method is on file. All three
> fields are absent on rate-limit events that are not credits-required rejections. Requires Claude Code
> v2.1.181 or later.
>
> On a warning about a plan usage limit, where `status` is `"allowed_warning"`, `overageEnabled`
> reports whether the account has usage credits turned on. Requires Claude Code v2.1.295 or later.

### Field by field

| Field | Typed in `sdk.d.ts` | In the reference prose | Seen in Claudio's data |
|---|---|---|---|
| `status` (`allowed`, `allowed_warning`, `rejected`) | yes | yes | yes |
| `resetsAt`, `utilization` | yes | yes (listed, no description) | yes |
| `rateLimitType` | yes | no | yes |
| `isUsingOverage` | yes, no comment | **no** | yes, always `false` (255 recorded events, CLI 2.1.278) |
| `overageStatus` | yes, no comment | **no** | yes: `rejected` on every recorded event (credits off) |
| `overageDisabledReason` | yes, no comment, 13 values | **no** | yes: `org_level_disabled`; the legacy `provider_limits` row holds `out_of_credits` |
| `overageResetsAt`, `overageInUse` | yes, no comment | no | `overageResetsAt` read by Claudio, never seen with a value |
| `overageEnabled` | yes | **yes**, only on `allowed_warning`, CLI 2.1.295+ | never seen (Claudio does not read it) |
| `errorCode: 'credits_required'` | yes | **yes**, CLI 2.1.181+ | never seen (Claudio does not read it) |
| `canUserPurchaseCredits`, `hasChargeableSavedPaymentMethod` | yes | yes, only with `credits_required` | never seen |
| `limitScope` | yes, with a comment | no | never seen |
| `unifiedWindows` | **no** | no | yes (the windows' source) |

The recorded events are the CLI 2.1.278 recordings in `packages/core/test/fixtures/recordings/`, all
of an account with credits off, e.g.
`{"status":"allowed","rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{…}}`.
No recorded event, in the fixtures or the owner's `rotation_events` (142 rows, none with an overage
field), has `isUsingOverage: true`, `overageStatus: allowed` or an `errorCode`.

### What `credits_required` looks like

By the reference: a `rate_limit_event` with `status: "rejected"` and `errorCode: "credits_required"`,
with `canUserPurchaseCredits` and `hasChargeableSavedPaymentMethod` beside it. It says the account's
**included usage is exhausted and the session cannot continue until the user buys credits**. That is the
credits-off or credits-unavailable case, **not necessarily the monthly cap case** (the plan's table had
the cap case as "likely here"; the reference does not say). No `-p` stream carrying it is in
Claudio's data (spike S2 would give one).

### The CLI's own surface

`claude --help` (2.1.322) says nothing of credits or overage. The CLI's stream is the one the SDK
types describe (`SDKMessage` includes `SDKRateLimitEvent`). The `result` message carries
`api_error_status?: number | null` (typed, not described) and a `terminal_reason?` whose values do
not include a credits or limit reason apart from `blocking_limit` and `api_error`. Claudio's
`cost` fields (`total_cost_usd`) are documented as "an estimate, not a billing statement", and say
nothing of who paid, so the CLI gives no flag on a result that a turn was paid from credits.

## S4: `get_usage`

### Typed surface

`get_usage` is in the typings (0.3.325) as `SDKControlGetUsageRequest`, with
`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` on the query object. Its reply
(`SDKControlGetUsageResponse`) is marked "Experimental — the shape may change" and types:

- `rate_limits.five_hour`, `seven_day`, `seven_day_oauth_apps`, `seven_day_opus`, `seven_day_sonnet`:
  `{ utilization: number | null (0-100), resets_at: string | null (ISO 8601) }`;
- `rate_limits.model_scoped[]`;
- `rate_limits.extra_usage?: { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; utilization: number | null; currency?: string | null } | null`, whose doc says "is_enabled is false while extra usage cannot cover sends" (the same shape
  appears in the `/usage` structured twin).

So `is_enabled`, `monthly_limit`, `used_credits` and `currency` are typed. What Claudio also reads
(`spend`, `limits[]`, `extra_usage.disabled_reason`, `spend_limit_reached`, `credits_ever_enabled`,
`decimal_places`) is **not in the typings**: observed in the fixture
`packages/accounts/test/fixtures/get-usage-max.json` and in the owner's readings only. The typings
promise no `disabled_reason` and no "limit reached" flag; they give `utilization` and
`monthly_limit` to compute it.

### What was observed, 2026-11-14 (read-only, no turn)

- **No account is at a limit now**, and none was made to be. A (Max) 93 % of its week
  (`state: near`), B (Team) 1 %, C (Pro) 2 %. So **the at-limit part of S4 is not observed**.
- Stored `limits.cli` readings (read through `GET /accounts`, 1 ms because it is served from the
  stored reading, not a read), taken 2026-11-13 15:13-15:14 by `get_usage`: `available: true` on the
  three, a plan each, `scoped` limits (Fable; on A also an `Overage_included` row, see below), and
  `credits`:
  A `enabled: false`, `limitMinor: 4000` USD, `usedMinor: 0`, `disabledReason: out_of_credits`,
  `everEnabled: true`; B `enabled: false`, never set up; C `enabled: false`, `everEnabled: true`,
  no reason. The reset of the binding window came back as an ISO time on every answer.
- **How long it takes.** Not measured now: timing it means starting the CLI, and this task's limits
  forbid running `claude -p`, which is how `controlRequest` reaches `get_usage`. Recorded figures:
  "about five seconds" ([get-usage-control-request](get-usage-control-request.md), CLI 2.1.302), and
  11-15 s for four accounts read in a loaded machine (`usageOf`, whose timeout is 30 s).
- **Past limits.** `usage_history` holds 10 626 samples (2026-10-16 to 2026-11-14), with no source
  and no `get_usage` marker. Samples at 100 % or more: A five_hour 15, seven_day 3; B five_hour 33;
  C five_hour 34, seven_day 8; one removed account five_hour 5. The highest are 117 (B), 111 (C),
  109 and 101 (A), so use does exceed 100 and the readings overshoot the limit. None of these
  accounts has had credits on in that period (`everEnabled` false for B), so the overshoot is not
  credit use. The store keeps only the **latest** `get_usage` answer per account, so what `get_usage`
  said at those limits is gone: it cannot answer the question.

### What it means for the reading

- Claudio reads `get_usage` only as a free check; the reading is the "freshest truth" while newer
  than the stream's. At a limit the stream already says `rejected` with `resetsAt`, so the question
  S4 asks matters for a wait with no stream reading (cause 5 of the plan) and for credits.
- `rate_limits_available: false` also comes for a network that is down, so a missing answer is not
  "no limit" (already handled in `Readings.observe`).
- **A latent defect for t6.** `seven_day_overage_included` is a `rateLimitType` the typings declare;
  Claudio's `scopedModel` turns any `seven_day_<x>` into a model called `Overage_included`, which is
  why account A shows a scoped "model" of that name at 61 %. It is not a model: it is a window of the
  plan that credits are included in. t6 should map it apart.

## What this means for t6 and t7

**The `overage` state** needs "the plan window is spent and credits cover it". The sources, ranked
by how far the vendor stands behind them:

1. **`get_usage` `extra_usage.is_enabled`, `used_credits`, `monthly_limit`** (typed, experimental,
   "is_enabled is false while extra usage cannot cover sends"): the only typed answer to "can credits
   cover this account's sends now". The cap is `used_credits >= monthly_limit` (computed, not a typed
   flag). Rely on it for the state, and treat absence as "no credits" (the plan's risk note).
2. **`rate_limit_event.overageEnabled`** (documented, but only on `allowed_warning`, CLI 2.1.295+):
   a hint that credits are on; do not require it.
3. **`rate_limit_event.isUsingOverage`, `overageStatus`** (typed without a meaning, no prose): the
   names say that overage is in use and that it covers (`allowed`) or does not (`rejected`). **Claudio
   may read them, but only as a hint to look at `get_usage`, never alone to decide that money is
   being spent**, because no recorded event ever had `isUsingOverage: true`, so the meaning is the
   field's name, not a fact. Keep them optional.
4. **`overageDisabledReason`**: typed with 13 values; use it only to word the reason, never to branch
   (the list grows: the typings add `fetch_error` and `unknown`).
5. **`errorCode: credits_required`**: documented. It is a rejection that names exhausted included
   usage and no credits; treat it as "out, with no credits to cover it" (state `exhausted`, with the
   reason `credits`), not as a cap.

**Stopping a turn that crosses into credits (D4).** The one signal the vendor documents for "now you
are on credits" is not there: `isUsingOverage: true` is typed, undocumented and **never observed**,
and nothing on a `result` says who paid (`total_cost_usd` is an estimate). So t7 must not rely on a
single field:

- Under `never`, before the turn starts, an account whose plan window is spent is out for choice
  (this already holds). A running turn is stopped when **either** an event says
  `isUsingOverage: true` (or `overageStatus: allowed` together with a spent plan window, `status`
  `rejected` on the five-hour or seven-day type, or utilization at 1), **or** a fresh `get_usage`
  says `extra_usage.is_enabled` while the binding window is at 100 %. The second is the typed one;
  the first is faster. Both are cheap to evaluate, and a false positive only moves a turn.
- The stop is at the event, so the turn that already ran after the plan was spent is the cost of the
  check; whatever arrives between the plan's last token and the event is unavoidable. Say so in the
  notice rather than promise zero.
- The prudent default if no field says either way is to leave an account with
  `credits.enabled && !limitReached` and a spent plan window as `overage`, not `exhausted`.

**For the paid-turn mark (t7).** No field marks a turn as paid. Mark it from Claudio's own state: the
account was `overage` while the turn ran.

## What stays unknown

- The `-p` stream of a turn on credits (is `isUsingOverage` true? is `overageStatus` `allowed`?) and
  of a turn at the credits cap: spike **S2**, not authorised.
- Whether `credits_required` appears when credits are on but at their cap, or only when off.
- Whether `autoContinueAtUsageLimit` (typed as a setting, with a description) reaches `-p`: **S3**.
- What `get_usage` answers while the account is at its limit (reset, `is_enabled`), and how long it
  takes then: not observed, no account was at a limit. Until it is, treat the stream's `resetsAt`
  as the reset, `get_usage` as the credits fact, and make no reliability claim for it at a limit.
- The 5 s and 11-15 s are older and from a loaded machine; a measurement is for whoever has an
  account at a limit and may run the CLI.

## Recommendation

1. **Build t6 on `get_usage` `extra_usage`** for the credits facts and keep `isUsingOverage`,
   `overageStatus`, `overageEnabled` and `errorCode` as optional hints from the stream, read
   defensively with every value optional. Read `errorCode` and `overageEnabled`, which Claudio
   ignores today (`stream.ts`).
2. **Map `seven_day_overage_included` apart** from the model-scoped windows (t6).
3. **t7 stops a turn under `never`** on a hint from the stream or a `get_usage` read that says credits
   can cover sends while the plan window is spent, and records the move as a rotation with reason
   `credits`; it marks the turn paid from Claudio's own state.
4. **Ask the owner for S2**, a paid turn on a capped Pro account, before t7 ships, to confirm the
   stream's shape. Until then no test may claim the shape of a paid turn: tests build it from the
   typings.
5. **Run S4 at a limit** the next time an account is at one: one `get_usage` read, timed, noted here.

## Related

[[plans/limit-resume-and-credits.md]] · [[decisions/get-usage-control-request.md]] · [[accounts.md]] ·
[[cli-surfaces.md]] · [[plans/limit-resume.md]]
