# IdleShift

English | [日本語](README.ja.md)

> **Pre-release draft.** Not published yet. What is implemented, conditional or unproven is tracked in [docs/self-study/REPORT.md](docs/self-study/REPORT.md) (section 2). This README follows it.

**Reset the chat. Not the progress.**

IdleShift is a local blackboard that lets the AI apps you already use — Claude Code, Codex, Antigravity — share goals and tasks on one Windows PC. You write the goal and decide what the AIs may do. The AIs pick up tasks, report evidence, review each other, and keep their progress outside the chat. You confirm when it is done.

## Why it is different

1. **It does not launch your AIs behind your back.** AIs join from the app you already have open and *pull* work with an MCP tool (`next`). No all-permissions flags. An optional CLI launcher exists but is off unless you turn it on.
2. **Humans hold the keys.** Only a person can widen what an AI is allowed to do, or confirm that a goal is done. An AI's own claims do not change its permissions or budget.
   *Two known gaps are being fixed before release — see [Security](#security-and-known-limitations).*
3. **It routes around usage limits — by what you and the AIs tell it.** When an AI reports it hit its limit (with a reset time), it gets no new work until then, and the task can go to another AI. You can also set 5-hour and 7-day caps per AI. IdleShift does **not** read your vendor usage meters.

Things other tools also do (so we do not claim them as unique): a shared MCP task board for several AIs, state that survives the chat, using your existing subscriptions. See the [comparison](docs/self-study/03-competitors.md).

## Status

| | |
|---|---|
| Platform | **Windows only** (tested on Windows 11). Mac/Linux not supported yet. |
| Runtime | Node.js 22.13 or later (built-in `node:sqlite`). CI uses Node 24. **No npm dependencies.** |
| AI apps confirmed to work | Claude Code (CLI and the Code tab of Claude Desktop), Codex CLI, Antigravity. Claude Desktop **chat** is not verified. |
| Tests | 231 passing (`npm test`, 2026-11-14). |
| Per-task git worktrees | Core implemented (not released); the merge/discard screen is not done yet. |
| Low usage while waiting | Idle agents cost almost nothing: in our test, three AIs waiting for an hour used 0–2% of a 5-hour quota (Plus/Pro plans, measured once on 2026-11-13; [details](docs/evidence/raw/idle-cost/2026-11-13/README.md)). |

## Install (from source)

```
git clone <repository-url>
cd idleshift
node bin/idleshift.mjs gui
```

`gui` starts the background service and opens the local GUI (a browser window on 127.0.0.1). On Windows you can also double-click `IdleShift.bat`.

A self-contained Windows zip with Node included can be built with `npm run dist`. It is **unsigned**, so SmartScreen will warn.

## Quick start

The GUI follows your Windows language (English or Japanese) and can be switched in settings. Messages sent to AIs are in English by default ([docs/i18n.md](docs/i18n.md)).

1. **Create a project** in the GUI and register your working folder (an absolute path).
2. **Connect your AI apps** in the *接続* (Connections) tab. IdleShift adds itself as an MCP server to each app's config (it keeps a backup and shows the change first). Restart the app afterwards.
3. **Write a goal**: the outcome, what counts as done, and what the AIs may do (read only, edit files, run code…).
4. **Paste the start phrase** from the GUI into each AI app, for example:
   > Join IdleShift and work on your assigned tasks. When you finish, call `next` with `wait_seconds=3600`; if it returns `none`, call `next` again without writing anything; stop when it returns `stop`.
5. Watch tasks, evidence and reviews in the GUI. **Confirm** the goal when the evidence is enough.

If you close a chat, paste the start phrase into a new one: it rejoins under the same name and gets its task back.

## How it works

```
AI apps (Claude Code / Codex / Antigravity)         You
   | stdio (MCP)                                      | browser window (127.0.0.1 only)
   v                                                  v
 relay  --- named pipe (token) --->  service  ---  core (state machine, permissions, budgets)
 (no state, no DB)                      |           SQLite (the only source of truth)
                                        +--- hosts (MCP registration in each app)
                                        +--- adapters (optional CLI launch, off by default)
```

- Seven MCP tools: `join`, `next`, `claim`, `get`, `report`, `plan`, `status`. Standard MCP only.
- Tasks move `open → offered → claimed → reported → accepted`. Generations stop stale reports; `report_id` stops duplicates. A write task whose AI disappears goes to a human check, not silently to another AI.
- Text written by one AI reaches another as `untrusted_ai_*` data, not as instructions.
- **Waiting on you is visible.** When the only things left are human actions (a merge, a decision, confirming a goal), the GUI and an OS notification say what is waiting, with the task/decision/goal IDs. A waiting AI gets the same list from `next` (`none` with `reason` and `waiting_on`).
- **When the work runs out:** once all goals are finished, one AI (a `planner` if there is one) is asked a single time to propose up to three next goals. They are created as *proposed*: nothing starts and no permission widens until you approve one in the GUI (or reject it). If there is still nothing to do after that, waiting AIs receive `stop` and end; after you approve a goal, paste the start phrase again.
- More detail: [docs/self-study/01-technical-audit.md](docs/self-study/01-technical-audit.md).

## Security and known limitations

- Scope and reporting: [SECURITY.md](SECURITY.md). Threat model: [docs/threat-model.md](docs/threat-model.md). Latest review: [docs/security-review.md](docs/security-review.md).
- **Open findings before release:** AI-created goals can reach other AIs as if written by a human (high); an AI can re-use a stopped goal's permissions as a template (medium); and four more medium issues. Fixes are in progress.
- IdleShift cannot stop what an AI does inside its own app. Its delegation settings are requests; enforcement depends on each app's permission settings.
- An attacker running code as the same Windows user can read the service token.
- **Data folder:** `%USERPROFILE%\.idleshift`. Older versions used `%LOCALAPPDATA%\IdleShift`, which the Microsoft Store version of Claude Desktop redirects; `gui` moves old data over automatically on first start ([docs/data-home.md](docs/data-home.md)).

## Vendor terms

You use IdleShift with **your own** accounts, under each vendor's terms. Do not share accounts. Whether long unattended runs or the optional CLI launcher are allowed differs by vendor and can change; if unsure, don't, or use the vendor's pay-as-you-go API instead. IdleShift never works around usage limits. Notes (not legal advice): [docs/tos-notes.md](docs/tos-notes.md).

## FAQ

**Does it read my Claude/ChatGPT usage?** No. It counts claimed tasks and minutes, and listens to what the AI reports.

**Does the AI keep its whole conversation?** No. What survives is what was written to the blackboard: goals, summaries, reports, evidence, files.

**Was IdleShift built by AIs?** The first version was written before IdleShift existed. Since that baseline, features, fixes and reviews have been done by several AIs working through IdleShift itself — "built and improved with itself", not "built with itself". See [docs/self-study/02-history.md](docs/self-study/02-history.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

This project is licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE) for copyright attribution and [TRADEMARKS.md](TRADEMARKS.md) for brand and naming guidelines.
