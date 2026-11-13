# Release Checklist (Pre-Publication Final Inspection)

> Generated for `T-320` (`E-8`). No push, remote registration, or public release has been performed.

## 1. Clean-Clone Verification (`README.md` Steps)
- **Tested procedure**: Copied the working tree (excluding `.git`, `node_modules`, `dist`) to a fresh temporary directory with `LOCALAPPDATA` and `IDLESHIFT_HOME` pointed at isolated temporary directories.
- `node bin/idleshift.mjs --version` -> `0.1.0` (exit `0`).
- `npm test` in clean copy -> **213/213 passed** (`0` failed, `0` skipped, exit `0`).
- `node bin/idleshift.mjs service` in clean copy -> `GET /` returned `200`, `GET /i18n/en.js` returned `200` (cleanly shut down via `/api/call` `shutdown`).
- No external npm dependencies required (`node:sqlite` built-in on Node.js 22.13+ / tested on Node 24).

## 2. Repository Hygiene (E-1 Follow-up)
Automated scan across working tree files (excluding `.git`, `node_modules`, `dist`):
- **OS username**: `0` hits.
- **Personal email (`gmail.com`)**: `0` hits in working tree (still present in existing git commit metadata; see Section 7).
- **References to other private projects**: `0` hits in working tree.
- **Secret prefixes (`sk-`, `ghp_`, `AIza`)**: `0` hits.
- **Local workspace path (`AI_HUB\conclavity` / `AI_HUBconclavity`)**: `2` hits in historical/evidence docs (`docs/evidence/quota-routing.md`, `docs/self-study/02-history.md`), plus synthetic drive-relative test/comment examples in `src/core.mjs` (`L41`) and `tests/small-fixes-a5.test.mjs` (`L15`).
- **Fixed Node path (`node-v24.22.1`)**: `2` hits (`restore-data.bat` fallback line, and `docs/install-walkthrough.md` which documents it). Note: `restore-data.bat` is a one-time local restore script tracked in git (`1d4c944`).
- **NUL bytes & line endings (`E-418`, `E-419`)**:
  - `src/core.mjs`: `0` NUL bytes in working tree (`w/lf`), though git index still shows `i/-text` until re-staged.
  - `.gitattributes`: Added (`* text=auto eol=lf`; `*.bat`, `*.cmd`, `*.ps1` `eol=crlf`).
  - `tests/participant-cleanup.test.mjs` and `tests/tier-mcp.test.mjs` show `w/mixed` in working tree (will normalize on commit).
- **Note on `dist/`**: `dist/Conclavity-0.1.0-win-x64*` is gitignored/untracked build output from an earlier `Conclavity` build; rebuild with `npm run dist` before distributing binaries.

## 3. License & Legal Files
- `LICENSE`: Exact match against official `https://www.apache.org/licenses/LICENSE-2.0.txt` (203 lines, CRLF/LF-normalized).
- `NOTICE`: Contains placeholders requiring human completion before release (`Copyright 2026 (公開前に人が決める)`, `https://github.com/TODO-before-release`).
- `TRADEMARKS.md`: Present.

## 4. Documentation Links
Relative link scan across all `.md` files (excluding `.git`, `node_modules`, `dist`):
- All relative file links resolve to existing files, except 2 notation-style references in `docs/threat-model.md` (`A5`, `A6` written in markdown link syntax, not file paths).

## 5. Internationalization (i18n) & English UI Coverage
- **Server & AI-facing (`src/i18n/en.mjs`, `src/i18n/ja.mjs`, `src/core.mjs`)**: Dictionary key & signature parity verified (`tests/i18n.test.mjs`). `ai_language='en'` produces zero Japanese in `join -> next -> claim`, refusals, `startPhrase`, and `wakePrompt`.
- **GUI (`gui/i18n/en.js`, `gui/i18n/ja.js`, `gui/app.js`, `gui/index.html`)**: All `gt(...)` keys verified against both dictionaries; `src/service.mjs` serves `/i18n/en.js` and `/i18n/ja.js` (`200 text/javascript`) while blocking path traversal (`404`). Rendering all 4 tabs (`home`, `connect`, `decisions`, `maintain`) with `ui_language='en'` produces zero Japanese (excluding the native `日本語` language selector option).
- **Decisions (`src/db.mjs` v8)**: `decisions.message_key` & `message_args` format dynamically by language while preserving legacy rows (`message_key IS NULL`).
- **Hosts & CLI (`src/hosts.mjs`, `src/adapters.mjs`, `bin/idleshift.mjs`)**: Localized; `state.hosts` and `state.adapters` contain zero Japanese in `en` mode.

## 6. Test Suite & Known Limitations
- **Full suite (`npm test`)**: **213/213 passed** (`0` failed, `0` skipped).
- **Known limitations** (documented in `README.md` and `docs/`):
  - Windows-only verified (Mac/Linux unsupported).
  - Unpacked/unsigned Windows dist zip triggers SmartScreen warnings.
  - Waiting cost (`next` polling cadence) is app-dependent (see `docs/evidence/waiting-cost.md`).
  - `README.md` (and `README.ja.md`) still reflect earlier pre-release notes in places (e.g., `178 passing`, `Japanese only for now`, and `%LOCALAPPDATA%\IdleShift` migration "is planned"), whereas `213` tests now pass and `ui_language`/`ai_language` + `~/.idleshift` migration are implemented in the working tree.

## 7. Remaining Human-Only Actions Before Public Release
1. **Git history decision**: Done (2026-11-13). The public history starts fresh with a single commit by `Idlesmith <356223813+Idlesmith@users.noreply.github.com>`; the old local history (with private metadata) was kept only in an offline backup, and `restore-data.bat` was removed.
2. **Author name & email**: Set git `user.name` / `user.email` and `package.json` `author` / `repository` if desired.
3. **`NOTICE`**: Replace `Copyright 2026 (公開前に人が決める)` and `https://github.com/TODO-before-release` with the real copyright holder and repository URL.
4. **`CODE_OF_CONDUCT.md`**: Replace `(contact address to be decided before publication)` with a real contact address.
5. **`SECURITY.md`**: Replace `(contact to be decided — e.g. GitHub private vulnerability reporting or an e-mail address)` and remove the top `Draft` warning.
6. **`README.md` / `README.ja.md`**: Replace `<repository-url>` and update the pre-release draft / test count / i18n / data-folder status notes if appropriate.
7. **GitHub repository, push, release & announcement**: Create the remote repository, push, tag/release, and announce.
