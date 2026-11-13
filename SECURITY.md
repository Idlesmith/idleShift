# Security Policy

> Draft. The reporting contact is not decided yet. Do not publish this file until the contact below is filled in.

## Supported versions

IdleShift is pre-1.0. Only the latest released version receives security fixes.

| Version | Supported |
|---|---|
| latest release | yes |
| older | no |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

- Report privately to: **(contact to be decided — e.g. GitHub private vulnerability reporting or an e-mail address)**
- Include: affected version, Windows version, steps to reproduce, and what an attacker gains.
- Remove tokens, user names in paths and project content from logs before sending.

We aim to acknowledge reports within 7 days and to agree on a disclosure date with the reporter. (Best effort: this is a small project.)

## What IdleShift protects, and what it does not

IdleShift is a local service on one Windows PC. Its threat model is in [docs/threat-model.md](docs/threat-model.md); the latest review is in [docs/security-review.md](docs/security-review.md).

In scope:
- Web pages opened in a browser on the same PC (DNS rebinding, CSRF against the local GUI).
- Other users of the same PC without administrator rights.
- An AI participant that is wrong, confused or malicious: it must not be able to widen its own delegation or budget, confirm completion, read other projects, or make its text look like the human's.
- Malformed backups or repository content.

Out of scope:
- Malware or an attacker running code as **the same Windows user** (it can read the data folder and the service token).
- Administrator or SYSTEM level attackers.
- Vulnerabilities in the AI apps, AI services or their CLIs.
- What an AI does inside its own app (editing files, running commands). IdleShift's delegation settings are requests to the AI; enforcement is up to each app's own permission settings.

## Known limitations

- The service token is protected by the data folder's file permissions (`service.json` `mode: 0o600` has no effect on Windows, so protection relies on folder ACLs). Do not point `IDLESHIFT_HOME` at a shared or temporary folder (e.g. under `%TEMP%`, where inherited ACLs may grant read access to sandbox groups).
- The GUI receives its token in the URL fragment once; it may remain in the browser history and the launch command line of the same user.
- Windows only. Code is not signed; Windows SmartScreen may warn.
- Self-review exclusion checks active connections (`conn`). Disconnecting and rejoining on a new connection with a new label is not blocked, and projects using only a single shared connection (e.g. multiple windows sharing one MCP relay) need a second connection or app to run reviews.
- When registering IdleShift in Claude Code, if `mcp remove` succeeds and the subsequent `mcp add-json` fails, the previous registration may remain removed until re-run.
