import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { DEFAULT_LEVEL, KINDS, LEVELS, type NotificationKind, type NotificationLevel } from '@claudio/shared';
import type {
  AgentReadEntry,
  AuditEntry,
  AuditFilter,
  HealthSignalAgent,
  HealthSignalKind,
  AuditPage,
  ChatCompaction,
  ChatNoteSource,
  ChatNoteState,
  ChatSessionNote,
  CollaboratorsKind,
  CollaboratorsPath,
  CompactionFailure,
  CompactionOrigin,
  CompactionState,
  DecisionAnswer,
  DecisionFeedback,
  DecisionPaletteAction,
  DecisionFilter,
  DecisionPage,
  DecisionPageQuery,
  DecisionPointId,
  DecisionPointKind,
  DecisionPointStats,
  DecisionProviderId,
  DecisionQuestion,
  DecisionRecord,
  DecisionResolution,
  DecisionStats,
  DecisionSubjectKind,
  DecisionUnavailableReason,
  EffectiveEnvironment,
  EndpointId,
  Execution,
  Orchestration,
  OrchestrationSpec,
  PlanDraftSummary,
  ProviderLimit,
  ProviderMove,
  ProviderMoveState,
  RateLimitWindow,
  RotationEvent,
  SpendPurpose,
  SupervisorProposal,
  SupervisorProposalStatus,
  UsageHistoryPoint,
  SystemSample,
} from '@claudio/shared';
import { chatsFromRuns, LEGACY_PROVIDER, type ChatRecord, type LegacyRun, type StoredChat } from './chat-records.ts';
import type { CoreConfig } from './paths.ts';
import { pruneWebhookDeliveries } from './webhook-store.ts';

/**
 * Embedded store for everything that is a stream rather than a document: rotation events today,
 * usage and audit history next. Settings-shaped state stays in its JSON file — a document that is
 * read and rewritten whole loses nothing to `writeAtomic`.
 *
 * SQLite comes with Node (>=22.5), so this costs no dependency and no build toolchain in the
 * image. WAL is the point of it as much as the persistence: several wrapper processes share one
 * data dir, and a JSON blob read, mutated and rewritten by two of them loses one side's writes.
 */

const KEEP_ROTATION_EVENTS = 2_000;
/** Guard events kept: the newest rows */
export const KEEP_GUARD_EVENTS = 20_000;
/** Agents' reads of teammates' copies kept: the newest rows */
export const KEEP_AGENT_READS = 20_000;

/**
 * Applied in order; `user_version` records how many have run, so each one is written once. A
 * function is for a change SQL cannot express: it rewrites rows into a new shape, inside the same
 * transaction as the version bump.
 */
const MIGRATIONS: ReadonlyArray<string | ((db: DatabaseSync) => void)> = [
  `CREATE TABLE rotation_events (
     seq       INTEGER PRIMARY KEY AUTOINCREMENT,
     ts        TEXT NOT NULL,
     event     TEXT NOT NULL,
     from_acct TEXT,
     to_acct   TEXT,
     reason    TEXT,
     detail    TEXT,
     raw       TEXT
   );
   CREATE INDEX rotation_events_ts ON rotation_events (ts);`,

  // Runs and orchestrations keep their shared type as the source of truth and travel as JSON in
  // one row each. The row is the point: two wrapper processes on one data dir used to rewrite a
  // whole-file blob from their own in-memory map, so whoever saved last erased the other's work.
  `CREATE TABLE runs (
     id         TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     json       TEXT NOT NULL
   );
   CREATE INDEX runs_created_at ON runs (created_at DESC);
   CREATE TABLE orchestrations (
     id         TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     json       TEXT NOT NULL
   );
   CREATE INDEX orchestrations_created_at ON orchestrations (created_at DESC);`,

  // A planner run is expensive and leaves no transcript, so its draft is written down the moment
  // it finishes. Without this the plan lived only in the HTTP response, and a dropped connection
  // meant paying for it again.
  `CREATE TABLE plan_drafts (
     run_id     TEXT PRIMARY KEY,
     created_at TEXT NOT NULL,
     objective  TEXT,
     json       TEXT NOT NULL
   );
   CREATE INDEX plan_drafts_created_at ON plan_drafts (created_at DESC);`,

  // What Claude actually loaded in a directory — tools, MCP servers, agents, skills — arrives only
  // in a run's init event. The transcript does not keep it, so without this the panel forgot it on
  // every restart until the next run there.
  `CREATE TABLE environments (
     cwd         TEXT PRIMARY KEY,
     observed_at TEXT NOT NULL,
     json        TEXT NOT NULL
   );`,

  // A run stops being a peer of a chat and becomes one execution of it. The chat is the session id,
  // and its executions are indexed by it; the old rows are folded into that shape here, once, and
  // the table they lived in is dropped, so nothing reads the old shape afterwards.
  migrateRunsToChats,

  // The context window of a model is a fact the CLI reports with every result (`modelUsage`), and
  // the only honest source of one: it differs between a model and its `[1m]` variant, and even
  // between accounts. Kept as it was last observed, so a chat read from a transcript, which does
  // not record it, can still be measured against it.
  `CREATE TABLE model_windows (
     model       TEXT PRIMARY KEY,
     context     INTEGER NOT NULL,
     observed_at TEXT NOT NULL
   );`,

  // How long each kind of shell command took, and how it ended, so that "far longer than usual" is
  // measured on this machine's own history and not guessed. One row per command a worker ran; the
  // index serves the only question asked of it: the recent runs of one kind.
  `CREATE TABLE command_durations (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     kind        TEXT NOT NULL,
     chat_id     TEXT NOT NULL,
     tool_use_id TEXT NOT NULL,
     started_at  TEXT NOT NULL,
     duration_ms INTEGER NOT NULL,
     outcome     TEXT NOT NULL
   );
   CREATE INDEX command_durations_kind ON command_durations (kind, id DESC);
   CREATE UNIQUE INDEX command_durations_call ON command_durations (chat_id, tool_use_id);`,

  // Every mutating request, so exposing the port leaves a trail. The body is deliberately not a
  // column: it carries prompts, credentials and MCP secrets, and an audit log nobody can share is
  // worth less than one that records who did what to which route.
  `CREATE TABLE audit (
     id     INTEGER PRIMARY KEY AUTOINCREMENT,
     at     TEXT NOT NULL,
     actor  TEXT NOT NULL,
     method TEXT NOT NULL,
     path   TEXT NOT NULL,
     status INTEGER NOT NULL,
     summary TEXT NOT NULL
   );
   CREATE INDEX audit_path ON audit (path);`,
  // What claude-swap reports about each account's windows, one row per reading: the panel draws a
  // line from them, and "how fast does this account burn" has no other source. The key makes a
  // second reading of the same instant a no-op instead of a duplicate.
  `CREATE TABLE usage_history (
     account INTEGER NOT NULL,
     window  TEXT NOT NULL,
     at      TEXT NOT NULL,
     pct     REAL NOT NULL,
     PRIMARY KEY (account, window, at)
   );
   CREATE INDEX usage_history_at ON usage_history (at);`,

  // What the supervisor proposed when a worker's health turned bad. Rows, because they accumulate;
  // the unique key is the rule "once per signal per chat", held by the store and not by a map that
  // a restart would empty (keyed per occurrence by a later migration).
  `CREATE TABLE supervisor_proposals (
     id               TEXT PRIMARY KEY,
     chat_id          TEXT NOT NULL,
     task_id          TEXT,
     orchestration_id TEXT,
     signal           TEXT NOT NULL,
     hint             TEXT NOT NULL,
     cost_usd         REAL NOT NULL,
     at               TEXT NOT NULL,
     status           TEXT NOT NULL
   );
   CREATE UNIQUE INDEX supervisor_proposals_signal ON supervisor_proposals (chat_id, signal);`,

  // One row per install that asked to be pushed to. Rows, because they accumulate and each one is
  // a fact about a device rather than a setting of this server. The endpoint is the identity a push
  // service gives an install, so it is the unique key: a browser that re-subscribes with the same
  // endpoint refreshes its row instead of adding a second one.
  `CREATE TABLE push_subscriptions (
     id           TEXT PRIMARY KEY,
     endpoint     TEXT NOT NULL UNIQUE,
     p256dh       TEXT NOT NULL,
     auth         TEXT NOT NULL,
     kinds        TEXT NOT NULL,
     label        TEXT NOT NULL,
     created_at   TEXT NOT NULL,
     last_seen_at TEXT NOT NULL
   );`,
  // How much each install may be interrupted. Rows from before it get the default a new install
  // gets: the page re-registers with its own choice the next time it opens anyway.
  `ALTER TABLE push_subscriptions ADD COLUMN level TEXT NOT NULL DEFAULT 'important';`,

  // The work items of the project ecosystem (docs/plans/project-ecosystem.md), in rows rather than
  // one document per item: several processes move cards at once, and a card rewritten whole by one
  // of them would erase the other's comment. Only the number is stored, never the key, so a new
  // prefix renames every key at once. The counter hands out numbers and is never decremented, so a
  // number freed by a delete is not handed out again. Nothing references the projects: a project
  // removed from Claudio keeps its work items for when its directory is imported again.
  `CREATE TABLE work_item_counters (
     project_id  TEXT PRIMARY KEY,
     last_number INTEGER NOT NULL
   );
   CREATE TABLE milestones (
     id          TEXT PRIMARY KEY,
     project_id  TEXT NOT NULL,
     name        TEXT NOT NULL,
     description TEXT NOT NULL,
     state       TEXT NOT NULL,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL,
     closed_at   TEXT
   );
   CREATE INDEX milestones_project ON milestones (project_id, created_at);
   CREATE TABLE work_items (
     id            TEXT PRIMARY KEY,
     project_id    TEXT NOT NULL,
     number        INTEGER NOT NULL,
     type          TEXT NOT NULL,
     title         TEXT NOT NULL,
     description   TEXT NOT NULL,
     status        TEXT NOT NULL,
     priority      TEXT NOT NULL,
     assignee_kind TEXT,
     assignee_role TEXT,
     epic_id       TEXT REFERENCES work_items (id) ON DELETE SET NULL,
     milestone_id  TEXT REFERENCES milestones (id) ON DELETE SET NULL,
     rank          TEXT NOT NULL,
     worktree      TEXT,
     branch        TEXT,
     created_at    TEXT NOT NULL,
     updated_at    TEXT NOT NULL,
     closed_at     TEXT,
     UNIQUE (project_id, number)
   );
   CREATE INDEX work_items_board ON work_items (project_id, status, rank);
   CREATE INDEX work_items_status ON work_items (status, rank);
   CREATE INDEX work_items_epic ON work_items (epic_id);
   CREATE INDEX work_items_milestone ON work_items (milestone_id);
   CREATE TABLE work_item_labels (
     item_id  TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     label    TEXT NOT NULL,
     PRIMARY KEY (item_id, label)
   );
   CREATE INDEX work_item_labels_label ON work_item_labels (label);
   CREATE TABLE work_item_criteria (
     id              TEXT PRIMARY KEY,
     item_id         TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     position        INTEGER NOT NULL,
     text            TEXT NOT NULL,
     checked         INTEGER NOT NULL DEFAULT 0,
     checked_by_kind TEXT,
     checked_by_role TEXT
   );
   CREATE INDEX work_item_criteria_item ON work_item_criteria (item_id, position);
   CREATE TABLE work_item_relations (
     blocker_id TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     blocked_id TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     created_at TEXT NOT NULL,
     PRIMARY KEY (blocker_id, blocked_id)
   );
   CREATE INDEX work_item_relations_blocked ON work_item_relations (blocked_id);
   CREATE TABLE work_item_comments (
     id                      TEXT PRIMARY KEY,
     item_id                 TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     author_kind             TEXT NOT NULL,
     author_role             TEXT,
     source_kind             TEXT,
     source_chat_id          TEXT,
     source_orchestration_id TEXT,
     source_task_id          TEXT,
     body                    TEXT NOT NULL,
     created_at              TEXT NOT NULL,
     updated_at              TEXT NOT NULL
   );
   CREATE INDEX work_item_comments_item ON work_item_comments (item_id, created_at);
   CREATE TABLE work_item_history (
     seq                    INTEGER PRIMARY KEY AUTOINCREMENT,
     id                     TEXT NOT NULL UNIQUE,
     item_id                TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     change                 TEXT NOT NULL,
     from_value             TEXT,
     to_value               TEXT,
     actor_kind             TEXT NOT NULL,
     actor_role             TEXT,
     cause_kind             TEXT,
     cause_event            TEXT,
     cause_chat_id          TEXT,
     cause_orchestration_id TEXT,
     cause_task_id          TEXT,
     created_at             TEXT NOT NULL
   );
   CREATE INDEX work_item_history_item ON work_item_history (item_id, seq);
   CREATE TABLE work_item_links (
     id               TEXT PRIMARY KEY,
     item_id          TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     kind             TEXT NOT NULL,
     role             TEXT NOT NULL,
     chat_id          TEXT,
     orchestration_id TEXT,
     task_id          TEXT,
     created_at       TEXT NOT NULL
   );
   CREATE INDEX work_item_links_item ON work_item_links (item_id, created_at);
   CREATE INDEX work_item_links_chat ON work_item_links (chat_id);
   CREATE INDEX work_item_links_task ON work_item_links (orchestration_id, task_id);`,

  // A project's journal and the memory its team proposes (orchestration 3 of
  // docs/plans/project-ecosystem.md). Rows, because both accumulate and several processes write
  // them: a closed item, an approval and a note typed by hand can land at once. `seq` orders the
  // journal and pages it, since two entries can share a timestamp. A `closed` entry is written once
  // per item, which the partial index holds even against two processes closing it together. No
  // reference to the work items: the journal keeps what happened after the item is deleted.
  `CREATE TABLE journal_entries (
     seq                     INTEGER PRIMARY KEY AUTOINCREMENT,
     id                      TEXT NOT NULL UNIQUE,
     project_id              TEXT NOT NULL,
     kind                    TEXT NOT NULL,
     text                    TEXT NOT NULL,
     item_id                 TEXT,
     author_kind             TEXT NOT NULL,
     author_role             TEXT,
     approved_by_kind        TEXT,
     approved_by_role        TEXT,
     proposal_id             TEXT,
     document_path           TEXT,
     sources                 TEXT NOT NULL DEFAULT '[]',
     created_at              TEXT NOT NULL
   );
   CREATE INDEX journal_entries_project ON journal_entries (project_id, seq);
   CREATE UNIQUE INDEX journal_entries_closed ON journal_entries (item_id) WHERE kind = 'closed';
   CREATE TABLE memory_proposals (
     seq                     INTEGER PRIMARY KEY AUTOINCREMENT,
     id                      TEXT NOT NULL UNIQUE,
     project_id              TEXT NOT NULL,
     target_kind             TEXT NOT NULL,
     target_file             TEXT,
     target_section          TEXT,
     text                    TEXT NOT NULL,
     reason                  TEXT NOT NULL,
     status                  TEXT NOT NULL,
     proposed_by_kind        TEXT NOT NULL,
     proposed_by_role        TEXT,
     source_kind             TEXT,
     source_chat_id          TEXT,
     source_orchestration_id TEXT,
     source_task_id          TEXT,
     flow_run_id             TEXT,
     item_id                 TEXT,
     approved_text           TEXT,
     decided_by_kind         TEXT,
     decided_by_role         TEXT,
     decided_at              TEXT,
     reject_reason           TEXT,
     journal_entry_id        TEXT REFERENCES journal_entries (id) ON DELETE SET NULL,
     created_at              TEXT NOT NULL
   );
   CREATE INDEX memory_proposals_project ON memory_proposals (project_id, status, seq);`,

  // A document of the project tied to a work item (the Documents module) is a link like a chat is,
  // so an item keeps one list of what it is tied to. The path is relative to the project, never
  // absolute, so a project moved to another directory keeps its ties. `team_role` is the role whose
  // flow run made a link, for documents and chats alike; null for links made outside the flow.
  `ALTER TABLE work_item_links ADD COLUMN document_path TEXT;
   ALTER TABLE work_item_links ADD COLUMN document_kind TEXT;
   ALTER TABLE work_item_links ADD COLUMN team_role TEXT;
   CREATE INDEX work_item_links_document ON work_item_links (document_path) WHERE document_path IS NOT NULL;`,

  // The flow by column (orchestration 3 of docs/plans/project-ecosystem.md). An item's bounces and
  // what it waits for are its own columns, read with the card. Each run of a team member is a row, so
  // a queue a restart cut off is still there when the wrapper comes back; `seq` is the queue's order.
  // At most one run per item waits in the queue: a second trigger replaces the first, which is what
  // keeps a burst of moves from queueing a burst of paid runs.
  `ALTER TABLE work_items ADD COLUMN bounces INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE work_items ADD COLUMN waiting TEXT;
   CREATE TABLE flow_runs (
     seq         INTEGER PRIMARY KEY AUTOINCREMENT,
     id          TEXT NOT NULL UNIQUE,
     project_id  TEXT NOT NULL,
     item_id     TEXT NOT NULL,
     role        TEXT NOT NULL,
     agent       TEXT NOT NULL,
     model       TEXT NOT NULL,
     stage       TEXT NOT NULL,
     column_name TEXT NOT NULL,
     state       TEXT NOT NULL,
     chat_id     TEXT,
     outcome     TEXT,
     summary     TEXT,
     error       TEXT,
     queued_at   TEXT NOT NULL,
     started_at  TEXT,
     ended_at    TEXT
   );
   CREATE INDEX flow_runs_project ON flow_runs (project_id, state, seq);
   CREATE INDEX flow_runs_item ON flow_runs (item_id, seq);
   CREATE INDEX flow_runs_chat ON flow_runs (chat_id) WHERE chat_id IS NOT NULL;
   CREATE UNIQUE INDEX flow_runs_queued ON flow_runs (item_id) WHERE state = 'queued';`,
  // The project assistant (orchestration 4): each run a read-only chat, each proposal a row decided on
  // its own. What a run laid out to read and what it read are kept apart, so the list can be drawn
  // at any moment. One running run per project and kind, held by the index rather than by a check
  // two processes could both pass.
  `CREATE TABLE assistant_runs (
     seq           INTEGER PRIMARY KEY AUTOINCREMENT,
     id            TEXT NOT NULL UNIQUE,
     project_id    TEXT NOT NULL,
     kind          TEXT NOT NULL,
     status        TEXT NOT NULL,
     model         TEXT NOT NULL,
     description   TEXT,
     resource_kind TEXT,
     chat_id       TEXT,
     empty         INTEGER NOT NULL DEFAULT 0,
     template      TEXT,
     proposes      TEXT NOT NULL,
     base_sources  TEXT NOT NULL,
     reads         TEXT NOT NULL,
     findings      TEXT NOT NULL DEFAULT '[]',
     summary       TEXT,
     cost_usd      REAL,
     error         TEXT,
     supersedes    TEXT,
     superseded_by TEXT,
     restarts      INTEGER NOT NULL DEFAULT 0,
     started_at    TEXT NOT NULL,
     ended_at      TEXT
   );
   CREATE INDEX assistant_runs_project ON assistant_runs (project_id, kind, seq);
   CREATE INDEX assistant_runs_chat ON assistant_runs (chat_id) WHERE chat_id IS NOT NULL;
   CREATE UNIQUE INDEX assistant_runs_running ON assistant_runs (project_id, kind) WHERE status = 'running';
   CREATE TABLE assistant_proposals (
     seq              INTEGER PRIMARY KEY AUTOINCREMENT,
     id               TEXT NOT NULL UNIQUE,
     run_id           TEXT NOT NULL,
     project_id       TEXT NOT NULL,
     kind             TEXT NOT NULL,
     status           TEXT NOT NULL,
     position         INTEGER NOT NULL,
     reason           TEXT NOT NULL,
     payload          TEXT NOT NULL,
     outcome          TEXT,
     decided_by_kind  TEXT,
     decided_by_role  TEXT,
     decided_at       TEXT,
     created_at       TEXT NOT NULL
   );
   CREATE INDEX assistant_proposals_run ON assistant_proposals (run_id, kind, position);`,
  // How many times a restart cut a flow run off: a run goes on in its chat at most twice, so a
  // run that keeps dying with the wrapper does not keep spending
  `ALTER TABLE flow_runs ADD COLUMN restarts INTEGER NOT NULL DEFAULT 0;`,
  // A label filter folds case and accents in JS, so no query ever used this index: it only cost
  // every write of an item's labels
  `DROP INDEX IF EXISTS work_item_labels_label;`,
  // What "Suggest tasks" is asked to look at, apart from what a project is for, and the language a
  // run's chat is titled in, so a run started again after a restart is worded as it was first
  `ALTER TABLE assistant_runs ADD COLUMN focus TEXT;
   ALTER TABLE assistant_runs ADD COLUMN language TEXT;`,
  // The language a flow run's chat is titled in, taken when the run is queued: after a restart the
  // person's language is unknown until their next request, and a queued run would be titled in English
  `ALTER TABLE flow_runs ADD COLUMN language TEXT;`,
  // Why a flow run failed or was cancelled, as a code the panel words in the person's language (the
  // English error stays beside it), and the failed run a person's retry queued it for
  `ALTER TABLE flow_runs ADD COLUMN cause TEXT;
   ALTER TABLE flow_runs ADD COLUMN retry_of TEXT;`,
  // Who queued a flow run by hand: a person starting the cards that waited when the flow was
  // switched on. Null for a run a card entering its column queued
  `ALTER TABLE flow_runs ADD COLUMN queued_by TEXT;`,
  // How many times the flow sent a run back to its chat because it ended with work still owed
  // (`openItems`): capped, so a run that keeps stopping early cannot spend for ever
  `ALTER TABLE flow_runs ADD COLUMN continuations INTEGER NOT NULL DEFAULT 0;`,
  // A work item's pull requests, one row per PR (docs/plans/work-item-pull-requests.md): they
  // accumulate, and the item reads its newest. `approved_at` is when the person approved it, and
  // `moved_at` when a conflict sent the item back to work, which a person's later move is measured
  // from. `claimed_until` keeps two processes on one database from asking gh about one PR at once.
  // A verification's criteria are kept on its run, as the PR's body quotes QA's notes
  `CREATE TABLE work_item_pull_requests (
     id             TEXT PRIMARY KEY,
     item_id        TEXT NOT NULL REFERENCES work_items (id) ON DELETE CASCADE,
     project_id     TEXT NOT NULL,
     phase          TEXT NOT NULL,
     number         INTEGER,
     url            TEXT,
     branch         TEXT NOT NULL,
     base           TEXT NOT NULL,
     ci             TEXT,
     conflicts      TEXT NOT NULL DEFAULT '[]',
     error_code     TEXT,
     error_detail   TEXT,
     approved_at    TEXT NOT NULL,
     moved_at       TEXT,
     opened_at      TEXT,
     closed_at      TEXT,
     checked_at     TEXT,
     claimed_until  TEXT,
     created_at     TEXT NOT NULL,
     updated_at     TEXT NOT NULL
   );
   CREATE INDEX work_item_pull_requests_item ON work_item_pull_requests (item_id, created_at);
   CREATE INDEX work_item_pull_requests_phase ON work_item_pull_requests (phase);
   ALTER TABLE flow_runs ADD COLUMN criteria TEXT;`,
  // The decision engine's history (docs/plans/decision-engine.md): one row per question batch sent
  // to a provider. Rows, because they accumulate, and the shadow comparison needs each answer next
  // to what later happened. `seq` is the paging cursor; `state` is the exact state sent, which the
  // consent preview reads back
  `CREATE TABLE decisions (
     seq            INTEGER PRIMARY KEY AUTOINCREMENT,
     id             TEXT NOT NULL UNIQUE,
     point          TEXT NOT NULL,
     kind           TEXT NOT NULL,
     project_id     TEXT,
     subject_kind   TEXT NOT NULL,
     subject_id     TEXT,
     provider       TEXT NOT NULL,
     model          TEXT NOT NULL,
     mode           TEXT NOT NULL,
     status         TEXT NOT NULL,
     unavailable    TEXT,
     state          TEXT NOT NULL,
     questions      TEXT NOT NULL,
     answers        TEXT,
     confidence     REAL,
     threshold      REAL,
     acted          INTEGER NOT NULL,
     visible        INTEGER NOT NULL,
     saved_run      INTEGER NOT NULL,
     latency_ms     INTEGER NOT NULL,
     input_tokens   INTEGER,
     cost_usd       REAL,
     outcome        TEXT,
     agreed         INTEGER,
     resolved_at    TEXT,
     feedback       TEXT,
     feedback_at    TEXT,
     at             TEXT NOT NULL
   );
   CREATE INDEX decisions_point_at ON decisions (point, at);
   CREATE INDEX decisions_project_at ON decisions (project_id, at);
   CREATE INDEX decisions_subject ON decisions (subject_kind, subject_id);`,
  // Two signals a resolver reads (CW-28): when the app was opened from a notification, and what the
  // palette's person did with the proposal. Columns of the history row, not of the state sent to a provider
  `ALTER TABLE decisions ADD COLUMN opened_at TEXT;
   ALTER TABLE decisions ADD COLUMN palette_action TEXT;`,
  // Which provider drives a chat (docs/plans/multi-provider.md). Every chat so far is a Claude Code
  // session, so the default is what an old process, which never writes the column, leaves behind
  `ALTER TABLE chats ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude-code';
   CREATE INDEX chats_provider ON chats (provider, created_at DESC);`,
  // Code hosts (docs/plans/code-hosts.md): every PR row so far was opened by gh on a host gh knew, so
  // 'github' is true of all of them; hostname stays null and the watcher reads it from origin as it
  // does today. An orchestration's change requests are the same lifecycle minus the flow's phases, and
  // cascade with the orchestration's row, which is upserted and never deleted and reinserted. The
  // unique index lets only one of two clicks, or two processes, open the change request. The breaker
  // of the execution layer is a row per host and bucket, shared by every process on the data directory
  `ALTER TABLE work_item_pull_requests ADD COLUMN host TEXT NOT NULL DEFAULT 'github';
   ALTER TABLE work_item_pull_requests ADD COLUMN hostname TEXT;
   CREATE TABLE orchestration_pull_requests (
     id               TEXT PRIMARY KEY,
     orchestration_id TEXT NOT NULL REFERENCES orchestrations (id) ON DELETE CASCADE,
     cwd              TEXT NOT NULL,
     host             TEXT NOT NULL,
     hostname         TEXT,
     phase            TEXT NOT NULL,
     number           INTEGER,
     url              TEXT,
     branch           TEXT NOT NULL,
     base             TEXT NOT NULL,
     ci               TEXT,
     error_code       TEXT,
     error_detail     TEXT,
     opened_at        TEXT,
     closed_at        TEXT,
     checked_at       TEXT,
     claimed_until    TEXT,
     created_at       TEXT NOT NULL,
     updated_at       TEXT NOT NULL
   );
   CREATE INDEX orchestration_pull_requests_orch ON orchestration_pull_requests (orchestration_id, created_at);
   CREATE INDEX orchestration_pull_requests_phase ON orchestration_pull_requests (phase);
   CREATE UNIQUE INDEX orchestration_pull_requests_live ON orchestration_pull_requests (orchestration_id)
     WHERE phase IN ('preparing', 'open');
   CREATE TABLE host_rate_limits (
     host          TEXT NOT NULL,
     bucket        TEXT NOT NULL,
     limit_value   INTEGER,
     remaining     INTEGER,
     reset_at      TEXT,
     blocked_until TEXT,
     strikes       INTEGER NOT NULL DEFAULT 0,
     updated_at    TEXT NOT NULL,
     PRIMARY KEY (host, bucket)
   );`,
  // Checks and the fix flow (docs/plans/code-hosts.md, phase 2): the last read of a change request's
  // checks, one row per change request of either kind, and the fix a change request is going through.
  // Every row so far has no fix, and zero attempts says so
  `CREATE TABLE change_request_snapshots (
     cr_id      TEXT PRIMARY KEY,
     kind       TEXT NOT NULL,
     head_sha   TEXT,
     checks     TEXT,
     rollup     TEXT,
     fetched_at TEXT NOT NULL
   );
   ALTER TABLE work_item_pull_requests ADD COLUMN fix_state TEXT;
   ALTER TABLE work_item_pull_requests ADD COLUMN fix_origin TEXT;
   ALTER TABLE work_item_pull_requests ADD COLUMN fix_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE work_item_pull_requests ADD COLUMN fix_head TEXT;
   ALTER TABLE orchestration_pull_requests ADD COLUMN fix_state TEXT;
   ALTER TABLE orchestration_pull_requests ADD COLUMN fix_origin TEXT;
   ALTER TABLE orchestration_pull_requests ADD COLUMN fix_attempts INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE orchestration_pull_requests ADD COLUMN fix_head TEXT;`,
  // Appended after the code hosts' and the checks' migrations, which were released before this one:
  // a database that has run them counts them as applied, so a migration placed before them would be skipped
  // Providers whose session id is not the chat's (docs/plans/multi-provider.md, phase 3): the native
  // id is null for a Claude chat, whose id is the native one. chat_entries holds a transcript the
  // provider does not keep in a file we can read; (chat_id, seq) makes a replay by a second process
  // a no-op
  `ALTER TABLE chats ADD COLUMN native_session_id TEXT;
   CREATE INDEX chats_native_session ON chats (provider, native_session_id);
   CREATE TABLE chat_entries (
     chat_id TEXT NOT NULL,
     seq     INTEGER NOT NULL,
     at      TEXT NOT NULL,
     entry   TEXT NOT NULL,
     PRIMARY KEY (chat_id, seq)
   );`,
  // Reviews (docs/plans/code-hosts.md, phase 3): the person's draft review, one row per note, and
  // each attempt to post it. A draft with no path is the review's general note. A fix that started
  // before this has no kind, which reads as checks
  `CREATE TABLE review_drafts (
     id         TEXT PRIMARY KEY,
     cr_id      TEXT NOT NULL,
     path       TEXT,
     side       TEXT,
     line       INTEGER,
     start_line INTEGER,
     body       TEXT NOT NULL,
     suggestion INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX review_drafts_cr ON review_drafts(cr_id, created_at);
   CREATE TABLE review_posts (
     id         TEXT PRIMARY KEY,
     cr_id      TEXT NOT NULL,
     marker     TEXT NOT NULL,
     event      TEXT NOT NULL,
     state      TEXT NOT NULL,
     remote_id  TEXT,
     detail     TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX review_posts_cr ON review_posts(cr_id, created_at);
   ALTER TABLE work_item_pull_requests ADD COLUMN fix_kind TEXT;
   ALTER TABLE orchestration_pull_requests ADD COLUMN fix_kind TEXT;`,
  // The thread ids an address of review comments was started for, as a JSON array: a restart before the
  // run starts rebuilds the prompt from them. A fix of another kind, or one from before this, has none
  `ALTER TABLE work_item_pull_requests ADD COLUMN fix_threads TEXT;`,
  // What the last address of review comments pushed, as JSON `{head, threadIds}`: written by the push
  // itself, cleared when another fix starts. A card taken over leaves none, which is how the page tells
  // a push from a fix that was dropped
  `ALTER TABLE work_item_pull_requests ADD COLUMN address_pushed TEXT;`,
  // Merging (docs/plans/code-hosts.md, phase 4): an audit of every merge click and arming, one row
  // each, written as `requested` before the host is called and settled after
  `CREATE TABLE change_request_merges (
     id           TEXT PRIMARY KEY,
     cr_id        TEXT NOT NULL,
     action       TEXT NOT NULL,
     method       TEXT,
     expected_head TEXT,
     delete_branch INTEGER NOT NULL DEFAULT 0,
     requested_at TEXT NOT NULL,
     requested_by TEXT NOT NULL,
     outcome      TEXT NOT NULL,
     reason       TEXT,
     detail       TEXT
   );
   CREATE INDEX change_request_merges_cr ON change_request_merges(cr_id, requested_at);`,
  // Issues linked to work items (docs/plans/code-hosts.md, phase 5): one row per issue imported or
  // linked, unique per project so an issue is never imported twice. sync_state is none until the first
  // write to the tracker; sync_reason holds the reason of a failed one
  `CREATE TABLE work_item_issues (
     id          TEXT PRIMARY KEY,
     project_id  TEXT NOT NULL,
     item_id     TEXT NOT NULL,
     tracker     TEXT NOT NULL,
     key         TEXT NOT NULL,
     external_id TEXT,
     title       TEXT NOT NULL,
     state       TEXT NOT NULL,
     url         TEXT,
     imported_at TEXT NOT NULL,
     synced_at   TEXT,
     sync_state  TEXT NOT NULL DEFAULT 'none',
     sync_reason TEXT,
     UNIQUE (project_id, tracker, key)
   );
   CREATE INDEX work_item_issues_item ON work_item_issues (item_id, imported_at);`,
  // The repository an issue came from, and uniqueness per repository: acme/a#12 and acme/b#12 are two
  // issues. SQLite cannot widen a UNIQUE, so the table is rebuilt. Rows from before the column read
  // '' ("not read yet"): the first start fills them from their project's tracker scope
  // (`WorkItemService.backfillIssueScopes`). Repository paths are case-insensitive on both hosts
  (db) => {
    db.exec(`CREATE TABLE work_item_issues_scoped (
       id          TEXT PRIMARY KEY,
       project_id  TEXT NOT NULL,
       item_id     TEXT NOT NULL,
       tracker     TEXT NOT NULL,
       scope       TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
       key         TEXT NOT NULL,
       external_id TEXT,
       title       TEXT NOT NULL,
       state       TEXT NOT NULL,
       url         TEXT,
       imported_at TEXT NOT NULL,
       synced_at   TEXT,
       sync_state  TEXT NOT NULL DEFAULT 'none',
       sync_reason TEXT,
       UNIQUE (project_id, tracker, scope, key)
     );
     INSERT INTO work_item_issues_scoped (id, project_id, item_id, tracker, key, external_id, title, state, url, imported_at, synced_at, sync_state, sync_reason)
       SELECT id, project_id, item_id, tracker, key, external_id, title, state, url, imported_at, synced_at, sync_state, sync_reason FROM work_item_issues;
     DROP TABLE work_item_issues;
     ALTER TABLE work_item_issues_scoped RENAME TO work_item_issues;
     CREATE INDEX work_item_issues_item ON work_item_issues (item_id, imported_at);`);
  },
  // Webhooks (docs/plans/code-hosts.md, phase 6): the hooks Claudio registered, and the delivery ids it
  // has seen, so a redelivery is a no-op. The signing secret is not a column: it is kept in a 0600 file
  // like the other secrets (decision 3), never in the database. events and last_response are JSON
  `CREATE TABLE webhook_registrations (
     id               TEXT PRIMARY KEY,
     project_id       TEXT NOT NULL,
     host             TEXT NOT NULL,
     hostname         TEXT NOT NULL,
     repo_path        TEXT NOT NULL COLLATE NOCASE,
     remote_hook_id   TEXT,
     url              TEXT NOT NULL,
     events           TEXT NOT NULL,
     state            TEXT NOT NULL DEFAULT 'active',
     last_delivery_at TEXT,
     last_ping_at     TEXT,
     last_response    TEXT,
     created_at       TEXT NOT NULL,
     updated_at       TEXT NOT NULL
   );
   CREATE INDEX webhook_registrations_project ON webhook_registrations (project_id, created_at);
   CREATE TABLE webhook_deliveries (
     delivery_id     TEXT PRIMARY KEY,
     registration_id TEXT NOT NULL,
     event           TEXT NOT NULL,
     received_at     TEXT NOT NULL
   );
   CREATE INDEX webhook_deliveries_received ON webhook_deliveries (received_at);`,
  // Rotation between providers (docs/plans/multi-provider.md, phase 4). provider_limits is the current
  // reading per provider, shared by every process on the data directory; provider_moves is the history
  // and the wait queue in one: the unique partial index lets one chat have a single open wait, so two
  // processes cannot both arm one. flow_runs.provider is null on old rows, read as claude-code
  `CREATE TABLE provider_limits (
     provider       TEXT PRIMARY KEY,
     state          TEXT NOT NULL,
     binding_window TEXT,
     utilization    REAL,
     resets_at      TEXT,
     windows        TEXT NOT NULL,
     observed_at    TEXT NOT NULL,
     source         TEXT NOT NULL
   );
   CREATE TABLE provider_moves (
     id            TEXT PRIMARY KEY,
     at            TEXT NOT NULL,
     subject_kind  TEXT NOT NULL,
     subject_id    TEXT NOT NULL,
     project_id    TEXT,
     from_chat     TEXT NOT NULL,
     to_chat       TEXT,
     from_provider TEXT NOT NULL,
     to_provider   TEXT,
     from_model    TEXT,
     to_model      TEXT,
     action        TEXT NOT NULL,
     state         TEXT NOT NULL,
     decided_by    TEXT NOT NULL,
     decision_id   TEXT,
     resets_at     TEXT,
     claimed_until TEXT,
     reason        TEXT,
     updated_at    TEXT NOT NULL
   );
   CREATE INDEX provider_moves_subject ON provider_moves (subject_kind, subject_id, at);
   CREATE INDEX provider_moves_from_chat ON provider_moves (from_chat);
   CREATE UNIQUE INDEX provider_moves_open ON provider_moves (from_chat) WHERE state IN ('waiting', 'resuming');
   ALTER TABLE flow_runs ADD COLUMN provider TEXT;`,
  // Jev's answers were stored with no cost though their tokens were kept. A literal, not the
  // constant in decisions/settings.ts: it is the price when those rows were written, and a
  // migration must not change when the constant is updated later.
  `UPDATE decisions SET cost_usd = input_tokens * 0.042 / 1000000.0
   WHERE provider = 'jev' AND cost_usd IS NULL AND input_tokens IS NOT NULL;`,
  // The effort a run started with (null: none was passed). Chats keep theirs in each execution's JSON.
  `ALTER TABLE flow_runs ADD COLUMN effort TEXT;
   ALTER TABLE assistant_runs ADD COLUMN effort TEXT;`,
  // Overage state of a limit reading, as JSON (null: the event said nothing about it)
  `ALTER TABLE provider_limits ADD COLUMN overage TEXT;`,
  // The person's own terminal (docs/plans/terminal.md, 3.9): who opened which shell and when, and
  // every attempt the gate refused. Counts only, never what was typed or printed.
  `CREATE TABLE terminal_sessions (
     id             TEXT PRIMARY KEY,
     scope          TEXT NOT NULL,
     project_id     TEXT,
     chat_id        TEXT,
     cwd            TEXT NOT NULL,
     shell          TEXT NOT NULL,
     actor          TEXT NOT NULL,
     client         TEXT NOT NULL,
     pid            INTEGER,
     pid_started    INTEGER,
     server_pid     INTEGER NOT NULL,
     started_at     TEXT NOT NULL,
     ended_at       TEXT,
     ended_reason   TEXT,
     exit_code      INTEGER
   );
   CREATE INDEX terminal_sessions_started ON terminal_sessions (started_at);
   CREATE TABLE terminal_attachments (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     session_id   TEXT NOT NULL,
     actor        TEXT NOT NULL,
     client       TEXT NOT NULL,
     origin       TEXT,
     attached_at  TEXT NOT NULL,
     detached_at  TEXT,
     bytes_in     INTEGER NOT NULL DEFAULT 0,
     bytes_out    INTEGER NOT NULL DEFAULT 0,
     refused      TEXT
   );
   CREATE INDEX terminal_attachments_session ON terminal_attachments (session_id);`,
  // Claudio's own name in stored values (decision 6 of docs/plans/claude-only-fork.md): a build from
  // before the rename wrote `agentry` as a chat's origin, the audit's and a merge's actor, and the
  // assistant marker under `agentryAssistant`. Rewritten once, so no reader has to know both names.
  // A chat row whose JSON cannot be parsed is left alone: one bad row must not stop the upgrade.
  `UPDATE chats SET json = json_set(json_remove(json, '$.agentryAssistant'), '$.claudioAssistant', json(json_extract(json, '$.agentryAssistant')))
   WHERE CASE WHEN json_valid(json) THEN json_type(json, '$.agentryAssistant') IS NOT NULL ELSE 0 END;
   UPDATE chats SET json = json_set(json, '$.origin', 'claudio')
   WHERE CASE WHEN json_valid(json) THEN json_extract(json, '$.origin') = 'agentry' ELSE 0 END;
   UPDATE audit SET actor = 'claudio' WHERE actor = 'agentry';
   UPDATE change_request_merges SET requested_by = 'claudio' WHERE requested_by = 'agentry';`,
  // docs/plans/agent-run-improvements.md. The daily spend cap sums a ledger of rows, one per result
  // that reported a cost, because two processes share a data dir and a turn's cost must land on the
  // day it was spent (the Usage report puts a whole execution on the day it ended). The alerts are
  // one row per local day and level, so two processes raise each one once. The fix verdicts of a
  // `checks.fix` run are kept as JSON beside its other results, and a path-scoped rule proposal keeps
  // its globs as a JSON array (null for every other target).
  `CREATE TABLE spend_ledger (
     seq              INTEGER PRIMARY KEY AUTOINCREMENT,
     at               TEXT NOT NULL,
     chat_id          TEXT NOT NULL,
     execution_id     TEXT NOT NULL,
     usd              REAL NOT NULL,
     reported         INTEGER NOT NULL,
     purpose          TEXT NOT NULL,
     account          TEXT,
     account_kind     TEXT,
     project_id       TEXT,
     orchestration_id TEXT
   );
   CREATE INDEX spend_ledger_at ON spend_ledger (at);
   CREATE TABLE spend_alerts (
     day   TEXT NOT NULL,
     level TEXT NOT NULL,
     at    TEXT NOT NULL,
     PRIMARY KEY (day, level)
   );
   ALTER TABLE flow_runs ADD COLUMN checks TEXT;
   ALTER TABLE memory_proposals ADD COLUMN target_paths TEXT;`,
  // The day of the upgrade starts from what was really spent: one ledger row per execution that
  // ended today (the server's local day, from date parts so a DST day is its real length) with a
  // cost. Their purpose is not known, so it reads `other`.
  (db) => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
    const insert = db.prepare("INSERT INTO spend_ledger (at, chat_id, execution_id, usd, reported, purpose) VALUES (?, ?, ?, ?, 1, 'other')");
    const rows = db.prepare('SELECT id, chat_id, json FROM executions').all() as Array<{ id: string; chat_id: string; json: string }>;
    for (const row of rows) {
      let doc: { endedAt?: unknown; costUsd?: unknown };
      try {
        doc = JSON.parse(row.json) as typeof doc;
      } catch {
        // One unreadable execution must not stop the upgrade
        continue;
      }
      if (typeof doc.endedAt !== 'string' || typeof doc.costUsd !== 'number' || !(doc.costUsd > 0)) continue;
      const ended = Date.parse(doc.endedAt);
      if (Number.isNaN(ended) || ended < start || ended >= end) continue;
      insert.run(doc.endedAt, row.chat_id, row.id, doc.costUsd);
    }
  },
  // The "Keep going today" pass of a flow card held by the daily spend cap (resolved question 2 of
  // docs/plans/agent-run-improvements.md): one row per card, the local day it is good for, and when
  // the person gave it. Rows, because it accumulates and the card's history is worth reading back
  `CREATE TABLE flow_spend_passes (
     item_id    TEXT PRIMARY KEY,
     day        TEXT NOT NULL,
     granted_at TEXT NOT NULL
   );`,
  // Context control (docs/plans/context-control.md). One row per compaction Claudio saw or asked for;
  // the unique partial index holds one open housekeeping turn per chat across the processes sharing
  // the data directory, and lease_until frees it if the process that claimed it died.
  `CREATE TABLE chat_compactions (
     id            TEXT PRIMARY KEY,
     chat_id       TEXT NOT NULL,
     origin        TEXT NOT NULL,
     state         TEXT NOT NULL,
     trigger_kind  TEXT,
     focus         TEXT,
     structured    INTEGER NOT NULL DEFAULT 1,
     flow_run_id   TEXT,
     requested_by  TEXT,
     boundary_uuid TEXT,
     pre_tokens    INTEGER,
     post_tokens   INTEGER,
     duration_ms   INTEGER,
     cost_usd      REAL,
     failure       TEXT,
     error         TEXT,
     note_id       TEXT,
     requested_at  TEXT NOT NULL,
     started_at    TEXT,
     ended_at      TEXT,
     lease_until   TEXT NOT NULL
   );
   CREATE INDEX chat_compactions_chat ON chat_compactions (chat_id, requested_at);
   CREATE UNIQUE INDEX chat_compactions_open ON chat_compactions (chat_id) WHERE state IN ('requested', 'running');
   CREATE UNIQUE INDEX chat_compactions_boundary ON chat_compactions (boundary_uuid) WHERE boundary_uuid IS NOT NULL;
   CREATE TABLE chat_notes (
     id            TEXT PRIMARY KEY,
     chat_id       TEXT NOT NULL,
     source        TEXT NOT NULL,
     state         TEXT NOT NULL,
     text          TEXT,
     sections      TEXT,
     compaction_id TEXT,
     entry_uuid    TEXT,
     error         TEXT,
     created_at    TEXT NOT NULL,
     ready_at      TEXT,
     lease_until   TEXT
   );
   CREATE INDEX chat_notes_chat ON chat_notes (chat_id, created_at);
   CREATE UNIQUE INDEX chat_notes_pending ON chat_notes (chat_id) WHERE state = 'pending';
   CREATE UNIQUE INDEX chat_notes_entry ON chat_notes (chat_id, entry_uuid) WHERE entry_uuid IS NOT NULL;`,
  `CREATE TABLE guard_events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     chat_id TEXT NOT NULL,
     project_id TEXT,
     orchestration_id TEXT,
     task_id TEXT,
     flow_run_id TEXT,
     tool_use_id TEXT,
     tool_name TEXT NOT NULL,
     rule TEXT NOT NULL,
     matcher TEXT NOT NULL,
     outcome TEXT NOT NULL,
     reason TEXT NOT NULL,
     excerpt TEXT NOT NULL
   );
   CREATE INDEX guard_events_chat ON guard_events (chat_id, seq);
   CREATE INDEX guard_events_orch ON guard_events (orchestration_id, seq);
   CREATE INDEX guard_events_flow ON guard_events (flow_run_id, seq);
   CREATE INDEX guard_events_at ON guard_events (at);
   CREATE UNIQUE INDEX guard_events_once ON guard_events (chat_id, tool_use_id, outcome) WHERE tool_use_id IS NOT NULL;`,
  `-- The review gate (docs/plans/review-gate.md). A round is one review of one head; its runs and its
  -- findings are rows because they accumulate across rounds and two processes share the data dir.
  -- The partial unique index lets one process claim a running round, so two cannot review one graph at once.
  CREATE TABLE review_rounds (
    id               TEXT PRIMARY KEY,
    orchestration_id TEXT NOT NULL REFERENCES orchestrations (id) ON DELETE CASCADE,
    round            INTEGER NOT NULL,
    pass             INTEGER NOT NULL,
    base             TEXT NOT NULL,
    head             TEXT NOT NULL,
    depth            TEXT NOT NULL,
    state            TEXT NOT NULL,
    reason           TEXT,
    files            INTEGER NOT NULL DEFAULT 0,
    added            INTEGER NOT NULL DEFAULT 0,
    deleted          INTEGER NOT NULL DEFAULT 0,
    chunks           INTEGER NOT NULL DEFAULT 0,
    skipped_files    TEXT NOT NULL DEFAULT '[]',
    estimate_usd     REAL,
    cost_usd         REAL NOT NULL DEFAULT 0,
    claimed_by       TEXT,
    accepted_by      TEXT,
    accepted_reason  TEXT,
    accepted_at      TEXT,
    started_at       TEXT NOT NULL,
    ended_at         TEXT,
    UNIQUE (orchestration_id, round, pass)
  );
  CREATE UNIQUE INDEX review_rounds_live ON review_rounds (orchestration_id) WHERE state = 'running';
  CREATE INDEX review_rounds_orch ON review_rounds (orchestration_id, started_at);
  CREATE TABLE review_runs (
    id           TEXT PRIMARY KEY,
    round_id     TEXT NOT NULL REFERENCES review_rounds (id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    dimension    TEXT,
    chunk        INTEGER,
    chunks       INTEGER,
    chat_id      TEXT,
    model        TEXT,
    effort       TEXT,
    account      TEXT,
    role_source  TEXT,
    role_sha     TEXT,
    state        TEXT NOT NULL,
    failure      TEXT,
    dropped      INTEGER NOT NULL DEFAULT 0,
    cost_usd     REAL NOT NULL DEFAULT 0,
    started_at   TEXT,
    ended_at     TEXT
  );
  CREATE INDEX review_runs_round ON review_runs (round_id, kind);
  CREATE TABLE review_findings (
    id                TEXT PRIMARY KEY,
    round_id          TEXT NOT NULL REFERENCES review_rounds (id) ON DELETE CASCADE,
    fingerprint       TEXT NOT NULL,
    source            TEXT NOT NULL,
    rule              TEXT,
    dimensions        TEXT NOT NULL,
    reported_by       INTEGER NOT NULL DEFAULT 1,
    severity          TEXT NOT NULL,
    confidence        REAL NOT NULL,
    title             TEXT NOT NULL,
    path              TEXT,
    line              INTEGER,
    side              TEXT,
    anchor            TEXT NOT NULL,
    evidence          TEXT NOT NULL,
    failure_scenario  TEXT NOT NULL,
    suggestion        TEXT,
    verdict           TEXT NOT NULL,
    verdict_reason    TEXT,
    verifier_run_id   TEXT,
    blocking          INTEGER NOT NULL,
    resolved_in_round INTEGER,
    created_at        TEXT NOT NULL,
    UNIQUE (round_id, fingerprint)
  );
  CREATE INDEX review_findings_round ON review_findings (round_id, blocking, severity);`,
  // Lessons from corrections (docs/plans/lessons.md)
  `CREATE TABLE lessons (
    seq                      INTEGER PRIMARY KEY AUTOINCREMENT,
    id                       TEXT NOT NULL UNIQUE,
    project_id               TEXT,
    status                   TEXT NOT NULL,
    trigger                  TEXT NOT NULL,
    action                   TEXT NOT NULL,
    confidence               REAL NOT NULL,
    seen_count               INTEGER NOT NULL DEFAULT 1,
    pinned                   INTEGER NOT NULL DEFAULT 0,
    mechanical               INTEGER NOT NULL DEFAULT 0,
    conflicts_instructions   INTEGER NOT NULL DEFAULT 0,
    contradicts_id           TEXT,
    overrides_id             TEXT,
    promoted_from            TEXT,
    retired_reason           TEXT,
    proposal_id              TEXT,
    instructions_proposal_id TEXT,
    proposed_by_kind         TEXT NOT NULL,
    proposed_by_role         TEXT,
    decided_by_kind          TEXT,
    decided_by_role          TEXT,
    decided_at               TEXT,
    edited_at                TEXT,
    last_seen_at             TEXT NOT NULL,
    last_confirmed_at        TEXT NOT NULL,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
  );
  CREATE INDEX lessons_project ON lessons (project_id, status, seq);
  CREATE TABLE lesson_evidence (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL UNIQUE,
    lesson_id   TEXT NOT NULL REFERENCES lessons (id) ON DELETE CASCADE,
    signal      TEXT NOT NULL,
    quote       TEXT NOT NULL,
    context     TEXT NOT NULL,
    chat_id     TEXT,
    entry_uuid  TEXT,
    job_id      TEXT,
    at          TEXT NOT NULL
  );
  CREATE INDEX lesson_evidence_lesson ON lesson_evidence (lesson_id, seq);
  -- What the transcript cannot tell: a person's deny (vs. a timeout), a rewind, a rejected proposal.
  CREATE TABLE lesson_signals (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    id          TEXT NOT NULL UNIQUE,
    project_id  TEXT NOT NULL,
    chat_id     TEXT,
    kind        TEXT NOT NULL,
    entry_uuid  TEXT,
    detail      TEXT NOT NULL,
    job_id      TEXT,
    at          TEXT NOT NULL
  );
  CREATE INDEX lesson_signals_chat ON lesson_signals (chat_id, job_id);
  CREATE TABLE lesson_jobs (
    seq            INTEGER PRIMARY KEY AUTOINCREMENT,
    id             TEXT NOT NULL UNIQUE,
    project_id     TEXT NOT NULL,
    chat_id        TEXT,
    trigger        TEXT NOT NULL,
    status         TEXT NOT NULL,
    outcome        TEXT,
    from_uuid      TEXT,
    until_uuid     TEXT,
    signals        INTEGER NOT NULL DEFAULT 0,
    candidates     INTEGER NOT NULL DEFAULT 0,
    proposed       INTEGER NOT NULL DEFAULT 0,
    merged         INTEGER NOT NULL DEFAULT 0,
    dropped        TEXT NOT NULL DEFAULT '{}',
    decision_id    TEXT,
    reserved_usd   REAL NOT NULL DEFAULT 0,
    cost_usd       REAL,
    attempts       INTEGER NOT NULL DEFAULT 0,
    claimed_by     TEXT,
    claimed_until  TEXT,
    next_at        TEXT,
    error          TEXT,
    created_at     TEXT NOT NULL,
    started_at     TEXT,
    ended_at       TEXT
  );
  CREATE INDEX lesson_jobs_project ON lesson_jobs (project_id, created_at);
  -- One open job per chat: a second trigger while one waits is the same work
  CREATE UNIQUE INDEX lesson_jobs_open ON lesson_jobs (chat_id) WHERE status IN ('queued', 'deferred', 'running') AND chat_id IS NOT NULL;
  ALTER TABLE memory_proposals ADD COLUMN lesson_id TEXT REFERENCES lessons (id) ON DELETE SET NULL;
`,
  // docs/plans/instruction-evals.md: eval runs, their samples, calls and checks
  `CREATE TABLE eval_runs (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     eval_name TEXT NOT NULL,
     definition_sha TEXT NOT NULL,
     definition TEXT NOT NULL,
     variants TEXT NOT NULL,
     samples_per_case INTEGER NOT NULL,
     account TEXT,
     state TEXT NOT NULL CHECK (state IN ('queued','running','waiting','ended')),
     outcome TEXT CHECK (outcome IN ('completed','capped','cancelled','interrupted','failed')),
     reason TEXT,
     resets_at TEXT,
     max_cost_usd REAL NOT NULL,
     cost_usd REAL NOT NULL DEFAULT 0,
     started_by TEXT NOT NULL,
     owner_pid INTEGER, owner_started_at TEXT,
     created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
   );
   CREATE INDEX eval_runs_history ON eval_runs (project_id, eval_name, created_at);
   CREATE UNIQUE INDEX eval_runs_live ON eval_runs (project_id) WHERE state IN ('queued','running','waiting');
   CREATE TABLE eval_variants (
     run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
     variant TEXT NOT NULL CHECK (variant IN ('pinned','current','proposed')),
     target_path TEXT NOT NULL,
     present INTEGER NOT NULL,
     content_sha TEXT,
     content TEXT,
     PRIMARY KEY (run_id, variant)
   );
   CREATE TABLE eval_samples (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
     case_id TEXT NOT NULL, variant TEXT NOT NULL, attempt INTEGER NOT NULL, try INTEGER NOT NULL DEFAULT 1,
     seq INTEGER NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('queued','running','ended')),
     outcome TEXT CHECK (outcome IN ('passed','failed','limit','interrupted','cancelled','skipped','infra')),
     reason TEXT,
     chat_id TEXT, account TEXT, model TEXT, cli_version TEXT, pin TEXT NOT NULL,
     cost_usd REAL, duration_ms INTEGER, turns INTEGER, calls_truncated INTEGER NOT NULL DEFAULT 0,
     result_text TEXT,
     owner_pid INTEGER, started_at TEXT, ended_at TEXT,
     UNIQUE (run_id, case_id, variant, attempt, try)
   );
   CREATE INDEX eval_samples_run ON eval_samples (run_id, seq);
   CREATE TABLE eval_calls (
     sample_id TEXT NOT NULL REFERENCES eval_samples(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL, message INTEGER NOT NULL, tool_use_id TEXT, name TEXT NOT NULL,
     scope TEXT NOT NULL CHECK (scope IN ('main','sub')),
     outcome TEXT NOT NULL CHECK (outcome IN ('ok','error','denied','open')),
     input TEXT NOT NULL,
     result TEXT,
     at TEXT,
     PRIMARY KEY (sample_id, seq)
   );
   CREATE TABLE eval_checks (
     sample_id TEXT NOT NULL REFERENCES eval_samples(id) ON DELETE CASCADE,
     idx INTEGER NOT NULL, kind TEXT NOT NULL, passed INTEGER NOT NULL,
     detail TEXT NOT NULL,
     evidence_seq INTEGER,
     output TEXT,
     PRIMARY KEY (sample_id, idx)
   );`,
  // Instruction evals v2. SQLite cannot widen a CHECK, so eval_samples (and the two tables that
  // reference it) are rebuilt to admit the 'unjudged' outcome and the pressure column; children go
  // first so no cascade deletes their rows.
  `CREATE TABLE eval_samples_v2 (
     id TEXT PRIMARY KEY,
     run_id TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
     case_id TEXT NOT NULL, variant TEXT NOT NULL, pressure TEXT NOT NULL DEFAULT 'neutral', attempt INTEGER NOT NULL, try INTEGER NOT NULL DEFAULT 1,
     seq INTEGER NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('queued','running','ended')),
     outcome TEXT CHECK (outcome IN ('passed','failed','limit','interrupted','cancelled','skipped','infra','unjudged')),
     reason TEXT,
     chat_id TEXT, account TEXT, model TEXT, cli_version TEXT, pin TEXT NOT NULL,
     cost_usd REAL, duration_ms INTEGER, turns INTEGER, calls_truncated INTEGER NOT NULL DEFAULT 0,
     result_text TEXT,
     owner_pid INTEGER, started_at TEXT, ended_at TEXT,
     UNIQUE (run_id, case_id, variant, pressure, attempt, try)
   );
   CREATE TABLE eval_calls_v2 (
     sample_id TEXT NOT NULL REFERENCES eval_samples_v2(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL, message INTEGER NOT NULL, tool_use_id TEXT, name TEXT NOT NULL,
     scope TEXT NOT NULL CHECK (scope IN ('main','sub')),
     outcome TEXT NOT NULL CHECK (outcome IN ('ok','error','denied','open')),
     input TEXT NOT NULL,
     result TEXT,
     at TEXT,
     PRIMARY KEY (sample_id, seq)
   );
   CREATE TABLE eval_checks_v2 (
     sample_id TEXT NOT NULL REFERENCES eval_samples_v2(id) ON DELETE CASCADE,
     idx INTEGER NOT NULL, kind TEXT NOT NULL, passed INTEGER NOT NULL,
     detail TEXT NOT NULL,
     evidence_seq INTEGER,
     output TEXT,
     PRIMARY KEY (sample_id, idx)
   );
   INSERT INTO eval_samples_v2 (id, run_id, case_id, variant, attempt, try, seq, state, outcome, reason, chat_id, account, model, cli_version, pin,
     cost_usd, duration_ms, turns, calls_truncated, result_text, owner_pid, started_at, ended_at)
     SELECT id, run_id, case_id, variant, attempt, try, seq, state, outcome, reason, chat_id, account, model, cli_version, pin,
     cost_usd, duration_ms, turns, calls_truncated, result_text, owner_pid, started_at, ended_at FROM eval_samples;
   INSERT INTO eval_calls_v2 SELECT sample_id, seq, message, tool_use_id, name, scope, outcome, input, result, at FROM eval_calls;
   INSERT INTO eval_checks_v2 SELECT sample_id, idx, kind, passed, detail, evidence_seq, output FROM eval_checks;
   DROP TABLE eval_calls;
   DROP TABLE eval_checks;
   DROP TABLE eval_samples;
   ALTER TABLE eval_samples_v2 RENAME TO eval_samples;
   ALTER TABLE eval_calls_v2 RENAME TO eval_calls;
   ALTER TABLE eval_checks_v2 RENAME TO eval_checks;
   CREATE INDEX eval_samples_run ON eval_samples (run_id, seq);
   CREATE TABLE eval_judgements (
     sample_id TEXT NOT NULL REFERENCES eval_samples(id) ON DELETE CASCADE,
     idx INTEGER NOT NULL,
     pass INTEGER,
     reason TEXT NOT NULL,
     evidence TEXT NOT NULL DEFAULT '[]',
     cost_usd REAL,
     model TEXT,
     status TEXT NOT NULL CHECK (status IN ('judged','unjudged')),
     PRIMARY KEY (sample_id, idx)
   );
   ALTER TABLE eval_runs ADD COLUMN gate TEXT;
   ALTER TABLE eval_runs ADD COLUMN gate_detail TEXT;`,
  // Phase 2: the eval an assistant `evals` run drafts cases for
  `ALTER TABLE assistant_runs ADD COLUMN eval_name TEXT;`,
  // Collaborators (docs/plans/collaborators.md §4.3): the copies of what teammates share, their
  // presence, the joins a member relays and the invite secrets an owner has spent. The roster chain,
  // links and cursors are a document per group (`collab/groups-store.ts`), not rows
  `CREATE TABLE collab_records (
     owner_id TEXT NOT NULL,
     share_key TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('chats','memory','journal','documents','artifacts','board')),
     record_id TEXT NOT NULL,
     version TEXT NOT NULL,
     json TEXT NOT NULL,
     synced_at TEXT NOT NULL,
     PRIMARY KEY (owner_id, share_key, kind, record_id)
   );
   CREATE TABLE collab_transcript_lines (
     owner_id TEXT NOT NULL,
     share_key TEXT NOT NULL,
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     line TEXT NOT NULL,
     PRIMARY KEY (owner_id, share_key, session_id, seq)
   );
   CREATE TABLE collab_peers (
     endpoint_id TEXT PRIMARY KEY,
     last_seen_at TEXT NOT NULL,
     path TEXT CHECK (path IN ('direct','relay'))
   );
   CREATE TABLE collab_join_requests (
     group_id TEXT NOT NULL,
     from_endpoint_id TEXT NOT NULL,
     sealed TEXT NOT NULL,
     relayed_by TEXT,
     expires_at TEXT,
     received_at TEXT NOT NULL,
     forwarded_at TEXT,
     PRIMARY KEY (group_id, from_endpoint_id)
   );
   CREATE TABLE collab_used_invites (
     group_id TEXT NOT NULL,
     secret_hash TEXT NOT NULL,
     used_at TEXT NOT NULL,
     PRIMARY KEY (group_id, secret_hash)
   );`,
  // Which uploads belong to a chat, as a row per message that attached them, so a shared chat's
  // uploads are known whether or not the chat was loaded since the start. A chat older than these
  // rows is scanned once from its transcript, and `chat_upload_scans` says it was
  `CREATE TABLE chat_uploads (
     chat_id TEXT NOT NULL,
     upload_id TEXT NOT NULL,
     attached_at TEXT NOT NULL,
     PRIMARY KEY (chat_id, upload_id)
   );
   CREATE TABLE chat_upload_scans (
     chat_id TEXT PRIMARY KEY,
     scanned_at TEXT NOT NULL
   );`,
  // The joins an owner denied, kept until the invite would have expired, so the joiner and the
  // members that held its request can be told (docs/collaborators.md, joins). The owner's row has the
  // secret's hash; a member's has only the tag the joiner asks with
  `CREATE TABLE collab_join_denials (
     group_id TEXT NOT NULL,
     endpoint_id TEXT NOT NULL,
     tag TEXT NOT NULL,
     secret_hash TEXT,
     denied_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     PRIMARY KEY (group_id, endpoint_id, tag)
   );`,
  // Every read of a teammate's copy by an agent, as a row (docs/plans/collaborators-agent-access.md):
  // the chat whose token read it, the tool that asked, the copy and the records. Keyed by the owner's
  // endpoint id and share key like the copies themselves, so a row outlives a dropped copy
  `CREATE TABLE collab_agent_reads (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     chat_id TEXT NOT NULL,
     tool TEXT NOT NULL,
     owner_id TEXT NOT NULL,
     share_key TEXT NOT NULL,
     share_id TEXT NOT NULL,
     kind TEXT,
     record_ids TEXT NOT NULL
   );
   CREATE INDEX collab_agent_reads_copy ON collab_agent_reads (owner_id, share_id, id);
   CREATE INDEX collab_agent_reads_chat ON collab_agent_reads (chat_id, id);`,
  // The machine's figures once a minute, a week of them (docs/resource-control.md, figures history).
  // Rows, because they accumulate; the instant is the key, so a second reading of the same instant
  // replaces the first, and the pruning is a range delete on the key. A figure the kernel did not
  // give is NULL, never 0.
  `CREATE TABLE system_samples (
     at            TEXT PRIMARY KEY,
     load1         REAL,
     total_mb      INTEGER,
     available_mb  INTEGER,
     cpu_some10    REAL,
     memory_some10 REAL,
     io_some10     REAL,
     chats         INTEGER NOT NULL,
     rss_mb        INTEGER,
     admitting     INTEGER NOT NULL
   );`,

  // Which repository each directory a chat or a run used is in (docs/plans/projects-as-repositories.md,
  // D4). Rows, because they accumulate and two processes write them; never deleted, because a
  // removed worktree's chats keep their project only through the row it left.
  `CREATE TABLE repo_places (
     dir           TEXT PRIMARY KEY,
     common_dir    TEXT,
     main_checkout TEXT,
     worktree      TEXT,
     subdir        TEXT NOT NULL DEFAULT '',
     branch        TEXT,
     source        TEXT NOT NULL,
     seen_at       TEXT NOT NULL,
     gone_at       TEXT
   );
   CREATE INDEX repo_places_common ON repo_places (common_dir);`,

  // The route each audited request matched, as `ROUTE_DOCS` keys it (`POST /chats/:id/stop`), so
  // the web can word a row in the reader's language. Rows written before it, and the ones the
  // wrapper writes itself, keep null and show their stored English summary
  `ALTER TABLE audit ADD COLUMN route TEXT;`,

  // Which chat holds a stateless OpenAI client's history, by the hash of that history
  // (docs/openai-compatible-api.md). Rows, because two processes answer requests on one data dir and
  // a restart must still find the chat; the hash is the key, so a second answer under it is an upsert
  `CREATE TABLE openai_conversations (
     hash        TEXT PRIMARY KEY,
     chat_id     TEXT NOT NULL,
     client_user TEXT,
     created_at  TEXT NOT NULL,
     updated_at  TEXT NOT NULL
   );
   CREATE INDEX openai_conversations_chat ON openai_conversations (chat_id);
   CREATE INDEX openai_conversations_updated ON openai_conversations (updated_at);`,

  // The responses `POST /v1/responses` stored for `previous_response_id` and `GET /v1/responses/:id`
  // (docs/openai-compatible-api.md, phase 5). One row per response, written once: they accumulate,
  // and a restart must still continue a chain. They go with their chat and expire with the API sweep
  `CREATE TABLE openai_responses (
     id               TEXT PRIMARY KEY,
     chat_id          TEXT NOT NULL,
     conversation_key TEXT NOT NULL,
     response         TEXT NOT NULL,
     input_items      TEXT NOT NULL,
     created_at       TEXT NOT NULL
   );
   CREATE INDEX openai_responses_chat ON openai_responses (chat_id);
   CREATE INDEX openai_responses_created ON openai_responses (created_at);`,

  // The system prompt of an API chat in its two parts (docs/openai-compatible-api.md, "The system
  // prompt"): per stored response, the conversation part its chain had reached, which a
  // `previous_response_id` turn extends; per chat, the parts its process runs with, which a request
  // naming the chat without system messages keeps, across a restart too
  `ALTER TABLE openai_responses ADD COLUMN conversation_system TEXT;
   CREATE TABLE openai_chat_prompts (
     chat_id      TEXT PRIMARY KEY,
     instructions TEXT NOT NULL,
     conversation TEXT NOT NULL,
     updated_at   TEXT NOT NULL
   );`,

  // Ephemeral workspaces (docs/plans/headless-image.md, D7): records that come and go, shared by
  // the processes on one data dir. `host` is the source URL's host, never the URL, which carries a
  // code host's token. A removed one keeps its row with `removed_at`, so a chat naming it is told
  // it expired rather than that it never existed
  `CREATE TABLE workspaces (
     id           TEXT PRIMARY KEY,
     source       TEXT NOT NULL,
     host         TEXT,
     bytes        INTEGER NOT NULL DEFAULT 0,
     files        INTEGER NOT NULL DEFAULT 0,
     top_dir      TEXT,
     created_at   TEXT NOT NULL,
     last_used_at TEXT NOT NULL,
     expires_at   TEXT NOT NULL,
     state        TEXT NOT NULL,
     removed_at   TEXT
   );
   CREATE INDEX workspaces_removed ON workspaces (removed_at);`,

  // Writes refused before their caller was identified (docs/security-model.md, "Chat tokens"): a
  // ring of its own, so whoever can reach the port cannot push the trail of what identified callers
  // did out of the 50 000 rows `audit` keeps. The newest refusals already logged move over, and the
  // rest leave the log they were flooding
  `CREATE TABLE audit_refusals (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     at      TEXT NOT NULL,
     actor   TEXT NOT NULL,
     method  TEXT NOT NULL,
     path    TEXT NOT NULL,
     status  INTEGER NOT NULL,
     summary TEXT NOT NULL,
     route   TEXT
   );
   INSERT INTO audit_refusals (at, actor, method, path, status, summary, route)
     SELECT at, actor, method, substr(path, 1, 512), status, summary, route
     FROM (SELECT * FROM audit WHERE actor = 'anonymous' ORDER BY id DESC LIMIT 1000)
     ORDER BY id;
   DELETE FROM audit WHERE actor = 'anonymous';`,

  // The supervisor answers each occurrence of a signal, not each kind for ever (C3 of
  // docs/plans/regression-fixes-2026-10-29.md): a second hang of a long lead chat is a new question.
  // `occurrence` is the call the signal is about, else when it started; the rows before it keep ''
  // and so still hold their kind for the chat, which is what they were asked about. The agent a
  // signal named rides with its proposal, so the hint can say whose it is
  `ALTER TABLE supervisor_proposals ADD COLUMN occurrence TEXT NOT NULL DEFAULT '';
   ALTER TABLE supervisor_proposals ADD COLUMN agent TEXT;
   DROP INDEX supervisor_proposals_signal;
   CREATE UNIQUE INDEX supervisor_proposals_occurrence ON supervisor_proposals (chat_id, signal, occurrence);`,

  // What Claude loaded is a chat's, not its folder's: two chats in one folder load different servers
  // and models (docs/plans/regression-fixes-2026-10-29.md, C5). Each row keyed by folder moves under
  // the chat that last started there, which its JSON names; a row naming none has no chat to go to
  `CREATE TABLE environments_by_chat (
     chat_id     TEXT PRIMARY KEY,
     cwd         TEXT NOT NULL,
     observed_at TEXT NOT NULL,
     json        TEXT NOT NULL
   );
   INSERT OR REPLACE INTO environments_by_chat (chat_id, cwd, observed_at, json)
     SELECT json_extract(json, '$.chatId'), cwd, observed_at, json FROM environments
     WHERE json_valid(json) AND coalesce(json_extract(json, '$.chatId'), '') <> '';
   DROP TABLE environments;
   ALTER TABLE environments_by_chat RENAME TO environments;
   CREATE INDEX environments_cwd ON environments (cwd, observed_at DESC);`,
];

/**
 * The schema version the work item tables arrive in. Found rather than counted, so the test that
 * upgrades into it keeps upgrading from the version before it when later migrations are added.
 */
/** The migration that priced Jev's rows from their tokens: a test starts a database from just before it */
export const JEV_COST_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes("provider = 'jev' AND cost_usd IS NULL")) + 1;
/** The version that added the spend ledger and its alerts, for the test that upgrades a database from the one before */
export const SPEND_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE spend_ledger')) + 1;
export const WORK_ITEMS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE work_item_counters')) + 1;

/** The version that added the flow's runs, for the test that upgrades a database from the one before */
export const FLOW_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE flow_runs')) + 1;
/** The version flow runs got their cause and the run a retry was for, for the test that upgrades into it */
export const FLOW_CAUSE_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('ADD COLUMN retry_of')) + 1;
/** The schema version document links arrive in, found the same way. */
export const DOCUMENT_LINKS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('ADD COLUMN document_path')) + 1;
/** The version that added the assistant's runs and proposals, found the same way */
export const ASSISTANT_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE assistant_runs')) + 1;

/** The version that added the decisions' opened_at and palette_action, for the test that upgrades into it */
export const DECISION_SIGNALS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('ADD COLUMN palette_action')) + 1;

/** The version that added the guards' event table, for the test that upgrades a database from the one before */
export const GUARD_EVENTS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE guard_events')) + 1;

/** Drops all but the newest `keep` guard events; returns how many went. */
export function pruneGuardEvents(db: DatabaseSync, keep = KEEP_GUARD_EVENTS): number {
  const result = db
    .prepare('DELETE FROM guard_events WHERE seq <= COALESCE((SELECT seq FROM guard_events ORDER BY seq DESC LIMIT 1 OFFSET ?), -1)')
    .run(keep);
  return Number(result.changes);
}

/** Drops all but the newest `keep` agent reads of teammates' copies; returns how many went. */
export function pruneAgentReads(db: DatabaseSync, keep = KEEP_AGENT_READS): number {
  const result = db
    .prepare('DELETE FROM collab_agent_reads WHERE id <= COALESCE((SELECT id FROM collab_agent_reads ORDER BY id DESC LIMIT 1 OFFSET ?), -1)')
    .run(keep);
  return Number(result.changes);
}

/** The version that added the chats' provider column, for the test that upgrades a database from the one before */
export const CHAT_PROVIDER_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE INDEX chats_provider')) + 1;

/** The version that added the chats' native session id and transcript entries, for the test that upgrades a database from the one before */
export const CHAT_ENTRIES_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE chat_entries')) + 1;

/** The version that added the code hosts' columns and tables, for the test that upgrades a database from the one before */
export const CODE_HOSTS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE host_rate_limits')) + 1;

/** The version that added the checks' snapshots and the fix columns, for the test that upgrades a database from the one before */
export const CHECKS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE change_request_snapshots')) + 1;

/** The version that added the review drafts and posts and the fix kind, for the test that upgrades a database from the one before */
export const REVIEWS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE review_drafts')) + 1;

/** The version that added the merge audit, for the test that upgrades a database from the one before */
export const MERGES_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE change_request_merges')) + 1;

/** The version that added the issues linked to work items, for the test that upgrades a database from the one before */
export const ISSUES_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE work_item_issues')) + 1;

/** The version that gave issue links their scope, for the test that upgrades a database from the one before */
export const ISSUE_SCOPE_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'function' && m.toString().includes('work_item_issues_scoped')) + 1;

/** The version that added the webhook registrations and deliveries, for the test that upgrades a database from the one before */
export const WEBHOOKS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE webhook_registrations')) + 1;

/** The version that added the provider limits and moves, for the test that upgrades a database from the one before */
export const PROVIDER_ROTATION_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE provider_moves')) + 1;

/** The migration that rewrote the values stored under the old product name: a test starts a database from just before it */
export const RENAME_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes("'$.agentryAssistant'")) + 1;

/** The migration that added the compactions and session notes: a test starts a database from just before it */
export const CONTEXT_CONTROL_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE chat_compactions')) + 1;

/** The migration that added the review gate's rounds, runs and findings: a test starts a database from just before it */
export const REVIEW_GATE_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE review_rounds')) + 1;
/** The migration that added the lessons tables: a test starts a database from just before it */
export const LESSONS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE lessons')) + 1;
/** The migration that added the instruction evals' tables: a test starts a database from just before it */
export const EVALS_V2_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE eval_judgements')) + 1;
export const EVALS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE eval_runs')) + 1;
/** The migration that added the Collaborators tables: a test starts a database from just before it */
export const COLLAB_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE collab_records')) + 1;
/** The migration that added the denied joins: a test starts a database from just before it */
export const COLLAB_DENIALS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE collab_join_denials')) + 1;

/** The migration that keyed the environments by chat: a test starts a database from just before it */
export const ENVIRONMENTS_BY_CHAT_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE environments_by_chat')) + 1;

/** The migration that gave audit rows their route: a test starts a database from just before it */
export const AUDIT_ROUTE_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('ALTER TABLE audit ADD COLUMN route')) + 1;
/** The migration that moved anonymous refusals into their own ring: a test starts a database from just before it */
export const AUDIT_REFUSALS_SCHEMA_VERSION = MIGRATIONS.findIndex((m) => typeof m === 'string' && m.includes('CREATE TABLE audit_refusals')) + 1;

/**
 * Applies the migrations a database has not run yet, up to schema version `until` (every one by
 * default). Exported so a test can build a database as an older release left it.
 */
export function migrate(db: DatabaseSync, until = MIGRATIONS.length): void {
  const target = Math.min(until, MIGRATIONS.length);
  for (;;) {
    // One transaction per migration: a failure leaves user_version behind, never half a schema.
    // IMMEDIATE, and the version read inside it: two processes opening an old database at once
    // would otherwise both read the same version and the second would run a migration again
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
      const version = row?.user_version ?? 0;
      if (version >= target) {
        db.exec('COMMIT');
        return;
      }
      const statement = MIGRATIONS[version];
      if (typeof statement === 'string') db.exec(statement);
      else if (statement) statement(db);
      db.exec(`PRAGMA user_version = ${String(version + 1)}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Command runs kept across every kind; the newest few dozen of a kind are all "usual" ever looks at. */
const KEEP_COMMANDS = 10_000;

/** Chats whose own environment is kept besides each folder's newest: a few months of chats on a busy install */
const KEEP_ENVIRONMENTS = 5_000;

/** How a command ended: `cancelled` is a person's decision, and a command that hung and was cancelled is that. */
export type CommandOutcome = 'ok' | 'error' | 'cancelled';

export interface CommandRun {
  kind: string;
  chatId: string;
  toolUseId: string;
  startedAt: string;
  durationMs: number;
  outcome: CommandOutcome;
}
/** The same for the audit log, which grows with every write a person or a worker makes. */
const KEEP_AUDIT = 50_000;
/** Pruning on every insert would cost a delete per request; this is often enough to bound it. */
const AUDIT_PRUNE_EVERY = 500;
/**
 * The anonymous refusals kept. Anyone who can reach the port writes them, so the ring is small and
 * trimmed on every insert: what it is for is the recent shape of an attack, not its whole history.
 */
const KEEP_AUDIT_REFUSALS = 1_000;
/** A path is stored up to here: a request target can be as long as the server reads, and a row should not */
export const MAX_AUDIT_PATH = 512;

const auditPath = (path: string): string => (path.length > MAX_AUDIT_PATH ? path.slice(0, MAX_AUDIT_PATH) : path);

interface JsonRow {
  json: string;
}

/** Reads a table of JSON documents, skipping a row that no longer parses. */
function readDocs<T>(db: DatabaseSync, sql: string): Array<{ row: Record<string, unknown>; doc: T }> {
  const out: Array<{ row: Record<string, unknown>; doc: T }> = [];
  for (const row of db.prepare(sql).all() as Array<Record<string, unknown>>) {
    try {
      out.push({ row, doc: JSON.parse(String(row.json)) as T });
    } catch {
      // an unreadable row cannot be carried over; it was already unreadable before
    }
  }
  return out;
}

function migrateRunsToChats(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE chats (
      id         TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      json       TEXT NOT NULL
    );
    CREATE INDEX chats_created_at ON chats (created_at DESC);
    CREATE TABLE executions (
      id         TEXT PRIMARY KEY,
      chat_id    TEXT NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
      started_at TEXT NOT NULL,
      json       TEXT NOT NULL
    );
    CREATE INDEX executions_chat ON executions (chat_id, started_at);
  `);
  const { chats, chatOf } = chatsFromRuns(readDocs<LegacyRun>(db, 'SELECT json FROM runs').map((r) => r.doc));
  const insertChat = db.prepare('INSERT INTO chats (id, created_at, json) VALUES (?, ?, ?)');
  const insertExecution = db.prepare('INSERT INTO executions (id, chat_id, started_at, json) VALUES (?, ?, ?, ?)');
  for (const { record, executions } of chats) {
    insertChat.run(record.id, record.createdAt, JSON.stringify(record));
    for (const execution of executions) insertExecution.run(execution.id, record.id, execution.startedAt, JSON.stringify(execution));
  }
  db.exec('DROP TABLE runs');

  // What pointed at a run now points at the chat that run became; a run that started nothing has
  // no chat, and what pointed at it points at nothing
  const chat = (runId: unknown): string | null => (typeof runId === 'string' ? (chatOf.get(runId) ?? null) : null);
  const updateOrchestration = db.prepare('UPDATE orchestrations SET json = ? WHERE id = ?');
  for (const { row, doc } of readDocs<Orchestration & { workflow?: { runId: string | null } | null }>(db, 'SELECT id, json FROM orchestrations')) {
    for (const task of doc.tasks) task.runId = chat(task.runId);
    if ('synthesisRunId' in doc) doc.synthesisRunId = chat(doc.synthesisRunId);
    if (doc.workflow) doc.workflow.runId = chat(doc.workflow.runId);
    updateOrchestration.run(JSON.stringify(doc), String(row.id));
  }
  // The planner's draft is found by the run that wrote it; a draft whose run left no chat has no
  // key to be found by, so it goes with it
  for (const row of db.prepare('SELECT run_id FROM plan_drafts').all() as Array<{ run_id: string }>) {
    const next = chat(row.run_id);
    if (next) db.prepare('UPDATE plan_drafts SET run_id = ? WHERE run_id = ?').run(next, row.run_id);
    else db.prepare('DELETE FROM plan_drafts WHERE run_id = ?').run(row.run_id);
  }
  const updateEnvironment = db.prepare('UPDATE environments SET json = ? WHERE cwd = ?');
  for (const { row, doc } of readDocs<Record<string, unknown>>(db, 'SELECT cwd, json FROM environments')) {
    const { runId, ...rest } = doc;
    updateEnvironment.run(JSON.stringify({ ...rest, chatId: chat(runId) ?? '' }), String(row.cwd));
  }
}

/** How long a closed provider move stays in the history. */
const KEEP_PROVIDER_MOVES_MS = 90 * 24 * 60 * 60 * 1000;

interface ProviderLimitRow {
  provider: string;
  state: string;
  binding_window: string | null;
  utilization: number | null;
  resets_at: string | null;
  windows: string;
  overage: string | null;
  observed_at: string;
  source: string;
}

function toProviderLimit(row: ProviderLimitRow): ProviderLimit {
  let windows: Record<string, RateLimitWindow> = {};
  try {
    windows = JSON.parse(row.windows) as Record<string, RateLimitWindow>;
  } catch {
    // an unreadable windows column leaves the summary fields, which is what the banner reads
  }
  let overage: ProviderLimit['overage'];
  try {
    if (row.overage) overage = JSON.parse(row.overage) as ProviderLimit['overage'];
  } catch {
    // an unreadable overage column reads as no overage news
  }
  return {
    provider: row.provider,
    state: row.state as ProviderLimit['state'],
    window: row.binding_window,
    utilization: row.utilization,
    resetsAt: row.resets_at,
    windows,
    ...(overage ? { overage } : {}),
    observedAt: row.observed_at,
    source: row.source as ProviderLimit['source'],
  };
}

interface ProviderMoveRow {
  id: string;
  at: string;
  subject_kind: string;
  subject_id: string;
  project_id: string | null;
  from_chat: string;
  to_chat: string | null;
  from_provider: string;
  to_provider: string | null;
  from_model: string | null;
  to_model: string | null;
  action: string;
  state: string;
  decided_by: string;
  decision_id: string | null;
  resets_at: string | null;
  reason: string | null;
  updated_at: string;
}

function toProviderMove(row: ProviderMoveRow): ProviderMove {
  return {
    id: row.id,
    at: row.at,
    subjectKind: row.subject_kind as ProviderMove['subjectKind'],
    subjectId: row.subject_id,
    projectId: row.project_id,
    fromChat: row.from_chat,
    toChat: row.to_chat,
    fromProvider: row.from_provider,
    toProvider: row.to_provider,
    fromModel: row.from_model,
    toModel: row.to_model,
    action: row.action as ProviderMove['action'],
    state: row.state as ProviderMove['state'],
    decidedBy: row.decided_by as ProviderMove['decidedBy'],
    decisionId: row.decision_id,
    resetsAt: row.resets_at,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
}

/** One result's row of the daily spend ledger. */
export interface SpendRow {
  at: string;
  chatId: string;
  executionId: string;
  usd: number;
  reported: boolean;
  purpose: SpendPurpose;
  account: string | null;
  accountKind: string | null;
  projectId: string | null;
  orchestrationId: string | null;
}

/** How long a claimed compaction is held before another process may take it for lost */
export const COMPACTION_LEASE_MS = 15 * 60_000;

/** A new housekeeping turn: a compaction, or a session-note turn with no compaction */
export type HousekeepingClaim =
  | {
      kind: 'compaction';
      leaseUntil: string;
      row: { id: string; origin: CompactionOrigin; focus: string | null; structuredNote: boolean; flowRunId: string | null; requestedBy: string | null; requestedAt: string };
    }
  | { kind: 'note'; leaseUntil: string; row: { id: string; source: ChatNoteSource; entryUuid: string | null; createdAt: string } };

export type CompactionPatch = Partial<{
  state: CompactionState;
  trigger: 'manual' | 'auto' | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
  costUsd: number | null;
  failure: CompactionFailure | null;
  error: string | null;
  boundaryUuid: string | null;
  noteId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  leaseUntil: string;
}>;

export type NotePatch = Partial<{
  state: ChatNoteState;
  text: string | null;
  sections: ChatSessionNote['sections'];
  compactionId: string | null;
  error: string | null;
  readyAt: string | null;
  leaseUntil: string | null;
}>;

interface CompactionRow {
  id: string;
  chat_id: string;
  origin: string;
  state: string;
  trigger_kind: string | null;
  focus: string | null;
  structured: number;
  flow_run_id: string | null;
  boundary_uuid: string | null;
  pre_tokens: number | null;
  post_tokens: number | null;
  duration_ms: number | null;
  cost_usd: number | null;
  failure: string | null;
  error: string | null;
  note_id: string | null;
  requested_at: string;
  started_at: string | null;
  ended_at: string | null;
}

function compactionOf(r: CompactionRow): ChatCompaction {
  return {
    id: r.id,
    chatId: r.chat_id,
    origin: r.origin as CompactionOrigin,
    state: r.state as CompactionState,
    trigger: r.trigger_kind === 'manual' || r.trigger_kind === 'auto' ? r.trigger_kind : null,
    focus: r.focus,
    structuredNote: r.structured !== 0,
    flowRunId: r.flow_run_id,
    preTokens: r.pre_tokens,
    postTokens: r.post_tokens,
    durationMs: r.duration_ms,
    costUsd: r.cost_usd,
    failure: r.failure as CompactionFailure | null,
    error: r.error,
    boundaryUuid: r.boundary_uuid,
    noteId: r.note_id,
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}

interface NoteRow {
  id: string;
  chat_id: string;
  source: string;
  state: string;
  text: string | null;
  sections: string | null;
  compaction_id: string | null;
  entry_uuid: string | null;
  error: string | null;
  created_at: string;
  ready_at: string | null;
}

function noteOf(r: NoteRow): ChatSessionNote {
  let sections: ChatSessionNote['sections'] = null;
  if (r.sections) {
    try {
      sections = JSON.parse(r.sections) as ChatSessionNote['sections'];
    } catch {
      // A damaged sections object costs the headings, never the note's text
    }
  }
  return {
    id: r.id,
    chatId: r.chat_id,
    source: r.source as ChatNoteSource,
    state: r.state as ChatNoteState,
    text: r.text,
    sections,
    compactionId: r.compaction_id,
    entryUuid: r.entry_uuid,
    error: r.error,
    createdAt: r.created_at,
    readyAt: r.ready_at,
  };
}

function isConstraintError(err: unknown): boolean {
  return /constraint/i.test((err as { message?: string }).message ?? '');
}

export class Db {
  private readonly db: DatabaseSync;
  private auditWrites = 0;
  private readonly movesPruneTimer: NodeJS.Timeout;

  constructor(config: CoreConfig) {
    this.db = new DatabaseSync(join(config.dataDir, 'wrapper.db'));
    // WAL lets readers run while a writer holds the lock; busy_timeout absorbs the contention
    // between processes instead of throwing SQLITE_BUSY at whoever lost the race. It goes first:
    // switching the journal mode takes a lock too, and a process opening the file while another
    // writes would otherwise fail on the spot with "database is locked".
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    migrate(this.db);
    this.pruneAudit();
    pruneWebhookDeliveries(this.db);
    pruneGuardEvents(this.db);
    pruneAgentReads(this.db);
    this.pruneProviderMoves();
    // A server that stays up for weeks prunes the history daily too; unref'd so it never keeps a process alive
    this.movesPruneTimer = setInterval(() => this.pruneProviderMoves(), 24 * 60 * 60 * 1000);
    this.movesPruneTimer.unref();
  }

  /**
   * The connection itself, for a store whose queries live in their own module (`work-items.ts`)
   * rather than growing this class: it shares the schema, the pragmas and the migrations.
   */
  get connection(): DatabaseSync {
    return this.db;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------- rotation events ----------

  /** Appends one account switch and returns it with the seq the store assigned. */
  appendRotationEvent(event: Omit<RotationEvent, 'seq'>): RotationEvent {
    const result = this.db
      .prepare('INSERT INTO rotation_events (ts, event, from_acct, to_acct, reason, detail, raw) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(event.ts, event.event, event.from, event.to, event.reason, event.detail, event.data ? JSON.stringify(event.data) : null);
    return { ...event, seq: Number(result.lastInsertRowid) };
  }

  /** Oldest first, so a panel can append them as they come; `limit` keeps the newest rows. */
  rotationEvents(opts: { limit?: number; since?: string } = {}): RotationEvent[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 200), 1), 5_000);
    const rows = this.db
      .prepare(`SELECT * FROM rotation_events ${opts.since ? 'WHERE ts > ?' : ''} ORDER BY seq DESC LIMIT ?`)
      .all(...(opts.since ? [opts.since] : []), limit) as unknown as Array<{ seq: number; ts: string; event: string; from_acct: string | null; to_acct: string | null; reason: string | null; detail: string | null; raw: string | null }>;
    return rows
      .map((r) => ({ seq: r.seq, ts: r.ts, event: r.event, from: r.from_acct, to: r.to_acct, reason: r.reason, detail: r.detail, data: r.raw ? (JSON.parse(r.raw) as Record<string, unknown>) : null }))
      .reverse();
  }

  /** Drops everything but the newest `keep` rows. Returns how many went. */
  pruneRotationEvents(keep = KEEP_ROTATION_EVENTS): number {
    const result = this.db
      .prepare('DELETE FROM rotation_events WHERE seq <= COALESCE((SELECT seq FROM rotation_events ORDER BY seq DESC LIMIT 1 OFFSET ?), -1)')
      .run(keep);
    return Number(result.changes);
  }

  // ---------- usage history ----------

  /** Appends readings; one already stored for the same account, window and instant is left as it was. */
  appendUsagePoints(points: readonly UsageHistoryPoint[]): void {
    if (!points.length) return;
    const insert = this.db.prepare('INSERT OR IGNORE INTO usage_history (account, window, at, pct) VALUES (?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const p of points) insert.run(p.account, p.window, p.at, p.pct);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** The newest reading of one account's window, so a sampler can tell whether anything moved. */
  latestUsagePoint(account: string, window: UsageHistoryPoint['window']): UsageHistoryPoint | null {
    const row = this.db
      .prepare('SELECT account, window, at, pct FROM usage_history WHERE account = ? AND window = ? ORDER BY at DESC LIMIT 1')
      .get(account, window) as unknown as UsageHistoryPoint | undefined;
    return row ? { at: row.at, pct: row.pct, window: row.window, account: String(row.account) } : null;
  }

  /** Oldest first, so a chart can draw it as it comes. `limit` keeps the newest rows of the range. */
  usageHistory(opts: { account?: string; window?: UsageHistoryPoint['window']; since?: string; until?: string; limit?: number } = {}): UsageHistoryPoint[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 5_000), 1), 50_000);
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.account !== undefined) {
      where.push('account = ?');
      params.push(opts.account);
    }
    if (opts.window) {
      where.push('window = ?');
      params.push(opts.window);
    }
    if (opts.since) {
      where.push('at >= ?');
      params.push(opts.since);
    }
    if (opts.until) {
      where.push('at <= ?');
      params.push(opts.until);
    }
    const rows = this.db
      .prepare(`SELECT account, window, at, pct FROM usage_history ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC LIMIT ?`)
      .all(...params, limit) as unknown as UsageHistoryPoint[];
    return rows.map((r) => ({ at: r.at, pct: r.pct, window: r.window, account: String(r.account) })).reverse();
  }

  /** Drops readings older than `before`. Returns how many went. */
  pruneUsageHistory(before: string): number {
    return Number(this.db.prepare('DELETE FROM usage_history WHERE at < ?').run(before).changes);
  }

  // ---------- system samples ----------

  /** Stores a reading of the machine; one at the same instant is replaced. */
  appendSystemSample(sample: SystemSample): void {
    this.db
      .prepare('INSERT OR REPLACE INTO system_samples (at, load1, total_mb, available_mb, cpu_some10, memory_some10, io_some10, chats, rss_mb, admitting) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(sample.at, sample.load1, sample.totalMb, sample.availableMb, sample.cpuSome10, sample.memorySome10, sample.ioSome10, sample.chats, sample.rssMb, sample.admitting ? 1 : 0);
  }

  /**
   * Readings oldest first. With `bucketSeconds` the rows of each bucket are folded into one at the
   * bucket's start (the largest load, pressure, chats and resident memory, the smallest available
   * memory), so a week fits a chart in a few hundred points. `limit` keeps the newest rows.
   */
  systemSamples(opts: { since?: string; until?: string; limit?: number; bucketSeconds?: number } = {}): SystemSample[] {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 2_000), 1), 20_000);
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.since) {
      where.push('at >= ?');
      params.push(opts.since);
    }
    if (opts.until) {
      where.push('at <= ?');
      params.push(opts.until);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const bucket = opts.bucketSeconds !== undefined ? Math.max(1, Math.trunc(opts.bucketSeconds)) : 0;
    const rows = (
      bucket > 0
        ? this.db
            .prepare(
              `SELECT strftime('%Y-%m-%dT%H:%M:%SZ', (CAST(strftime('%s', at) AS INTEGER) / CAST(? AS INTEGER)) * CAST(? AS INTEGER), 'unixepoch') AS bucket_at,
                      MAX(load1) AS load1, MAX(total_mb) AS total_mb, MIN(available_mb) AS available_mb,
                      MAX(cpu_some10) AS cpu_some10, MAX(memory_some10) AS memory_some10, MAX(io_some10) AS io_some10,
                      MAX(chats) AS chats, MAX(rss_mb) AS rss_mb, MIN(admitting) AS admitting
                 FROM system_samples ${clause} GROUP BY CAST(strftime('%s', at) AS INTEGER) / CAST(? AS INTEGER) ORDER BY bucket_at DESC LIMIT ?`,
            )
            .all(bucket, bucket, ...params, bucket, limit)
        : this.db.prepare(`SELECT * FROM system_samples ${clause} ORDER BY at DESC LIMIT ?`).all(...params, limit)
    ) as unknown as Array<Record<string, string | number | null>>;
    return rows
      .map((r): SystemSample => ({
        at: String(r.bucket_at ?? r.at),
        load1: r.load1 as number | null,
        totalMb: r.total_mb as number | null,
        availableMb: r.available_mb as number | null,
        cpuSome10: r.cpu_some10 as number | null,
        memorySome10: r.memory_some10 as number | null,
        ioSome10: r.io_some10 as number | null,
        chats: Number(r.chats),
        rssMb: r.rss_mb as number | null,
        admitting: r.admitting === 1,
      }))
      .reverse();
  }

  /** Drops readings older than `before`. Returns how many went. */
  pruneSystemSamples(before: string): number {
    return Number(this.db.prepare('DELETE FROM system_samples WHERE at < ?').run(before).changes);
  }

  // ---------- audit log ----------

  /**
   * Appends one mutating request. The caller builds the summary from the route, never from the body.
   * `route` is left out by what the wrapper records on its own, whose summary is a sentence of its own.
   */
  appendAudit(entry: Omit<AuditEntry, 'id' | 'route'> & { route?: string | null }): AuditEntry {
    const route = entry.route ?? null;
    const path = auditPath(entry.path);
    const result = this.db
      .prepare('INSERT INTO audit (at, actor, method, path, status, summary, route) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(entry.at, entry.actor, entry.method, path, entry.status, entry.summary, route);
    if (++this.auditWrites % AUDIT_PRUNE_EVERY === 0) this.pruneAudit();
    return { ...entry, path, route, id: String(result.lastInsertRowid) };
  }

  /**
   * Appends a write refused before its caller was identified (`anonymous`). Kept apart from the log,
   * in a ring trimmed to its newest rows on every insert, so a flood of them evicts only itself.
   */
  appendAuditRefusal(entry: Omit<AuditEntry, 'id' | 'route'> & { route?: string | null }): AuditEntry {
    const route = entry.route ?? null;
    const path = auditPath(entry.path);
    const result = this.db
      .prepare('INSERT INTO audit_refusals (at, actor, method, path, status, summary, route) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(entry.at, entry.actor, entry.method, path, entry.status, entry.summary, route);
    this.db.prepare('DELETE FROM audit_refusals WHERE id <= ?').run(Number(result.lastInsertRowid) - KEEP_AUDIT_REFUSALS);
    return { ...entry, path, route, id: String(result.lastInsertRowid) };
  }

  /**
   * Newest first. `path` matches anywhere in the path, which is how the panel filters by route;
   * `method` and `status` narrow it further, and every filter narrows `total` with the page.
   */
  auditPage(opts: { limit?: number; from?: number } & AuditFilter = {}): AuditPage {
    return this.auditTablePage('audit', opts);
  }

  /** The anonymous refusals, newest first, with the filters and paging of `auditPage` */
  auditRefusalsPage(opts: { limit?: number; from?: number } & AuditFilter = {}): AuditPage {
    return this.auditTablePage('audit_refusals', opts);
  }

  private auditTablePage(table: 'audit' | 'audit_refusals', opts: { limit?: number; from?: number } & AuditFilter): AuditPage {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 500);
    const from = Math.max(Math.trunc(opts.from ?? 0), 0);
    const clauses: string[] = [];
    const params: SQLInputValue[] = [];
    const path = opts.path?.trim();
    if (path) {
      // Paths hold `_` in ids and `%` in encoded segments, which LIKE would read as wildcards
      clauses.push("path LIKE ? ESCAPE '\\'");
      params.push(`%${path.replace(/[\\%_]/g, '\\$&')}%`);
    }
    const method = opts.method?.trim();
    if (method) {
      clauses.push('method = ?');
      params.push(method.toUpperCase());
    }
    const status = opts.status?.trim();
    if (status) {
      const range = statusRange(status);
      clauses.push('status BETWEEN ? AND ?');
      params.push(range[0], range[1]);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...params) as { n: number } | undefined;
    const rows = this.db
      .prepare(`SELECT * FROM ${table} ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, from) as unknown as Array<{ id: number; at: string; actor: string; method: string; path: string; status: number; summary: string; route: string | null }>;
    return {
      entries: rows.map((row) => ({ ...row, id: String(row.id), route: row.route ?? null })),
      total: totalRow?.n ?? 0,
      from,
    };
  }

  /** Drops everything but the newest `keep` rows. Returns how many went. */
  pruneAudit(keep = KEEP_AUDIT): number {
    const result = this.db
      .prepare('DELETE FROM audit WHERE id <= COALESCE((SELECT id FROM audit ORDER BY id DESC LIMIT 1 OFFSET ?), -1)')
      .run(keep);
    return Number(result.changes);
  }

  // ---------- chats, executions and orchestrations ----------

  /**
   * Upserts the records this process owns, in one transaction. It never clears the table first:
   * rows another wrapper process wrote are not ours to drop.
   */
  private saveDocs(table: 'orchestrations', docs: Array<{ id: string; createdAt: string; value: unknown }>): void {
    const upsert = this.db.prepare(
      `INSERT INTO ${table} (id, created_at, json) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, json = excluded.json`,
    );
    this.tx(() => {
      for (const doc of docs) upsert.run(doc.id, doc.createdAt, JSON.stringify(doc.value));
    });
  }

  private loadDocs<T>(table: 'orchestrations'): T[] {
    const rows = this.db.prepare(`SELECT json FROM ${table} ORDER BY created_at DESC`).all() as unknown as JsonRow[];
    const out: T[] = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.json) as T);
      } catch {
        // one unreadable row must not cost the caller the rest of its history
      }
    }
    return out;
  }

  /**
   * Saves the given chats with their executions and trims the table to the newest `keep` chats by
   * creation time; the executions of a chat that goes, go with it. With `keep` null nothing is
   * trimmed: only a new chat can push an old one out.
   */
  saveChats(chats: StoredChat[], keep: number | null): void {
    const upsertChat = this.db.prepare(
      `INSERT INTO chats (id, created_at, provider, json) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, provider = excluded.provider, json = excluded.json`,
    );
    const upsertExecution = this.db.prepare(
      `INSERT INTO executions (id, chat_id, started_at, json) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, json = excluded.json`,
    );
    this.tx(() => {
      for (const { record, executions } of chats) {
        const provider = record.provider ?? LEGACY_PROVIDER;
        upsertChat.run(record.id, record.createdAt, provider, JSON.stringify({ ...record, provider }));
        for (const execution of executions) upsertExecution.run(execution.id, record.id, execution.startedAt, JSON.stringify(execution));
      }
      if (keep !== null) this.db.prepare('DELETE FROM chats WHERE id NOT IN (SELECT id FROM chats ORDER BY created_at DESC LIMIT ?)').run(keep);
    });
  }

  deleteChat(id: string): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM chats WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM chat_entries WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM chat_compactions WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM chat_notes WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM chat_uploads WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM chat_upload_scans WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM openai_conversations WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM openai_responses WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM openai_chat_prompts WHERE chat_id = ?').run(id);
      this.db.prepare('DELETE FROM environments WHERE chat_id = ?').run(id);
    });
  }

  // ---------- uploads a chat's messages attached ----------

  /** Keeps the first time each upload was attached to the chat: a later message naming it again changes nothing */
  addChatUploads(chatId: string, uploadIds: readonly string[], at: string): void {
    if (uploadIds.length === 0) return;
    this.tx(() => this.insertChatUploads(chatId, uploadIds, at));
  }

  private insertChatUploads(chatId: string, uploadIds: readonly string[], at: string): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO chat_uploads (chat_id, upload_id, attached_at) VALUES (?, ?, ?)');
    for (const id of uploadIds) insert.run(chatId, id, at);
  }

  /** The chat's uploads, oldest attachment first */
  chatUploads(chatId: string): Array<{ uploadId: string; attachedAt: string }> {
    return (
      this.db.prepare('SELECT upload_id, attached_at FROM chat_uploads WHERE chat_id = ? ORDER BY attached_at, upload_id').all(chatId) as Array<{ upload_id: string; attached_at: string }>
    ).map((row) => ({ uploadId: row.upload_id, attachedAt: row.attached_at }));
  }

  chatUploadsScanned(chatId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM chat_upload_scans WHERE chat_id = ?').get(chatId);
  }

  /** The uploads a chat's transcript names, found once, and the mark that it was looked through */
  markChatUploadsScanned(chatId: string, uploadIds: readonly string[], at: string): void {
    this.tx(() => {
      this.insertChatUploads(chatId, uploadIds, at);
      this.db.prepare('INSERT OR IGNORE INTO chat_upload_scans (chat_id, scanned_at) VALUES (?, ?)').run(chatId, at);
    });
  }

  // ---------- context control: compactions and session notes ----------

  /**
   * Takes the chat's one housekeeping slot (a compaction or a note turn) in a single IMMEDIATE
   * transaction, so a second process cannot slip in between the check and the insert. An open row
   * whose lease has passed is closed as lost first; null when another open one remains.
   */
  claimHousekeeping(chatId: string, claim: HousekeepingClaim, now: string): ChatCompaction | ChatSessionNote | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.closeExpired(now, chatId);
      const open = this.db
        .prepare("SELECT 1 FROM chat_compactions WHERE chat_id = ? AND state IN ('requested', 'running') UNION ALL SELECT 1 FROM chat_notes WHERE chat_id = ? AND state = 'pending'")
        .get(chatId, chatId);
      if (open) {
        this.db.exec('COMMIT');
        return null;
      }
      if (claim.kind === 'compaction') {
        const c = claim.row;
        this.db
          .prepare(
            `INSERT INTO chat_compactions (id, chat_id, origin, state, focus, structured, flow_run_id, requested_by, requested_at, lease_until)
             VALUES (?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?)`,
          )
          .run(c.id, chatId, c.origin, c.focus, c.structuredNote ? 1 : 0, c.flowRunId, c.requestedBy, c.requestedAt, claim.leaseUntil);
      } else {
        const n = claim.row;
        this.db
          .prepare("INSERT INTO chat_notes (id, chat_id, source, state, entry_uuid, created_at, lease_until) VALUES (?, ?, ?, 'pending', ?, ?, ?)")
          .run(n.id, chatId, n.source, n.entryUuid, n.createdAt, claim.leaseUntil);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      // The unique indexes are the second line of defence: losing that race means another one is open
      if (isConstraintError(err)) return null;
      throw err;
    }
    return claim.kind === 'compaction' ? this.compactionById(claim.row.id) : this.noteById(claim.row.id);
  }

  /** Closes the open rows whose lease has passed (every chat, or one); the caller holds the write lock */
  private closeExpired(now: string, chatId?: string): void {
    const scope = chatId === undefined ? '' : ' AND chat_id = ?';
    const args = chatId === undefined ? [] : [chatId];
    this.db
      .prepare(`UPDATE chat_compactions SET state = 'failed', failure = 'lost', ended_at = ? WHERE state IN ('requested', 'running') AND lease_until <= ?${scope}`)
      .run(now, now, ...args);
    this.db
      .prepare(`UPDATE chat_notes SET state = 'failed', error = 'lost' WHERE state = 'pending' AND lease_until IS NOT NULL AND lease_until <= ?${scope}`)
      .run(now, ...args);
  }

  /** At boot: closes what a dead process left open. A row still inside its lease may be the other process's and stays. */
  sweepHousekeeping(now: string): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.closeExpired(now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** A guarded update: only a row still in one of the `from` states changes. Returns whether it did. */
  updateCompaction(id: string, patch: CompactionPatch, guard: { from: CompactionState[] }): boolean {
    if (guard.from.length === 0) return false;
    const columns: Record<keyof CompactionPatch, string> = {
      state: 'state', trigger: 'trigger_kind', preTokens: 'pre_tokens', postTokens: 'post_tokens', durationMs: 'duration_ms',
      costUsd: 'cost_usd', failure: 'failure', error: 'error', boundaryUuid: 'boundary_uuid', noteId: 'note_id',
      startedAt: 'started_at', endedAt: 'ended_at', leaseUntil: 'lease_until',
    };
    const sets: string[] = [];
    const args: Array<string | number | null> = [];
    for (const key of Object.keys(columns) as Array<keyof CompactionPatch>) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${columns[key]} = ?`);
      args.push(value);
    }
    if (sets.length === 0) return false;
    const marks = guard.from.map(() => '?').join(', ');
    try {
      const result = this.db.prepare(`UPDATE chat_compactions SET ${sets.join(', ')} WHERE id = ? AND state IN (${marks})`).run(...args, id, ...guard.from);
      return Number(result.changes) > 0;
    } catch (err) {
      // A boundary already recorded by another row: this one did not change
      if (isConstraintError(err)) return false;
      throw err;
    }
  }

  compactionById(id: string): ChatCompaction | null {
    const row = this.db.prepare('SELECT * FROM chat_compactions WHERE id = ?').get(id) as CompactionRow | undefined;
    return row ? compactionOf(row) : null;
  }

  /** The chat's compactions, newest first */
  compactions(chatId: string, limit = 50): ChatCompaction[] {
    const rows = this.db.prepare('SELECT * FROM chat_compactions WHERE chat_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT ?').all(chatId, limit) as unknown as CompactionRow[];
    return rows.map(compactionOf);
  }

  openCompaction(chatId: string): ChatCompaction | null {
    const row = this.db.prepare("SELECT * FROM chat_compactions WHERE chat_id = ? AND state IN ('requested', 'running')").get(chatId) as CompactionRow | undefined;
    return row ? compactionOf(row) : null;
  }

  compactionByBoundary(uuid: string): ChatCompaction | null {
    const row = this.db.prepare('SELECT * FROM chat_compactions WHERE boundary_uuid = ?').get(uuid) as CompactionRow | undefined;
    return row ? compactionOf(row) : null;
  }

  /**
   * Records a compaction the CLI did on its own (auto-compaction, or one typed in the terminal): it is
   * already over, so it takes no slot. False when its boundary is already recorded.
   */
  insertCompaction(row: ChatCompaction): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO chat_compactions (id, chat_id, origin, state, trigger_kind, focus, structured, flow_run_id, boundary_uuid, pre_tokens, post_tokens, duration_ms, cost_usd, failure, error, note_id, requested_at, started_at, ended_at, lease_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(
        row.id, row.chatId, row.origin, row.state, row.trigger, row.focus, row.structuredNote ? 1 : 0, row.flowRunId, row.boundaryUuid,
        row.preTokens, row.postTokens, row.durationMs, row.costUsd, row.failure, row.error, row.noteId, row.requestedAt, row.startedAt, row.endedAt,
        row.endedAt ?? row.requestedAt,
      );
    return Number(result.changes) > 0;
  }

  /** Stores a note that needs no turn (a saved summary); false when that entry already has one */
  insertNote(note: ChatSessionNote): boolean {
    try {
      this.db
        .prepare('INSERT INTO chat_notes (id, chat_id, source, state, text, sections, compaction_id, entry_uuid, error, created_at, ready_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(note.id, note.chatId, note.source, note.state, note.text, note.sections ? JSON.stringify(note.sections) : null, note.compactionId, note.entryUuid, note.error, note.createdAt, note.readyAt);
      return true;
    } catch (err) {
      if (isConstraintError(err)) return false;
      throw err;
    }
  }

  /** Guarded like `updateCompaction`: only a note still in one of the `from` states changes */
  updateNote(id: string, patch: NotePatch, guard: { from: ChatNoteState[] }): boolean {
    if (guard.from.length === 0) return false;
    const sets: string[] = [];
    const args: Array<string | null> = [];
    const put = (column: string, value: string | null | undefined) => {
      if (value === undefined) return;
      sets.push(`${column} = ?`);
      args.push(value);
    };
    put('state', patch.state);
    put('text', patch.text);
    put('sections', patch.sections === undefined || patch.sections === null ? patch.sections : JSON.stringify(patch.sections));
    put('compaction_id', patch.compactionId);
    put('error', patch.error);
    put('ready_at', patch.readyAt);
    put('lease_until', patch.leaseUntil);
    if (sets.length === 0) return false;
    const marks = guard.from.map(() => '?').join(', ');
    try {
      const result = this.db.prepare(`UPDATE chat_notes SET ${sets.join(', ')} WHERE id = ? AND state IN (${marks})`).run(...args, id, ...guard.from);
      return Number(result.changes) > 0;
    } catch (err) {
      if (isConstraintError(err)) return false;
      throw err;
    }
  }

  noteById(id: string): ChatSessionNote | null {
    const row = this.db.prepare('SELECT * FROM chat_notes WHERE id = ?').get(id) as NoteRow | undefined;
    return row ? noteOf(row) : null;
  }

  /** The chat's notes, newest first */
  notes(chatId: string, limit = 50): ChatSessionNote[] {
    const rows = this.db.prepare('SELECT * FROM chat_notes WHERE chat_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(chatId, limit) as unknown as NoteRow[];
    return rows.map(noteOf);
  }

  deleteNote(chatId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM chat_notes WHERE chat_id = ? AND id = ?').run(chatId, id).changes) > 0;
  }

  /** Records the id the provider gave a chat's session; `saveChats` leaves the column alone, so it outlives a re-save. */
  setNativeSessionId(chatId: string, nativeSessionId: string | null): void {
    this.db.prepare('UPDATE chats SET native_session_id = ? WHERE id = ?').run(nativeSessionId, chatId);
  }

  /** The provider's own session id for a chat; null for a Claude chat, or one not stored. */
  nativeSessionId(chatId: string): string | null {
    const row = this.db.prepare('SELECT native_session_id FROM chats WHERE id = ?').get(chatId) as { native_session_id: string | null } | undefined;
    return row?.native_session_id ?? null;
  }

  /**
   * Appends entries to a chat's transcript. An entry whose `seq` is already stored is skipped, so a
   * second process replaying the same entries cannot duplicate them. Returns how many were new.
   */
  appendChatEntries(chatId: string, entries: ReadonlyArray<{ seq: number; at: string; entry: unknown }>): number {
    const insert = this.db.prepare('INSERT INTO chat_entries (chat_id, seq, at, entry) VALUES (?, ?, ?, ?) ON CONFLICT(chat_id, seq) DO NOTHING');
    let added = 0;
    this.tx(() => {
      for (const e of entries) added += Number(insert.run(chatId, e.seq, e.at, JSON.stringify(e.entry)).changes);
    });
    return added;
  }

  /** A chat's transcript entries in order, from `afterSeq` (exclusive) when given. An unreadable entry is skipped. */
  chatEntries(chatId: string, afterSeq = -1): Array<{ seq: number; at: string; entry: unknown }> {
    const rows = this.db.prepare('SELECT seq, at, entry FROM chat_entries WHERE chat_id = ? AND seq > ? ORDER BY seq ASC').all(chatId, afterSeq) as unknown as Array<{ seq: number; at: string; entry: string }>;
    const out: Array<{ seq: number; at: string; entry: unknown }> = [];
    for (const row of rows) {
      try {
        out.push({ seq: row.seq, at: row.at, entry: JSON.parse(row.entry) });
      } catch {
        // one unreadable entry leaves a gap, not a lost transcript
      }
    }
    return out;
  }

  // ---------- provider limits and moves ----------

  /**
   * Records a provider's limit reading. An older reading never overwrites a newer one, whichever
   * process writes last. Returns whether the row changed.
   */
  upsertProviderLimit(limit: ProviderLimit): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO provider_limits (provider, state, binding_window, utilization, resets_at, windows, overage, observed_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider) DO UPDATE SET
           state = excluded.state, binding_window = excluded.binding_window, utilization = excluded.utilization,
           resets_at = excluded.resets_at, windows = excluded.windows, overage = excluded.overage, observed_at = excluded.observed_at, source = excluded.source
         WHERE excluded.observed_at >= provider_limits.observed_at`,
      )
      .run(limit.provider, limit.state, limit.window, limit.utilization, limit.resetsAt, JSON.stringify(limit.windows), limit.overage ? JSON.stringify(limit.overage) : null, limit.observedAt, limit.source);
    return Number(result.changes) > 0;
  }

  /** Every stored limit reading, by provider id. */
  providerLimits(): ProviderLimit[] {
    const rows = this.db.prepare('SELECT * FROM provider_limits ORDER BY provider').all() as unknown as ProviderLimitRow[];
    return rows.map(toProviderLimit);
  }

  providerLimit(provider: string): ProviderLimit | null {
    const row = this.db.prepare('SELECT * FROM provider_limits WHERE provider = ?').get(provider) as unknown as ProviderLimitRow | undefined;
    return row ? toProviderLimit(row) : null;
  }

  /**
   * Records a move. Returns false, and writes nothing, when the chat already has an open wait and
   * this one is open too: two processes cannot both arm a wait for one chat.
   */
  insertProviderMove(move: ProviderMove): boolean {
    const result = this.db
      .prepare(
        `INSERT INTO provider_moves (id, at, subject_kind, subject_id, project_id, from_chat, to_chat, from_provider, to_provider,
           from_model, to_model, action, state, decided_by, decision_id, resets_at, reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        move.id, move.at, move.subjectKind, move.subjectId, move.projectId, move.fromChat, move.toChat, move.fromProvider, move.toProvider,
        move.fromModel, move.toModel, move.action, move.state, move.decidedBy, move.decisionId, move.resetsAt, move.reason, move.updatedAt,
      );
    return Number(result.changes) > 0;
  }

  providerMove(id: string): ProviderMove | null {
    const row = this.db.prepare('SELECT * FROM provider_moves WHERE id = ?').get(id) as unknown as ProviderMoveRow | undefined;
    return row ? toProviderMove(row) : null;
  }

  /** Newest first. `chatId` matches either end of a move. */
  providerMoves(filter: { chatId?: string; projectId?: string; subjectKind?: string; subjectId?: string; state?: ProviderMoveState; limit?: number } = {}): ProviderMove[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.chatId) {
      where.push('(from_chat = ? OR to_chat = ?)');
      params.push(filter.chatId, filter.chatId);
    }
    if (filter.projectId) {
      where.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (filter.subjectKind) {
      where.push('subject_kind = ?');
      params.push(filter.subjectKind);
    }
    if (filter.subjectId) {
      where.push('subject_id = ?');
      params.push(filter.subjectId);
    }
    if (filter.state) {
      where.push('state = ?');
      params.push(filter.state);
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    const rows = this.db
      .prepare(`SELECT * FROM provider_moves ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(...params, limit) as unknown as ProviderMoveRow[];
    return rows.map(toProviderMove);
  }

  /** Waits not yet resumed, and resumes whose claim ran out: what a start-up replays. Oldest first. */
  openProviderMoves(now: string): ProviderMove[] {
    const rows = this.db
      .prepare("SELECT * FROM provider_moves WHERE state = 'waiting' OR (state = 'resuming' AND (claimed_until IS NULL OR claimed_until < ?)) ORDER BY at, id")
      .all(now) as unknown as ProviderMoveRow[];
    return rows.map(toProviderMove);
  }

  /**
   * Takes a wait for replay. One UPDATE decides, so of two processes racing for one wait only the
   * one that changed the row gets true. A claim that ran out can be taken again.
   */
  claimProviderMove(id: string, now: string, claimedUntil: string): boolean {
    const result = this.db
      .prepare("UPDATE provider_moves SET state = 'resuming', claimed_until = ?, updated_at = ? WHERE id = ? AND (state = 'waiting' OR (state = 'resuming' AND claimed_until < ?))")
      .run(claimedUntil, now, id, now);
    return Number(result.changes) > 0;
  }

  /**
   * Closes an open move (`waiting` or `resuming`) as `moved`, `resumed`, `failed` or `cancelled`.
   * Returns false when it was not open any more, so a cancel racing a resume has one winner.
   */
  closeProviderMove(id: string, state: Exclude<ProviderMoveState, 'waiting' | 'resuming'>, now: string, patch: { toChat?: string | null; toProvider?: string | null; toModel?: string | null; reason?: string | null } = {}): boolean {
    const result = this.db
      .prepare(
        `UPDATE provider_moves SET state = ?, claimed_until = NULL, updated_at = ?,
           to_chat = COALESCE(?, to_chat), to_provider = COALESCE(?, to_provider), to_model = COALESCE(?, to_model), reason = COALESCE(?, reason)
         WHERE id = ? AND state IN ('waiting', 'resuming')`,
      )
      .run(state, now, patch.toChat ?? null, patch.toProvider ?? null, patch.toModel ?? null, patch.reason ?? null, id);
    return Number(result.changes) > 0;
  }

  /** Drops closed moves last touched before `before` (90 days ago by default); an open wait is never dropped. */
  pruneProviderMoves(before = new Date(Date.now() - KEEP_PROVIDER_MOVES_MS).toISOString()): number {
    const result = this.db.prepare("DELETE FROM provider_moves WHERE updated_at < ? AND state NOT IN ('waiting', 'resuming')").run(before);
    return Number(result.changes);
  }

  /** Which of `ids` are stored now: a trim, ours or another process's, may have taken one since it was saved. */
  storedChats(ids: readonly string[]): Set<string> {
    const found = new Set<string>();
    const has = this.db.prepare('SELECT 1 FROM chats WHERE id = ?');
    for (const id of ids) if (has.get(id)) found.add(id);
    return found;
  }

  /** Newest chat first, each with its executions oldest first. */
  loadChats(): StoredChat[] {
    const byChat = new Map<string, Execution[]>();
    const executions = this.db.prepare('SELECT chat_id, json FROM executions ORDER BY started_at ASC').all() as unknown as Array<JsonRow & { chat_id: string }>;
    for (const row of executions) {
      try {
        const list = byChat.get(row.chat_id) ?? [];
        list.push(JSON.parse(row.json) as Execution);
        byChat.set(row.chat_id, list);
      } catch {
        // an execution that cannot be read leaves a gap in the history, not in the chat
      }
    }
    const out: StoredChat[] = [];
    for (const row of this.db.prepare('SELECT provider, json FROM chats ORDER BY created_at DESC').all() as unknown as Array<JsonRow & { provider: string }>) {
      try {
        // The column is the truth; the JSON copy follows it
        const record = { ...(JSON.parse(row.json) as ChatRecord), provider: row.provider };
        out.push({ record, executions: byChat.get(record.id) ?? [] });
      } catch {
        // one unreadable row must not cost the caller the rest of its history
      }
    }
    return out;
  }

  /** When a stored chat was last heard from, which is when an execution a restart cut off stopped. */
  chatUpdatedAt(id: string): string | null {
    const row = this.db.prepare('SELECT json FROM chats WHERE id = ?').get(id) as JsonRow | undefined;
    if (!row) return null;
    try {
      return (JSON.parse(row.json) as ChatRecord).updatedAt;
    } catch {
      return null;
    }
  }

  saveOrchestrations(items: Orchestration[]): void {
    this.saveDocs(
      'orchestrations',
      items.map((item) => ({ id: item.id, createdAt: item.createdAt, value: item })),
    );
  }

  deleteOrchestration(id: string): void {
    this.db.prepare('DELETE FROM orchestrations WHERE id = ?').run(id);
  }

  loadOrchestrations(): Orchestration[] {
    return this.loadDocs<Orchestration>('orchestrations');
  }

  // ---------- daily spend ledger ----------

  addSpend(row: SpendRow): void {
    this.db
      .prepare(
        `INSERT INTO spend_ledger (at, chat_id, execution_id, usd, reported, purpose, account, account_kind, project_id, orchestration_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(row.at, row.chatId, row.executionId, row.usd, row.reported ? 1 : 0, row.purpose, row.account, row.accountKind, row.projectId, row.orchestrationId);
  }

  /** What the ledger holds in `[from, to)`, by purpose and account kind, and how many results carried no cost. */
  spendBetween(from: string, to: string): { groups: Array<{ purpose: string; accountKind: string | null; usd: number }>; unreported: number } {
    const groups = (
      this.db.prepare('SELECT purpose, account_kind, SUM(usd) AS usd FROM spend_ledger WHERE at >= ? AND at < ? GROUP BY purpose, account_kind').all(from, to) as Array<{
        purpose: string;
        account_kind: string | null;
        usd: number;
      }>
    ).map((g) => ({ purpose: g.purpose, accountKind: g.account_kind, usd: g.usd }));
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM spend_ledger WHERE at >= ? AND at < ? AND reported = 0').get(from, to) as { n: number };
    return { groups, unreported: n };
  }

  /** True only for the process that wrote the row: the alert of that day and level is its to raise. */
  addSpendAlert(day: string, level: string): boolean {
    return this.db.prepare('INSERT OR IGNORE INTO spend_alerts (day, level, at) VALUES (?, ?, ?)').run(day, level, new Date().toISOString()).changes === 1;
  }

  /** Drops what is older than the cutoff: only today's rows decide anything. */
  pruneSpend(before: string, beforeDay: string): void {
    this.db.prepare('DELETE FROM spend_ledger WHERE at < ?').run(before);
    this.db.prepare('DELETE FROM spend_alerts WHERE day < ?').run(beforeDay);
  }

  // ---------- model context windows ----------

  saveModelWindow(model: string, context: number): void {
    this.db
      .prepare(
        `INSERT INTO model_windows (model, context, observed_at) VALUES (?, ?, ?)
         ON CONFLICT(model) DO UPDATE SET context = excluded.context, observed_at = excluded.observed_at`,
      )
      .run(model, context, new Date().toISOString());
  }

  /** The window the CLI last reported for this exact model id; null when it never has. */
  modelWindow(model: string): number | null {
    const row = this.db.prepare('SELECT context FROM model_windows WHERE model = ?').get(model) as { context: number } | undefined;
    return row?.context ?? null;
  }

  // ---------- command durations ----------

  /** Records one command that ended; a call already recorded (a replayed event) is left as it was. */
  recordCommand(run: CommandRun): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO command_durations (kind, chat_id, tool_use_id, started_at, duration_ms, outcome)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(run.kind, run.chatId, run.toolUseId, run.startedAt, Math.round(run.durationMs), run.outcome);
    // Old runs say little about how long a command takes now, and the table must not grow for ever
    this.db.prepare('DELETE FROM command_durations WHERE id <= (SELECT MAX(id) FROM command_durations) - ?').run(KEEP_COMMANDS);
  }

  /** The newest runs of a kind, newest first. */
  commandRuns(kind: string, limit = 50): Array<{ durationMs: number; outcome: CommandOutcome; startedAt: string }> {
    const rows = this.db
      .prepare('SELECT duration_ms, outcome, started_at FROM command_durations WHERE kind = ? ORDER BY id DESC LIMIT ?')
      .all(kind, Math.min(Math.max(Math.trunc(limit), 1), 500)) as unknown as Array<{ duration_ms: number; outcome: CommandOutcome; started_at: string }>;
    return rows.map((r) => ({ durationMs: r.duration_ms, outcome: r.outcome, startedAt: r.started_at }));
  }

  // ---------- effective environments ----------

  /**
   * A chat's latest snapshot: one row per chat, replaced by each of its processes. Past `keep` rows,
   * not counting each folder's newest, the oldest go, so the table does not grow with every chat ever
   * started; a chat whose row went shows its folder's last, labelled as such.
   */
  saveEnvironment(env: EffectiveEnvironment, keep = KEEP_ENVIRONMENTS): void {
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO environments (chat_id, cwd, observed_at, json) VALUES (?, ?, ?, ?)
           ON CONFLICT(chat_id) DO UPDATE SET cwd = excluded.cwd, observed_at = excluded.observed_at, json = excluded.json`,
        )
        .run(env.chatId, env.cwd, env.observedAt, JSON.stringify(env));
      this.db
        .prepare(
          `DELETE FROM environments WHERE chat_id IN (
             SELECT chat_id FROM environments e
             WHERE observed_at < (SELECT MAX(observed_at) FROM environments WHERE cwd = e.cwd)
             ORDER BY observed_at DESC LIMIT -1 OFFSET ?
           )`,
        )
        .run(keep);
    });
  }

  /** What a chat's last process loaded; null when no process of it started here */
  environmentOf(chatId: string): EffectiveEnvironment | null {
    const row = this.db.prepare('SELECT json FROM environments WHERE chat_id = ?').get(chatId) as { json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.json) as EffectiveEnvironment;
    } catch {
      return null;
    }
  }

  /** Each folder's latest snapshot, newest first: what a folder's panel shows before a chat starts there */
  loadEnvironments(): EffectiveEnvironment[] {
    const rows = this.db
      .prepare(
        `SELECT json FROM environments e
         WHERE observed_at = (SELECT MAX(observed_at) FROM environments WHERE cwd = e.cwd)
         ORDER BY observed_at DESC`,
      )
      .all() as unknown as Array<{ json: string }>;
    const out: EffectiveEnvironment[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      try {
        const env = JSON.parse(row.json) as EffectiveEnvironment;
        // Two chats observed at the same instant in one folder: the first is the folder's
        if (seen.has(env.cwd)) continue;
        seen.add(env.cwd);
        out.push(env);
      } catch {
        // an unreadable row just drops out of the panel
      }
    }
    return out;
  }

  // ---------- planner drafts ----------

  savePlanDraft(runId: string, draft: OrchestrationSpec): void {
    this.db
      .prepare(
        `INSERT INTO plan_drafts (run_id, created_at, objective, json) VALUES (?, ?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET objective = excluded.objective, json = excluded.json`,
      )
      .run(runId, new Date().toISOString(), draft.objective ?? null, JSON.stringify(draft));
  }

  planDraft(runId: string): OrchestrationSpec | null {
    const row = this.db.prepare('SELECT json FROM plan_drafts WHERE run_id = ?').get(runId) as { json: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.json) as OrchestrationSpec;
    } catch {
      return null;
    }
  }

  /** Newest first, for the picker that lets a lost plan be recovered instead of re-planned. */
  planDrafts(limit = 20): PlanDraftSummary[] {
    const rows = this.db
      .prepare('SELECT run_id, created_at, objective, json FROM plan_drafts ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Math.max(Math.trunc(limit), 1), 100)) as unknown as Array<{
      run_id: string;
      created_at: string;
      objective: string | null;
      json: string;
    }>;
    const out: PlanDraftSummary[] = [];
    for (const row of rows) {
      try {
        const spec = JSON.parse(row.json) as OrchestrationSpec;
        out.push({
          runId: row.run_id,
          createdAt: row.created_at,
          name: spec.name,
          objective: row.objective,
          taskCount: spec.tasks.length,
        });
      } catch {
        // a row we can no longer read is not worth failing the list over
      }
    }
    return out;
  }

  // ---------- supervisor proposals ----------

  /** False when the chat already has one for that occurrence of the signal: the supervisor answers each once. */
  saveProposal(p: SupervisorProposal): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO supervisor_proposals (id, chat_id, task_id, orchestration_id, signal, occurrence, agent, hint, cost_usd, at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.chatId, p.taskId ?? null, p.orchestrationId ?? null, p.signal, p.occurrence ?? '', p.agent ? JSON.stringify(p.agent) : null, p.hint, p.costUsd, p.at, p.status);
    return Number(result.changes) > 0;
  }

  proposal(id: string): SupervisorProposal | null {
    const row = this.db.prepare('SELECT * FROM supervisor_proposals WHERE id = ?').get(id) as ProposalRow | undefined;
    return row ? proposalOf(row) : null;
  }

  /** The chat's proposals, newest first. */
  proposalsOf(chatId: string): SupervisorProposal[] {
    const rows = this.db.prepare('SELECT * FROM supervisor_proposals WHERE chat_id = ? ORDER BY at DESC').all(chatId) as unknown as ProposalRow[];
    return rows.map(proposalOf);
  }

  /** Moves a proposal on from `proposed`; false when it had already been sent or dismissed. */
  settleProposal(id: string, status: Exclude<SupervisorProposalStatus, 'proposed'>): boolean {
    const result = this.db.prepare("UPDATE supervisor_proposals SET status = ? WHERE id = ? AND status = 'proposed'").run(status, id);
    return Number(result.changes) > 0;
  }

  // ---------- decisions ----------

  /** Stores a decision as the engine recorded it; the engine picks the id and the time. */
  insertDecision(d: DecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO decisions (id, point, kind, project_id, subject_kind, subject_id, provider, model, mode, status, unavailable,
           state, questions, answers, confidence, threshold, acted, visible, saved_run, latency_ms, input_tokens, cost_usd,
           outcome, agreed, resolved_at, feedback, feedback_at, opened_at, palette_action, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id,
        d.point,
        d.kind,
        d.projectId,
        d.subjectKind,
        d.subjectId,
        d.provider,
        d.model,
        d.mode,
        d.status,
        d.unavailable,
        JSON.stringify(d.state),
        JSON.stringify(d.questions),
        d.answers ? JSON.stringify(d.answers) : null,
        d.confidence,
        d.threshold,
        d.acted ? 1 : 0,
        d.visible ? 1 : 0,
        d.savedRun ? 1 : 0,
        d.latencyMs,
        d.inputTokens,
        d.costUsd,
        d.outcome ? JSON.stringify(d.outcome) : null,
        d.agreed === null ? null : d.agreed ? 1 : 0,
        d.resolvedAt,
        d.feedback,
        d.feedbackAt,
        d.openedAt,
        d.paletteAction ? JSON.stringify(d.paletteAction) : null,
        d.at,
      );
  }

  decision(id: string): DecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as DecisionRow | undefined;
    return row ? decisionOf(row) : null;
  }

  /**
   * Records what really happened. A person's feedback outranks the inference, so `agreed` is left
   * alone once there is some. False when the row is gone or already has an outcome (a rating alone does not count): a point may report
   * twice, and the first word stands.
   */
  resolveDecision(id: string, outcome: DecisionResolution, at: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE decisions SET outcome = ?, resolved_at = COALESCE(resolved_at, ?), agreed = CASE WHEN feedback IS NULL THEN ? ELSE agreed END
         WHERE id = ? AND outcome IS NULL`,
      )
      .run(JSON.stringify(outcome), at, outcome.agreed ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  /**
   * Useful agrees with the answer and not useful disagrees (D13); the latest word replaces the last.
   * A person's word is also a resolution, so `resolved_at` is set unless something already set it.
   */
  setDecisionFeedback(id: string, feedback: DecisionFeedback, at: string): boolean {
    const result = this.db
      .prepare('UPDATE decisions SET feedback = ?, feedback_at = ?, agreed = ?, resolved_at = COALESCE(resolved_at, ?) WHERE id = ?')
      .run(feedback, at, feedback === 'useful' ? 1 : 0, at, id);
    return Number(result.changes) > 0;
  }

  /**
   * What the palette's person did with the proposal, classified against the row's `command` answer.
   * The first report wins; returns the row (unchanged on a later report), or null when it is gone.
   */
  setDecisionPaletteAction(id: string, commandId: string | null, at: string): DecisionRecord | null {
    const row = this.decision(id);
    if (!row) return null;
    if (row.paletteAction) return row;
    const answer = row.answers?.command;
    const proposed = answer?.kind === 'choice' ? answer.value : null;
    const action: DecisionPaletteAction['action'] = commandId === null ? 'dismissed' : commandId === proposed ? 'proposed' : 'other';
    this.db.prepare('UPDATE decisions SET palette_action = ? WHERE id = ? AND palette_action IS NULL').run(JSON.stringify({ action, commandId, at } satisfies DecisionPaletteAction), id);
    return this.decision(id);
  }

  /**
   * Marks the newest `notification.urgency` row for a push key as opened, if it is not yet and was
   * recorded by now. Returns its id, or null when no row matches.
   */
  markNotificationOpened(key: string, at: string): string | null {
    const found = this.db
      .prepare("SELECT id FROM decisions WHERE point = 'notification.urgency' AND subject_kind = 'notification' AND subject_id = ? AND at <= ? ORDER BY seq DESC LIMIT 1")
      .get(key, at) as { id: string } | undefined;
    if (!found) return null;
    this.db.prepare('UPDATE decisions SET opened_at = ? WHERE id = ? AND opened_at IS NULL').run(at, found.id);
    return found.id;
  }

  /** Newest first. The cursor is the `seq` of the last row of the previous page. */
  listDecisions(query: DecisionPageQuery = {}): DecisionPage {
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 500);
    const { where, params } = decisionWhere(query);
    const cursor = query.cursor === undefined ? NaN : Number(query.cursor);
    if (Number.isInteger(cursor)) {
      where.push('seq < ?');
      params.push(cursor);
    }
    const rows = this.db
      .prepare(`SELECT * FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ?`)
      .all(...params, limit + 1) as unknown as DecisionRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(decisionOf), nextCursor: rows.length > limit && last ? String(last.seq) : null };
  }

  /** Per point, over the rows since `since`; points with no row in the window are absent. */
  decisionStats(since: string): DecisionStats {
    const rows = this.db
      .prepare(
        `SELECT point,
           COUNT(*) AS count,
           COALESCE(SUM(acted), 0) AS acted,
           COALESCE(SUM(status = 'unavailable'), 0) AS unavailable,
           AVG(confidence) AS mean_confidence,
           COALESCE(SUM(resolved_at IS NOT NULL), 0) AS resolved,
           COALESCE(SUM(agreed = 1), 0) AS agreed,
           COALESCE(SUM(feedback = 'useful'), 0) AS useful,
           COALESCE(SUM(feedback = 'not_useful'), 0) AS not_useful,
           COALESCE(SUM(cost_usd), 0) AS cost_usd,
           COALESCE(SUM(acted = 1 AND saved_run = 1), 0) AS runs_saved
         FROM decisions WHERE at >= ? GROUP BY point ORDER BY point`,
      )
      .all(since) as unknown as Array<{
      point: string;
      count: number;
      acted: number;
      unavailable: number;
      mean_confidence: number | null;
      resolved: number;
      agreed: number;
      useful: number;
      not_useful: number;
      cost_usd: number;
      runs_saved: number;
    }>;
    const points: DecisionPointStats[] = rows.map((r) => ({
      point: r.point as DecisionPointId,
      count: r.count,
      acted: r.acted,
      unavailable: r.unavailable,
      meanConfidence: r.mean_confidence,
      resolved: r.resolved,
      agreed: r.agreed,
      useful: r.useful,
      notUseful: r.not_useful,
      costUsd: r.cost_usd,
      runsSaved: r.runs_saved,
    }));
    const jev = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS n FROM decisions WHERE at >= ? AND provider = 'jev'").get(since) as { n: number } | undefined;
    return {
      since,
      points,
      jevCostUsd: jev?.n ?? 0,
      claudeRunsSaved: points.reduce((sum, p) => sum + p.runsSaved, 0),
    };
  }

  /** The newest row of a point, for the consent preview's "what was sent last" (D12). */
  lastDecisionOf(point: DecisionPointId): DecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE point = ? ORDER BY seq DESC LIMIT 1').get(point) as DecisionRow | undefined;
    return row ? decisionOf(row) : null;
  }

  deleteDecision(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM decisions WHERE id = ?').run(id).changes) > 0;
  }

  /** Deletes the rows a filter matches; an empty filter clears the history. Returns how many went. */
  clearDecisions(filter: DecisionFilter = {}): number {
    const { where, params } = decisionWhere(filter);
    return Number(this.db.prepare(`DELETE FROM decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).run(...params).changes);
  }

  /** Drops decisions older than `before`. Returns how many went. */
  pruneDecisions(before: string): number {
    return Number(this.db.prepare('DELETE FROM decisions WHERE at < ?').run(before).changes);
  }

  // ---------- push subscriptions ----------

  /**
   * Registers an install, or refreshes the one that already holds this endpoint. The row keeps the
   * `createdAt` of the first registration: a browser rotating its keys is the same device.
   */
  savePushSubscription(record: PushSubscriptionRecord): PushSubscriptionRecord {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, kinds, level, label, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           p256dh = excluded.p256dh, auth = excluded.auth, kinds = excluded.kinds, level = excluded.level,
           label = excluded.label, last_seen_at = excluded.last_seen_at`,
      )
      .run(
        record.id,
        record.endpoint,
        record.p256dh,
        record.auth,
        JSON.stringify(record.kinds),
        record.level,
        record.label,
        record.createdAt,
        record.lastSeenAt,
      );
    return this.pushSubscription({ endpoint: record.endpoint }) ?? record;
  }

  /** Oldest first, which is the order the Settings list shows them in. */
  pushSubscriptions(): PushSubscriptionRecord[] {
    const rows = this.db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all() as unknown as PushRow[];
    return rows.map(pushRecordOf);
  }

  pushSubscription(ref: { id?: string; endpoint?: string }): PushSubscriptionRecord | null {
    const row = ref.endpoint
      ? (this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(ref.endpoint) as PushRow | undefined)
      : ref.id
        ? (this.db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(ref.id) as PushRow | undefined)
        : undefined;
    return row ? pushRecordOf(row) : null;
  }

  /** False when there was no such install, which is what a second unsubscribe of the same one is. */
  deletePushSubscription(ref: { id?: string; endpoint?: string }): boolean {
    const result = ref.endpoint
      ? this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(ref.endpoint)
      : ref.id
        ? this.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(ref.id)
        : { changes: 0 };
    return Number(result.changes) > 0;
  }

  close(): void {
    clearInterval(this.movesPruneTimer);
    this.db.close();
  }
}

/** `404` is one code, `4xx` its whole class; anything else is refused rather than matching nothing. */
function statusRange(status: string): [number, number] {
  const code = /^([1-5])(\d\d|xx)$/i.exec(status);
  if (!code?.[1] || !code[2]) throw new Error('status must be a code such as 404 or a class such as 4xx');
  const hundreds = Number(code[1]) * 100;
  if (code[2].toLowerCase() === 'xx') return [hundreds, hundreds + 99];
  const exact = hundreds + Number(code[2]);
  return [exact, exact];
}

/** One install that asked to be pushed to, with the endpoint and keys the sender needs. */
export interface PushSubscriptionRecord {
  /** Derived from the endpoint by the caller, so the same install always has the same id */
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  kinds: NotificationKind[];
  level: NotificationLevel;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

interface PushRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  kinds: string;
  level: string;
  label: string;
  created_at: string;
  last_seen_at: string;
}

function pushRecordOf(row: PushRow): PushSubscriptionRecord {
  let kinds: NotificationKind[] = [];
  try {
    const parsed: unknown = JSON.parse(row.kinds);
    if (Array.isArray(parsed)) kinds = parsed.filter((k): k is NotificationKind => KINDS.includes(k as NotificationKind));
  } catch {
    // a hand-edited row asking for nothing is better than one that breaks every send
  }
  return {
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    kinds,
    level: LEVELS.includes(row.level as NotificationLevel) ? (row.level as NotificationLevel) : DEFAULT_LEVEL,
    label: row.label,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

interface ProposalRow {
  id: string;
  chat_id: string;
  task_id: string | null;
  orchestration_id: string | null;
  signal: string;
  occurrence: string;
  agent: string | null;
  hint: string;
  cost_usd: number;
  at: string;
  status: string;
}

/** The agent a proposal named, as stored; a row that does not read as one names none */
function agentOfRow(text: string | null): { agent: HealthSignalAgent } | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<HealthSignalAgent> | null;
    if (!value || typeof value.parentToolUseId !== 'string') return null;
    return {
      agent: {
        parentToolUseId: value.parentToolUseId,
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        ...(typeof value.subagentType === 'string' ? { subagentType: value.subagentType } : {}),
      },
    };
  } catch {
    return null;
  }
}

function proposalOf(row: ProposalRow): SupervisorProposal {
  return {
    id: row.id,
    chatId: row.chat_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.orchestration_id ? { orchestrationId: row.orchestration_id } : {}),
    signal: row.signal as HealthSignalKind,
    ...(row.occurrence ? { occurrence: row.occurrence } : {}),
    ...(agentOfRow(row.agent) ?? {}),
    hint: row.hint,
    costUsd: row.cost_usd,
    at: row.at,
    status: row.status as SupervisorProposalStatus,
  };
}

interface DecisionRow {
  seq: number;
  id: string;
  point: string;
  kind: string;
  project_id: string | null;
  subject_kind: string;
  subject_id: string | null;
  provider: string;
  model: string;
  mode: string;
  status: string;
  unavailable: string | null;
  state: string;
  questions: string;
  answers: string | null;
  confidence: number | null;
  threshold: number | null;
  acted: number;
  visible: number;
  saved_run: number;
  latency_ms: number;
  input_tokens: number | null;
  cost_usd: number | null;
  outcome: string | null;
  agreed: number | null;
  resolved_at: string | null;
  feedback: string | null;
  feedback_at: string | null;
  opened_at: string | null;
  palette_action: string | null;
  at: string;
}

function decisionOf(row: DecisionRow): DecisionRecord {
  return {
    id: row.id,
    point: row.point as DecisionPointId,
    kind: row.kind as DecisionPointKind,
    projectId: row.project_id,
    subjectKind: row.subject_kind as DecisionSubjectKind,
    subjectId: row.subject_id,
    provider: row.provider as DecisionProviderId,
    model: row.model,
    mode: row.mode as DecisionRecord['mode'],
    status: row.status as DecisionRecord['status'],
    unavailable: row.unavailable as DecisionUnavailableReason | null,
    state: JSON.parse(row.state) as Record<string, unknown>,
    questions: JSON.parse(row.questions) as DecisionQuestion[],
    answers: row.answers ? (JSON.parse(row.answers) as Record<string, DecisionAnswer>) : null,
    confidence: row.confidence,
    threshold: row.threshold,
    acted: row.acted === 1,
    visible: row.visible === 1,
    savedRun: row.saved_run === 1,
    latencyMs: row.latency_ms,
    inputTokens: row.input_tokens,
    costUsd: row.cost_usd,
    outcome: row.outcome ? (JSON.parse(row.outcome) as DecisionResolution) : null,
    agreed: row.agreed === null ? null : row.agreed === 1,
    resolvedAt: row.resolved_at,
    feedback: row.feedback as DecisionFeedback | null,
    feedbackAt: row.feedback_at,
    openedAt: row.opened_at,
    paletteAction: row.palette_action ? (JSON.parse(row.palette_action) as DecisionPaletteAction) : null,
    at: row.at,
  };
}

function decisionWhere(filter: DecisionFilter): { where: string[]; params: SQLInputValue[] } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const add = (clause: string, value: string | undefined) => {
    if (value === undefined) return;
    where.push(clause);
    params.push(value);
  };
  add('point = ?', filter.point);
  add('project_id = ?', filter.projectId);
  add('subject_kind = ?', filter.subjectKind);
  add('subject_id = ?', filter.subjectId);
  if (filter.visible) where.push('visible = 1');
  add('provider = ?', filter.provider);
  add('mode = ?', filter.mode);
  add('status = ?', filter.status);
  add('at >= ?', filter.since);
  add('at <= ?', filter.until);
  return { where, params };
}

// ---------- Collaborators ----------

/** A copied record as the receiving side stores it: `json` is the record as the owner served it. */
export interface CollabRecord {
  ownerId: EndpointId;
  shareKey: string;
  kind: CollaboratorsKind;
  recordId: string;
  /** The owner's version of the record (`updatedAt` + id, mtime + sha256, `seq`…), compared on reconcile */
  version: string;
  json: string;
  syncedAt: string;
}

/** One copy, `(owner, share key)`: what a teammate's install shares under one key. */
export interface CollabShareRef {
  ownerId: EndpointId;
  shareKey: string;
}

export interface CollabPeer {
  endpointId: EndpointId;
  lastSeenAt: string;
  /** How the last connection travelled; null when it is not known */
  path: CollaboratorsPath | null;
}

/** A join held for an owner: relayed by a member, or on the owner's install until a person answers. */
export interface CollabJoinRequest {
  groupId: string;
  fromEndpointId: EndpointId;
  /** `{secret, name, label, endpointId}` sealed to the owner's key; opaque to everyone else */
  sealed: string;
  /** The member that relayed it; null when it came straight to this install */
  relayedBy: EndpointId | null;
  /** The invite's expiry as the joiner sent it in the clear, so a relay can drop it; null when unknown */
  expiresAt: string | null;
  receivedAt: string;
  /** When a relaying member handed it to the owner; null until then */
  forwardedAt: string | null;
}

/**
 * A join the owner denied. `tag` is `denialTag` of the invite's secret hash (`collab/invite.ts`): what
 * the joiner asks with, so the hash an owner spends invites by never travels. `secretHash` is kept on
 * the owner's install only; `expiresAt` is the invite's, after which the row is pruned.
 */
export interface CollabJoinDenial {
  groupId: string;
  endpointId: EndpointId;
  tag: string;
  secretHash: string | null;
  deniedAt: string;
  expiresAt: string;
}

interface CollabDenialRow {
  group_id: string;
  endpoint_id: string;
  tag: string;
  secret_hash: string | null;
  denied_at: string;
  expires_at: string;
}

const collabDenialOf = (r: CollabDenialRow): CollabJoinDenial => ({
  groupId: r.group_id,
  endpointId: r.endpoint_id,
  tag: r.tag,
  secretHash: r.secret_hash,
  deniedAt: r.denied_at,
  expiresAt: r.expires_at,
});

interface CollabRecordRow {
  owner_id: string;
  share_key: string;
  kind: string;
  record_id: string;
  version: string;
  json: string;
  synced_at: string;
}

interface CollabPeerRow {
  endpoint_id: string;
  last_seen_at: string;
  path: CollaboratorsPath | null;
}

interface CollabJoinRow {
  group_id: string;
  from_endpoint_id: string;
  sealed: string;
  relayed_by: string | null;
  expires_at: string | null;
  received_at: string;
  forwarded_at: string | null;
}

const collabRecordOf = (r: CollabRecordRow): CollabRecord => ({
  ownerId: r.owner_id,
  shareKey: r.share_key,
  kind: r.kind as CollaboratorsKind,
  recordId: r.record_id,
  version: r.version,
  json: r.json,
  syncedAt: r.synced_at,
});

interface AgentReadRow {
  id: number;
  at: string;
  chat_id: string;
  tool: string;
  owner_id: string;
  share_key: string;
  share_id: string;
  kind: CollaboratorsKind | null;
  record_ids: string;
}

function agentReadOf(r: AgentReadRow): AgentReadEntry {
  let recordIds: string[] = [];
  try {
    const parsed = JSON.parse(r.record_ids) as unknown;
    if (Array.isArray(parsed)) recordIds = parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    // A row written by hand that does not parse names no records
  }
  return { id: r.id, at: r.at, chatId: r.chat_id, tool: r.tool, owner: r.owner_id, shareKey: r.share_key, shareId: r.share_id, kind: r.kind, recordIds };
}

const collabPeerOf = (r: CollabPeerRow): CollabPeer => ({ endpointId: r.endpoint_id, lastSeenAt: r.last_seen_at, path: r.path });

const collabJoinOf = (r: CollabJoinRow): CollabJoinRequest => ({
  groupId: r.group_id,
  fromEndpointId: r.from_endpoint_id,
  sealed: r.sealed,
  relayedBy: r.relayed_by,
  expiresAt: r.expires_at,
  receivedAt: r.received_at,
  forwardedAt: r.forwarded_at,
});

/**
 * The rows of Collaborators (§4.3), over the shared connection like `work-items.ts`: the copies a
 * receiver keeps, peers' presence, relayed joins and spent invite secrets. Copies are keyed by the
 * owner's endpoint id and share key, never by a local project id, since a share matches a local
 * project only through its key or a manual link, and may match none.
 */
export class CollabStore {
  constructor(private readonly sql: DatabaseSync) {}

  // agents' reads

  appendAgentRead(read: Omit<AgentReadEntry, 'id'>): AgentReadEntry {
    const row = this.sql
      .prepare('INSERT INTO collab_agent_reads (at, chat_id, tool, owner_id, share_key, share_id, kind, record_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .get(read.at, read.chatId, read.tool, read.owner, read.shareKey, read.shareId, read.kind, JSON.stringify(read.recordIds)) as { id: number };
    return { id: row.id, ...read, recordIds: [...read.recordIds] };
  }

  /** Newest first; `since` keeps the rows at or after it, `limit` is at most 1000. */
  agentReads(filter: { owner?: string; shareId?: string; chatId?: string; since?: string; limit?: number } = {}): AgentReadEntry[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.owner !== undefined) {
      where.push('owner_id = ?');
      params.push(filter.owner);
    }
    if (filter.shareId !== undefined) {
      where.push('share_id = ?');
      params.push(filter.shareId);
    }
    if (filter.chatId !== undefined) {
      where.push('chat_id = ?');
      params.push(filter.chatId);
    }
    if (filter.since !== undefined) {
      where.push('at >= ?');
      params.push(filter.since);
    }
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? 200), 1), 1000);
    const rows = this.sql
      .prepare(`SELECT * FROM collab_agent_reads ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params, limit) as unknown as AgentReadRow[];
    return rows.map(agentReadOf);
  }

  private tx<T>(fn: () => T): T {
    this.sql.exec('BEGIN');
    try {
      const out = fn();
      this.sql.exec('COMMIT');
      return out;
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  // records

  /** Stores a batch of one kind as pulled, replacing what an earlier pull left under the same ids. */
  upsertRecords(
    share: CollabShareRef,
    kind: CollaboratorsKind,
    records: ReadonlyArray<{ recordId: string; version: string; json: string }>,
    syncedAt: string,
  ): void {
    if (!records.length) return;
    const upsert = this.sql.prepare(
      `INSERT INTO collab_records (owner_id, share_key, kind, record_id, version, json, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, share_key, kind, record_id) DO UPDATE SET version = excluded.version, json = excluded.json, synced_at = excluded.synced_at`,
    );
    this.tx(() => {
      for (const r of records) upsert.run(share.ownerId, share.shareKey, kind, r.recordId, r.version, r.json, syncedAt);
    });
  }

  record(share: CollabShareRef, kind: CollaboratorsKind, recordId: string): CollabRecord | null {
    const row = this.sql
      .prepare('SELECT * FROM collab_records WHERE owner_id = ? AND share_key = ? AND kind = ? AND record_id = ?')
      .get(share.ownerId, share.shareKey, kind, recordId) as CollabRecordRow | undefined;
    return row ? collabRecordOf(row) : null;
  }

  records(share: CollabShareRef, kind: CollaboratorsKind): CollabRecord[] {
    const rows = this.sql
      .prepare('SELECT * FROM collab_records WHERE owner_id = ? AND share_key = ? AND kind = ? ORDER BY record_id')
      .all(share.ownerId, share.shareKey, kind) as unknown as CollabRecordRow[];
    return rows.map(collabRecordOf);
  }

  /** Every stored id of a kind with its version, for the catalog reconcile to compare with the owner's. */
  recordVersions(share: CollabShareRef, kind: CollaboratorsKind): Map<string, string> {
    const rows = this.sql
      .prepare('SELECT record_id, version FROM collab_records WHERE owner_id = ? AND share_key = ? AND kind = ?')
      .all(share.ownerId, share.shareKey, kind) as unknown as Array<{ record_id: string; version: string }>;
    return new Map(rows.map((r) => [r.record_id, r.version]));
  }

  /** Drops records the owner no longer lists; returns how many went. */
  deleteRecords(share: CollabShareRef, kind: CollaboratorsKind, recordIds: readonly string[]): number {
    if (!recordIds.length) return 0;
    const del = this.sql.prepare('DELETE FROM collab_records WHERE owner_id = ? AND share_key = ? AND kind = ? AND record_id = ?');
    return this.tx(() => recordIds.reduce((n, id) => n + Number(del.run(share.ownerId, share.shareKey, kind, id).changes), 0));
  }

  /** How many records of each kind a copy holds; a kind with none is left out. */
  recordCounts(share: CollabShareRef): Partial<Record<CollaboratorsKind, number>> {
    const rows = this.sql
      .prepare('SELECT kind, COUNT(*) AS n FROM collab_records WHERE owner_id = ? AND share_key = ? GROUP BY kind')
      .all(share.ownerId, share.shareKey) as unknown as Array<{ kind: CollaboratorsKind; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
  }

  /** Every copy held, from records or transcripts, so a leave or an unshare can find what to drop. */
  shares(): CollabShareRef[] {
    const rows = this.sql
      .prepare(
        `SELECT owner_id, share_key FROM collab_records
         UNION SELECT owner_id, share_key FROM collab_transcript_lines
         ORDER BY owner_id, share_key`,
      )
      .all() as unknown as Array<{ owner_id: string; share_key: string }>;
    return rows.map((r) => ({ ownerId: r.owner_id, shareKey: r.share_key }));
  }

  /** Deletes a whole copy, records and transcripts: the owner stopped sharing it, or the group was left. */
  dropShare(share: CollabShareRef): void {
    this.tx(() => {
      this.sql.prepare('DELETE FROM collab_records WHERE owner_id = ? AND share_key = ?').run(share.ownerId, share.shareKey);
      this.sql.prepare('DELETE FROM collab_transcript_lines WHERE owner_id = ? AND share_key = ?').run(share.ownerId, share.shareKey);
    });
  }

  // transcripts

  /**
   * Appends the lines pulled after the stored offset and returns the next seq. The byte offset is a
   * cursor in the group document, written after this returns: a crash between the two pulls the same
   * bytes again, so a caller that knows where those bytes began passes `fromSeq` and they replace
   * what is held from there instead of being appended twice.
   */
  appendTranscriptLines(share: CollabShareRef, sessionId: string, lines: readonly string[], fromSeq?: number): number {
    const insert = this.sql.prepare('INSERT OR REPLACE INTO collab_transcript_lines (owner_id, share_key, session_id, seq, line) VALUES (?, ?, ?, ?, ?)');
    return this.tx(() => {
      if (fromSeq !== undefined) {
        this.sql
          .prepare('DELETE FROM collab_transcript_lines WHERE owner_id = ? AND share_key = ? AND session_id = ? AND seq >= ?')
          .run(share.ownerId, share.shareKey, sessionId, fromSeq);
      }
      // Counted after the delete, so a `fromSeq` past the end appends without leaving a gap
      let next = this.transcriptLineCount(share, sessionId);
      for (const line of lines) insert.run(share.ownerId, share.shareKey, sessionId, next++, line);
      return next;
    });
  }

  /** Lines oldest first after `after` (a seq, exclusive), at most `limit`. */
  transcriptLines(share: CollabShareRef, sessionId: string, opts: { after?: number; limit?: number } = {}): Array<{ seq: number; line: string }> {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 500), 1), 5_000);
    const rows = this.sql
      .prepare('SELECT seq, line FROM collab_transcript_lines WHERE owner_id = ? AND share_key = ? AND session_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(share.ownerId, share.shareKey, sessionId, opts.after ?? -1, limit) as unknown as Array<{ seq: number; line: string }>;
    return rows.map((r) => ({ seq: r.seq, line: r.line }));
  }

  /** How many lines are held, which is also the next seq: seqs start at 0 and have no gaps. */
  transcriptLineCount(share: CollabShareRef, sessionId: string): number {
    const row = this.sql
      .prepare('SELECT COALESCE(MAX(seq) + 1, 0) AS n FROM collab_transcript_lines WHERE owner_id = ? AND share_key = ? AND session_id = ?')
      .get(share.ownerId, share.shareKey, sessionId) as { n: number };
    return row.n;
  }

  deleteTranscript(share: CollabShareRef, sessionId: string): void {
    this.sql.prepare('DELETE FROM collab_transcript_lines WHERE owner_id = ? AND share_key = ? AND session_id = ?').run(share.ownerId, share.shareKey, sessionId);
  }

  /**
   * A chat's transcript and its agents' (held as `<chatId>/<agent file>`, `collab/client.ts`): the
   * chat is no longer shared.
   */
  deleteChatTranscripts(share: CollabShareRef, chatId: string): void {
    const prefix = `${chatId}/`;
    this.sql
      .prepare('DELETE FROM collab_transcript_lines WHERE owner_id = ? AND share_key = ? AND (session_id = ? OR substr(session_id, 1, ?) = ?)')
      .run(share.ownerId, share.shareKey, chatId, prefix.length, prefix);
  }

  // peers

  /** Records a connection to a peer; a `path` of null keeps the one stored. */
  seePeer(endpointId: EndpointId, at: string, path: CollaboratorsPath | null): void {
    this.sql
      .prepare(
        `INSERT INTO collab_peers (endpoint_id, last_seen_at, path) VALUES (?, ?, ?)
         ON CONFLICT (endpoint_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, path = COALESCE(excluded.path, collab_peers.path)`,
      )
      .run(endpointId, at, path);
  }

  peer(endpointId: EndpointId): CollabPeer | null {
    const row = this.sql.prepare('SELECT * FROM collab_peers WHERE endpoint_id = ?').get(endpointId) as CollabPeerRow | undefined;
    return row ? collabPeerOf(row) : null;
  }

  peers(): CollabPeer[] {
    return (this.sql.prepare('SELECT * FROM collab_peers ORDER BY endpoint_id').all() as unknown as CollabPeerRow[]).map(collabPeerOf);
  }

  forgetPeer(endpointId: EndpointId): void {
    this.sql.prepare('DELETE FROM collab_peers WHERE endpoint_id = ?').run(endpointId);
  }

  // join requests

  /** Holds a join; the same joiner asking again for the same group replaces its earlier request. */
  putJoinRequest(request: Omit<CollabJoinRequest, 'forwardedAt'>): void {
    this.sql
      .prepare(
        `INSERT OR REPLACE INTO collab_join_requests (group_id, from_endpoint_id, sealed, relayed_by, expires_at, received_at, forwarded_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(request.groupId, request.fromEndpointId, request.sealed, request.relayedBy, request.expiresAt, request.receivedAt);
  }

  joinRequest(groupId: string, fromEndpointId: EndpointId): CollabJoinRequest | null {
    const row = this.sql.prepare('SELECT * FROM collab_join_requests WHERE group_id = ? AND from_endpoint_id = ?').get(groupId, fromEndpointId) as
      | CollabJoinRow
      | undefined;
    return row ? collabJoinOf(row) : null;
  }

  /** Oldest first; `pending` keeps those not forwarded yet, which is what a relay still has to deliver. */
  joinRequests(opts: { groupId?: string; pending?: boolean } = {}): CollabJoinRequest[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (opts.groupId !== undefined) {
      where.push('group_id = ?');
      params.push(opts.groupId);
    }
    if (opts.pending) where.push('forwarded_at IS NULL');
    const rows = this.sql
      .prepare(`SELECT * FROM collab_join_requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY received_at, from_endpoint_id`)
      .all(...params) as unknown as CollabJoinRow[];
    return rows.map(collabJoinOf);
  }

  markJoinForwarded(groupId: string, fromEndpointId: EndpointId, at: string): void {
    this.sql.prepare('UPDATE collab_join_requests SET forwarded_at = ? WHERE group_id = ? AND from_endpoint_id = ?').run(at, groupId, fromEndpointId);
  }

  deleteJoinRequest(groupId: string, fromEndpointId: EndpointId): void {
    this.sql.prepare('DELETE FROM collab_join_requests WHERE group_id = ? AND from_endpoint_id = ?').run(groupId, fromEndpointId);
  }

  /** Drops the requests already forwarded and those whose invite expired by `now`; returns how many went. */
  pruneJoinRequests(now: string): number {
    const result = this.sql.prepare('DELETE FROM collab_join_requests WHERE forwarded_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= ?)').run(now);
    return Number(result.changes);
  }

  // used invites

  /**
   * Spends an invite secret: true the first time, false when it was already spent. The insert is what
   * decides, so two joins racing with one secret cannot both get true, in one process or in two.
   */
  useInvite(groupId: string, secretHash: string, at: string): boolean {
    const result = this.sql.prepare('INSERT OR IGNORE INTO collab_used_invites (group_id, secret_hash, used_at) VALUES (?, ?, ?)').run(groupId, secretHash, at);
    return Number(result.changes) === 1;
  }

  isInviteUsed(groupId: string, secretHash: string): boolean {
    return this.sql.prepare('SELECT 1 FROM collab_used_invites WHERE group_id = ? AND secret_hash = ?').get(groupId, secretHash) !== undefined;
  }

  // denied joins

  /** Records a denial; the same joiner denied again with the same invite only refreshes it. */
  putJoinDenial(denial: CollabJoinDenial): void {
    this.sql
      .prepare(
        `INSERT INTO collab_join_denials (group_id, endpoint_id, tag, secret_hash, denied_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (group_id, endpoint_id, tag) DO UPDATE SET secret_hash = COALESCE(excluded.secret_hash, secret_hash), denied_at = excluded.denied_at, expires_at = excluded.expires_at`,
      )
      .run(denial.groupId, denial.endpointId, denial.tag, denial.secretHash, denial.deniedAt, denial.expiresAt);
  }

  /** The denial of this joiner's request with the invite `tag` names, while that invite is still valid at `now`. */
  joinDenial(groupId: string, endpointId: EndpointId, tag: string, now: string): CollabJoinDenial | null {
    const row = this.sql
      .prepare('SELECT * FROM collab_join_denials WHERE group_id = ? AND endpoint_id = ? AND tag = ? AND expires_at > ?')
      .get(groupId, endpointId, tag, now) as CollabDenialRow | undefined;
    return row ? collabDenialOf(row) : null;
  }

  /** Every denial of a group still within its invite's validity, oldest first. */
  joinDenials(groupId: string, now: string): CollabJoinDenial[] {
    const rows = this.sql
      .prepare('SELECT * FROM collab_join_denials WHERE group_id = ? AND expires_at > ? ORDER BY denied_at, endpoint_id')
      .all(groupId, now) as unknown as CollabDenialRow[];
    return rows.map(collabDenialOf);
  }

  /** Forgets the denials whose invite has expired by `now`: nobody can ask with it any more. */
  pruneJoinDenials(now: string): number {
    return Number(this.sql.prepare('DELETE FROM collab_join_denials WHERE expires_at <= ?').run(now).changes);
  }

  /** Forgets the rows of a group this install left: its relayed joins, denials and spent secrets. */
  dropGroup(groupId: string): void {
    this.tx(() => {
      this.sql.prepare('DELETE FROM collab_join_requests WHERE group_id = ?').run(groupId);
      this.sql.prepare('DELETE FROM collab_join_denials WHERE group_id = ?').run(groupId);
      this.sql.prepare('DELETE FROM collab_used_invites WHERE group_id = ?').run(groupId);
    });
  }
}
