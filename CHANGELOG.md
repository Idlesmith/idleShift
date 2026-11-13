# Changelog

All notable changes to this project are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Renamed the project from Conclavity to IdleShift.
- Folder registration refuses relative paths, missing folders and files, with a reason.
- The refusal for write tasks in a goal without write delegation now points to `ask_permission`.
- `IdleShift.bat` no longer falls back to a machine-specific Node path; it explains how to install Node instead.

### Added
- Rename a project from the GUI.
- Design notes: data folder location, git worktree isolation, threat model, measurement plan.

## [0.1.0] - unreleased

- First version: local MCP blackboard service, relay, GUI, task assignment with generations, budgets, tiers, usage limits, backups and restore protection. Windows only.
