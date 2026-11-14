# Changelog

All notable changes to this project are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Renamed the project from Conclavity to IdleShift.
- Folder registration refuses relative paths, missing folders and files, with a reason.
- The refusal for write tasks in a goal without write delegation now points to `ask_permission`.
- `IdleShift.bat` no longer falls back to a machine-specific Node path; it explains how to install Node instead.

- Offers defer write/implement tasks for participants whose usage window is high (default 90%) and skip those at 100% until the reset.
- `add_goal` accepts a finished goal as template, or no goal at all (safe default delegation).
- Merging task worktrees works without a configured Git identity and on Git older than 2.38 (legacy conflict preview); cleanup failures are recorded and shown; merges are refused while the main tree is in detached HEAD.

### Added
- AI usage windows (5-hour / weekly): automatic import from Codex session logs and from Claude Code / Antigravity statusline caches (collectors vendored from quota-clock, MIT), a 5-minute background sync, `idleshift usage sync|list|set|rm`, self-reported `quota.windows` in `join`/`report`, the MCP tool `usage`, a usage panel and usage rings on the home screen. Database schema v9.
- Human-wait detection: `next` and the GUI say which merge, decision or confirmation is awaited, with a one-time notification.
- Idle handling: when no work is left, a planner proposes next goals once (they wait as `proposed` for human approval) and waiting AIs are then stopped.
- Checklist for verifying IdleShift on another PC (`docs/other-pc-checklist.md`).
- Rename a project from the GUI.
- Design notes: data folder location, git worktree isolation, threat model, measurement plan.

## [0.1.0] - unreleased

- First version: local MCP blackboard service, relay, GUI, task assignment with generations, budgets, tiers, usage limits, backups and restore protection. Windows only.
