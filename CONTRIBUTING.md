# Contributing to IdleShift

Thank you for your interest. IdleShift is a small project; the rules below keep it safe and easy to review.

## Before you start

- IdleShift runs on **Windows** today. Mac and Linux are not supported yet.
- It needs **Node.js 22.13 or later** (it uses the built-in `node:sqlite`). It has **no npm dependencies**, and we intend to keep it that way. Please do not add packages without discussing it in an issue first.
- For security problems, do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Development

```
node bin/idleshift.mjs gui      # start the service and open the GUI
npm test                         # run all tests
```

- Tests must never touch your real data. Set `IDLESHIFT_HOME` to a temporary folder when you experiment by hand; the test helpers do this for you.
- Tests remove their temporary folders on exit. Set `IDLESHIFT_KEEP_TMP=1` to keep them for debugging.

## Principles a change must keep

1. **The human decides.** Adding permissions, confirming completion and stopping work are human-only actions. An AI must never be able to widen its own delegation or budget through MCP.
2. **No silent AI launches.** IdleShift does not start AI tools unless a person enabled an adapter, and never with all-permissions flags.
3. **Text written by an AI is data.** Keep it in `untrusted_ai_*` fields and render it as plain text in the GUI (no `innerHTML`).
4. **No network access** from IdleShift itself.
5. **Do not lose data.** Schema changes go through a versioned migration with a backup.

## Pull requests

- Keep each pull request focused on one change.
- Add or update tests for behaviour you change. `npm test` must pass.
- Update `CHANGELOG.md` under "Unreleased".
- Describe what you verified and what you could not verify.

## Code style

- ES modules, no build step.
- Match the style of the surrounding code. Comments explain *why*, not *what*.
