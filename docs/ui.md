---
created_at: 2026-10-17T12:00:00Z
updated_at: 2026-10-17T12:00:00Z
tags:
    - ui
    - web
    - pages
    - reference
---
# The UI, page by page

What each page of the web app covers, and what holds across all of them. How it looks is the Night
Shift design system ([design-system.md](design-system.md)); this page says what is there. Until
2026-10-17 it was the README's "UI".

## Pages

| Page | What it covers |
| --- | --- |
| Home | A dashboard of widgets. With a project selected: **Now** (what waits for a person first — chats stopped for a permission or a question, blocked orchestration tasks, merge conflicts, a command running for long, a missing CLI or credential — each with its action, then every working chat with a ticker of what it is doing), **Limits**, **Orchestrations** (the running ones, or the latest, with a compact stepper and its progress), **Upcoming schedules**, **Pick up again**, **Today** (what the day has cost per model), **Memory** (the project's `CLAUDE.md` excerpt), **Worktrees**, **Resources** (counts per kind) and **Export** (the project's chats as Markdown or JSON). With All projects: Now, Orchestrations, Limits, Pick up again, Today, Upcoming schedules and **Projects** (each one's live count and last activity). The header shows the project's monogram, name, key, template, path, chats and worktrees, with New chat and (Board on) New task. Under it a strip of tabs, each `/?view=…`: Resumen (the dashboard), **Tablero** (`board`, while the Board module is on), **Equipo** (`team`, while the Team module is on: the members with their agent file's state, their columns, write paths and what each does now; a member's page (`&member=`) with its metadata and its agent file in the editor; the flow (`&section=flow`) with its switch, each column's role, the bounce limit and each role's model; and, with nobody on the team, the template's team), **Documentos** (`documents`, while the Documents module is on: the documents folder as a tree, a document rendered or edited (`&doc=`, `&mode=edit`), and the documents tied to tasks with the role that wrote them), **Memoria** (`memory`, while Shared memory is on: the team's memory proposals approved one by one, the project journal, and the CLI's `CLAUDE.md` and memory files), Recursos (`resources`: agents, skills and commands in one view with the assistant's proposals beside them, **Suggest** and **Create with AI** (`&ai=1`), each proposal opened in the editor unsaved (`&proposal=`) so saving it accepts it; then output styles, rules and saved workflows, each workflow with a **Run** button), Worktrees and Ajustes (`settings`: name, key prefix, modules, the board's column limits, removing the project, then Claude Code's settings). The widgets open them too; an address naming a hidden tab lands on Resumen, and old `?tab=` links redirect there. On a phone the tabs are a card of cells, each its own screen |
| Tasks | The board of the selected project (`/tasks`), or of every project with All projects. Five fixed columns with their counts and optional limits (over one: the warn colour and "Over the limit: 4 of 3", never refused); cards with key, type, priority, title, epic, labels, assignee, checklist progress and blockers, and the live rail, spinner and what the agent is doing while a chat or orchestration node works on the item. Drag a card, or move it with the keyboard (Space, arrows, Space); search, filters by type, priority, label, assignee, epic and milestone kept in the address and, per project until Reset, in the browser, like every list, and **Select** to hand a selection to the orchestration editor as a draft with its dependencies. `?view=list` is the list grouped by column; `/tasks/milestones` the milestones with their progress, open and closed, without dates. A card opens its item in a panel beside the board (`?item=KEY`); `/tasks/:key` is its page: every field edited in place, the Markdown description, the acceptance checklist with who checked each entry, relations, linked chats and orchestrations, the changes on its branch (each file, and **Review the changes**, opening the review screen), and the activity with comments. **Work on it** starts a chat on the item with New chat's options; **Move to Done** is the person's approval. With the Team module on, each column shows the role that answers for it under the flow, a card names the member at work on it and its bounces, a task can be assigned to a role, and a task shows its tied documents and what it waits for from the person (QA's pass, or its last bounce) with the move that ends it. **New task** (`?new=1`, `N`) is a dialog, a full screen on a phone. **Suggest tasks** (`?suggest=1`) has the project assistant read the project and propose work items, each with its reason, created in Backlog one by one as the person selects them; closing it leaves the run going. On a phone the board is one list with a jump between columns, a move sheet per card and the filters in a sheet |
| Chats | Every conversation in one list, whoever started it, grouped by day (Today, Yesterday, This week, Earlier) when sorted by activity. A toolbar with state tabs and their counts (All, Working, Waiting for you, Idle), search, sort and **Filters** (origin, project, model, orchestration workers, housekeeping chats), each filter in force shown as a removable chip. Each row takes two lines: a state rail and word, the title and the time; then the first prompt — or, while it works, what it is doing now — its origin and project and at most two tags (a control that is not the default, a fork or a worktree), with a context ring and the cost on the right. Select several with `x` or their checkbox to export them as Markdown or delete them with one confirmation; a chat with something running on it is skipped and named |
| Chat | One conversation, live over SSE. A one-line header: title, one pill for its state, who controls it and the stream (`Working · live`), its checklist as `▰▰▱ 1/3`, search, **Stop ▾** (with Interrupt) while it works and a ⋯ menu with Export Markdown/JSON, Fork, Subagent messages, Copy id and Delete; on a phone search and Interrupt move into the ⋯ menu, Stop keeps only its icon and ⓘ opens the inspector. The transcript shows the author only when it changes, folds consecutive tool calls into one **step** ("7 tools · 42 s", open with a live rail while it runs), and replaces "working…" with a ticker of what the agent is doing (`Running npm test`, `Editing src/app.ts`). A `Task` call opens its subagent's transcript in a side panel, like background tasks and workflows (`?detail=…`: prompt, status, duration, tokens, transcript and result, updating while it runs). The composer is one pill with a status line under it (`model · mode · preset · MCP`) that opens the permission mode, model, tool preset and MCP servers; while the agent works and the box is empty, send becomes interrupt. The **inspector** is a drawer on the right: folded, it is a rail with its toggle and one button per tab; open, it is docked beside the transcript from 1100 px (remembered open or folded) and slides over the chat from 900 px; on a phone it is a sheet. It has four tabs: Summary (context, cost, facts, id), Activity (the checklist as steps, executions), Changes (a compact summary: the totals, branch and commits, a change fingerprint, one line per file with `+/−`, the latest edit and why it was made, and **Review the changes**) and Environment (branches, **health** with the actions that fit the signal — cancel the command, send a hint, interrupt, and the supervisor's proposed hint when it is on — tools, servers and environment). What it can do follows its control: send, interrupt, resume, or continue in a copy. On a phone the page is the screen's height, with the composer following the on-screen keyboard. New chat puts the prompt first and the directory, model, mode, system prompt, account and tools under **Advanced options**. `?prompt=<id>` scrolls to a permission prompt. A message's menu (a sheet on a phone) copies it or creates a task from it in Backlog; a chat that works on a task names it under its header, the whole row a link, and the inspector's Summary shows its card |
| Projects | The management screen, with search and sort (recent activity, name, most chats), each card with its key and its modules: rename, remove (harmless) or purge what Claude Code keeps about it (irreversible). **New project** opens the wizard (`/projects/new`): a local directory, a repository to clone or a new directory in the workspace, one of five templates, the module switches it preselected, and a summary with the key prefix and **Propose team, resources and tasks** (on for every template but Simple), which hands the new project to its assistant; on a phone, one step per screen. On a first start with none imported it offers the directories holding the most chats, each opening the wizard |
| Assistant | `/projects/:id/assistant`, reached from the wizard and from the empty Team's **Ask for a proposal**: while the run reads, what it has read with a spinner and **Stop**; then the proposed team, resources and first tasks in three sections, each proposal with its reason, accepted or discarded on its own (**Review** opens a resource in the project's Resources tab). A project with nothing to read starts no chat, offers the template's team and asks what the project is for, which proposes the first tasks. The run's model, time, cost and chat, and **Suggest again**. On a phone, without the tab bar |
| Orchestration | Auto-planned or manual task DAG. The list has status tabs with counts (All, Live, Completed, Failed, Stopped), search, sort and a **Templates** tab (`?tab=templates`); each row carries a segmented progress bar and, while it runs, the stage and what its task is doing. A graph's page pins a summary (status, live clock, cost, progress of its tasks, and Stop or **Edit and relaunch** with the rest in a ⋯ menu), folds the objective to three lines, and follows it as **steps**: its stages, then integration, verification, synthesis and the pull request, each with its state. The page follows the step that is happening; picking another pins it (`?step=`) and offers "Back to live". A stage's tasks show their live rail, what they are doing, duration, cost and attempts; a task's name opens its chat beside the page (`?detail=chat:<id>`). `?view=graph` is the board by stage, scrolling inside its own box, with connectors that flow into the running stage. On a phone the steps are a vertical timeline. Each task has a **Work** panel (`?task=<id>`: what it runs now, its health, checklist and changes) and, on a finished graph on the graph engine, **Re-run**. **Edit and relaunch** a graph, **templates** (save, launch on a new objective and directory, edit, delete), per-task and per-graph time and cost limits, and a **verification** card with each command's output, the install step, what the fixer spent against its limit and its commits, before the pull request; a graph its checks failed says so at the top and is offered no pull request. The integration card has the merged branch's changes. A draft handed over by the Tasks board opens in the editor with each node showing its task's key and the blockers left outside the selection as a warning; on a graph's page, a node linked to a task links to it by its key |
| Changes | The review screen of a chat (`/chats/:id/changes`), a task (`/orchestration/:id/tasks/:taskId/changes`), the integration branch (`/orchestration/:id/changes`) or a work item's own branch (`/tasks/:key/changes`, by its result alone: several chats may have worked on it), opened from the compact summary. **Result** is the net change file by file: a header with the branch, base, counts, the scope (all the work, one commit, not committed yet) and a change fingerprint; a file map by directory with seen, not committed and the file being edited now; and the file's diff in **Reading** (the default: the file as it is now, removed lines folded into a pill on the rail), **Unified** or **Side by side** (from 1100 px), with the intent of the latest step that touched it and a block rail. **Step by step** lists every edit of the transcript with its patch and the sentence Claude wrote before it, and links to that place in the conversation (`/chats/:id?at=`). Keys: `j`/`k` blocks, `n`/`p` files, `v` seen, `m` mode, `o` open the removed lines, `[` the map, `/` filter, `←`/`→` steps. Deep links: `?file=`, `?mode=`, `?scope=`, `?lens=steps`, `?step=`. The mode and what was seen stay in the browser. On a phone the files are cells and each file is a screen of its own |
| Schedules | Recurring chats and orchestrations, with search and All/On/Off tabs: each schedule with its cron expression in words, when it fires next and when it last ran, on/off, **Run now**, edit, delete, and a run history behind it (when, result, what it started or the error; a slot the overlap policy skipped or queued is tagged as such). The cron builder offers every few minutes to monthly or a custom expression, previews the next five fires as you type, and says that a window missed while Claudio was down is skipped, not replayed. A schedule is created and edited on a page of its own (`/schedules/new`, `/schedules/:id/edit`). The form sets what happens when a slot arrives while the last run is still going, and can be filled from an orchestration that already ran |
| Usage | Cost, tokens or chats over time, per day or week, for 7, 30 or 90 days, all time or a range picked from a calendar of Claudio's own (typed dates still work); by project and by model, with the selected project's chats offered as a download. An SVG chart with the same figures as a table, a text readout and a screen-reader description. A cost the CLI never reported reads "Not reported", never `$0.00` |
| Connectors | The claude.ai connectors (Docs, Gmail, Calendar) the CLI can see, with their status and prepared prompts that start a chat, what to do to authorise one, and a sentence on what has no CLI surface (web artifacts, claude.ai memory) |
| Settings | User scope only, as tabs: **Appearance** (theme, language and motion, the tab `/settings` opens on), Account (with the Claude Code version card: in use, pinned, newest published, check now), Instructions, Settings (guided editor + raw JSON), MCP servers (guided form, scopes, connection checks), Agents, Skills, Commands, Output styles, Rules, a file explorer for everything else (hook scripts, skill files, keybindings…), Memory (where each project's memory is), Plugins (installed plugins, marketplace search and install, marketplaces), **Tool presets** (named allowed and disallowed tool sets, which one a chat with no preset takes, and restoring the shipped ones), **Notifications** (what is worth telling you about, the switch that pushes it to this device with Claudio closed, and every install registered for push, with a test and a way to remove any), **Install** (adding Claudio to this device's home screen), **Supervisor** (off by default: the model, what it may spend and whether it sends its hint on its own) and **Security** (auth mode, token, OIDC, read-only, and an audit log narrowed by path, method and status). Everything that belongs to one project lives on its page instead |
| Claudio assistant | `/assistant`: a global chat that knows Claudio, reads it through its own MCP server and changes something only when the person allows each change. See [claudio-assistant.md](claudio-assistant.md) |
| Accounts | `/accounts`: the Claude accounts of this machine, each signed in once, with their usage, the rotation settings and per-project policies. See [accounts.md](accounts.md) |
| Collaborators | `/collaborators`: turning sharing on, groups, invites and members, and the read-only copies of what teammates share. See [collaborators.md](collaborators.md) |
| Terminals | `/terminals`: the person's own shells per project and per chat, off until Settings → Security turns them on. See [terminal.md](terminal.md) |

## Across the app

- **Top bar**, one row: where you are, the project selector, search (the palette), notifications, a
  **live chip** while anything runs (`⠹ 2 working · post-roadmap 11/17`, a menu of what is live, each
  a link) and **New chat ▾**, with Run workflow and New orchestration behind the arrow.
- **Sidebar**: the pages (Tasks, between Chats and Orchestrations, with the open count of the
  selected project), then a **Live** section — chats waiting for you, working chats with a line
  saying what each is doing, running orchestrations with their progress as `▰▰▱▱▱ 2/7`. Collapsed to
  a rail, it keeps one button with the live count.
- **On a phone** (up to 900 px) a bottom tab bar — Home, Chats, Orchestrations and More, with New chat as a gradient FAB — with
  the waiting and working counts on its tabs, replaces the sidebar; More opens a sheet with the rest
  of the pages (Tasks first, with its open count), the API reference and the connection status. A
  chat's, an orchestration's and a work item's own page hide it, and so does the project wizard,
  since they have a back button and a footer of their own.
- **Project selector** (top bar, beside the search): scopes Home, Chats, Tasks and Orchestrations to one project
  or All projects. The choice is remembered, and a `?project=<id>` in the address overrides it, so a link
  to a project's page works from anywhere. Notifications ignore it: a chat waiting in another project
  is still worth knowing about.
- **Command palette** (`Ctrl/⌘ K`): fuzzy search over pages, settings tabs, projects and their views,
  recent chats, a **Live** group with what is working and waiting right now, and actions (new chat,
  new orchestration, new task, go to tasks, run a saved workflow, theme, language, motion, API reference…), with recents and
  full keyboard control.
- **Keyboard shortcuts**:

  | Keys | Where | What |
  | --- | --- | --- |
  | `Ctrl/⌘ K` | Everywhere | Command palette |
  | `j` / `k` | Chat list | Move to the next / previous chat |
  | `Enter` | Chat list | Open the chat |
  | `x` | Chat list | Select the chat for a bulk action |
  | `/` | Chat list | Jump to the search field |
  | `Escape` | Chat list | Clear the selection |
  | `/` | Tasks | Jump to the search field |
  | `n` | Tasks | New task |
  | `j` / `k` | Tasks list | Move to the next / previous task |
  | `Space`, arrows, `Space` | Board | Pick a card up, carry it, drop it (`Escape` cancels) |
  | `Ctrl/⌘ F` | Chat | Search the transcript |
  | `Enter` / `Shift Enter` | Composer | Send / new line |
  | `Ctrl/⌘ S` | Editors | Save |

  The list keys are ignored while you type in a field or a menu is open, and the chat list prints
  them under itself on screens with a keyboard.
- **Appearance** (Settings → Appearance, or the palette), kept per browser:
  - **Theme**: light, dark or system, applied before first paint.
  - **Motion**: `full` (the default: braille spinners, rails that pulse while an agent works,
    numbers that count up), `subtle` (transitions only, nothing loops) or `off`. The system's
    reduced-motion setting forces `off` and the tab says so; loops also stop while the tab is in the
    background. What is live is drawn in one colour of its own (cyan), never the orange of the
    buttons, and always has a word next to it.
- **Languages**: English and Spanish, the browser's by default, chosen under Appearance. The strings the server writes — a
  health signal's reason and hint, a connector's authorisation steps and links — carry a stable code
  and the figures behind them, so they are said in the reader's language too; a code this build does
  not know falls back to the server's English rather than showing a key.
- **Live chat**: responses stream token by token; thinking, tool calls and results render as they arrive.
- **Live updates**: one Server-Sent Events connection (`GET /api/events`) keeps every page current —
  chats, prompts waiting for you, background tasks, subagents, workflows, orchestrations, changes on
  disk, health, account rotation — instead of each screen polling. If the stream drops, the sidebar status says so and the
  pages fall back to a slow poll until it returns.
- **Updates**: Settings → Account has an **Updates** card with the version in use, the newest
  Claudio release, its notes and **Check for updates**, and the steps that take it for this install —
  the commands for Docker or a source checkout, or Download and Restart to update in the desktop app.
  While a newer release is known, a dot marks Settings in the sidebar (More, on a phone); it never
  goes in the bell. A page left open while its server moves to another version says **Claudio was
  updated to X** and offers **Reload**, but never reloads on its own. See
  [docs/plans/app-updates.md](plans/app-updates.md).
- **What an agent is doing right now**: from the stream-json events of each live process, Claudio
  keeps one line per chat — the tool it is calling and on what (`Editing src/app.ts`,
  `Running npm test`), or that it is writing, thinking or waiting for you — and sends it on the feed
  as `chat.activity`, at most once per chat per second. Lists, the sidebar, Home and an
  orchestration's tasks patch it in place instead of refetching. It is never stored: a chat with no
  live process of Claudio's has none.
- **Notifications**: a bell in the top bar collects what needs you or is worth knowing — a chat waiting
  for a permission, a question or a plan (always first, with a link to it, and settled once you
  answer), a chat or orchestration that finished or failed, an integration conflict, a rate limit or an
  account rotation, and finished background tasks, subagents and workflows. The kinds decide what
  the bell keeps; the **interruption level** decides what of it also pops up as a toast, a browser
  notification or a push: *Everything* (all but background activity), *Important only* — the
  default: what needs you, what failed, an orchestration that ended and a conflict —, *Only what
  needs me* (a chat waiting for you or turned red) or *Silent*. Questions stay until you act; browser
  notifications are opt-in, ask for permission only when you turn them on, and appear only while
  the tab is hidden.
  A chat already waiting when the page loads is notified too, and a waiting notification opens that
  prompt, not just the chat — a plain tool permission is answered **Allow** or **Deny** from the
  panel itself, without opening it; a question, a plan or an edited-arguments request keeps the link,
  because two buttons cannot answer those. A worker that looks stuck (`health.changed`) is news with
  the reason in it, and so is a hint the supervisor proposed for it (`supervisor.proposed`), which
  opens where it can be sent.
  The list, read state and preferences are kept per browser. A finished task or subagent links straight
  to its side panel, and a finished workflow to the agent that ended it.
  **Web Push** carries the same news to a device whose Claudio is closed: Settings → Notifications
  registers this install with the server, which decides what is worth sending with the same function
  the browser runs on the same event. A focused window shows its toast and no push, so nothing
  arrives twice (except on iOS, which must show every push). It needs a secure origin, and on iPhone an installed app — see
  [pwa.md](pwa.md).
- **Execution detail**: a subagent, a background task or a workflow agent opens in a side panel — prompt,
  type, status, duration, tokens, the full transcript, the result and, for a subagent, the tasks it
  launched — from the chat that holds it, a workflow's agents and the inbox. An orchestration's
  worker opens there too, as its chat: state, model, directory, cost, what it is doing and its latest
  transcript, with a link to the full chat. It
  follows the agent or the command's output while it runs, and it is part of the URL (`?detail=…`), so a
  reload or a link brings it back.
- **Installable**: a web app manifest and a service worker make Claudio an app on a phone or a
  desktop — its own icon, a standalone window and a shell that paints before the server answers. The
  worker caches that shell and nothing else: `/api`, `/docs` and `/openapi.json` are left to the
  network untouched, so both event streams behave exactly as they do in a tab.
- **Editors**: CodeMirror (JSON, Markdown, YAML, JS/TS) with `Ctrl/⌘ S`, unsaved-change guards
  (tabs, sidebar navigation, reload), confirmation dialogs for destructive actions
  and toasts for every mutation.
- **Form controls**: selects, suggestion lists, switches, checkboxes, sliders, number steppers,
  tooltips, collapsible sections, menus, sheets (a bottom sheet on a phone, a side panel on a wide
  screen) and a date picker of Claudio's own are built on Radix primitives
  (the calendar on the WAI-ARIA date picker pattern, with no library) and styled with the app's theme
  tokens, so no control falls back to the operating system's look; all of them work from the keyboard.
- **Motion**: page transitions, staggered lists, sliding tab indicators and animated status, at the
  level chosen under Appearance. Fonts (Geist, Geist Mono) and icons are bundled —
  the container needs no network access to render.


## Related

[[design-system.md]] · [[phone-layout.md]] · [[pwa.md]] · [[notifications.md]] · [[dashboard.md]] · [[work-items.md]] · [[orchestrations.md]] · [[chat-composer.md]] · [[persistent-filters.md]]
