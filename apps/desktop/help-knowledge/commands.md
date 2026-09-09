---
id: commands
title: Slash commands
summary: Type "/" in the composer to open a palette merging your skills, built-in app commands, and the agent's own commands.
---
Type `/` at the start of the composer to open the command palette.

`/cindy-make-doctor` checks the local Desktop environment without involving an Agent. An expandable card in the current task's message stream shows system/architecture, Git, Git LFS, Node.js, pnpm, Python, native build tools, and available space/write permissions in Cindy's data directory. Progress and rechecks update the same card in place. From the home page, Cindy creates a local task to display the card, without sending a message to an Agent. Compatible existing tools are reused. The check does not install tools, download source, query upstream Issues/PRs, or require a GitHub account. It can be stopped and rerun; results are temporary and are not saved to task history across restarts. Use it on the local Desktop; SSH, device-link, and Mobile entry are not supported in this stage.

Passing these basic checks is not a completed build: source-specific dependencies and packaging prerequisites will be checked in the later build workflow. `/cindy-make` reuses this diagnostic capability as its first step.

**What's in the palette (priority order on collisions):**

1. **Your installed skills** (highest priority) — anything in your global or project skills directory (see the Skills topic).
2. **Built-in app commands** — `/help` (show available commands), `/clear` (clear the current session context — resets the conversation in place without creating a new session), `/cmd` (run a shell command in the working directory), `/issue` (file an issue), `/cindy-make-doctor` (check the local build environment), `/cindy-make` (start preparing a personal Cindy build), `/goal` (start a goal-driven run), `/learn`, `/workflows`, and `/jump-session`.
3. **The agent's own commands** — e.g. `/compact`, `/agents`, `/memory` (the exact list depends on the agent; Claude Code and Codex each contribute their own).

`/issue` does not require a GitHub plugin or GitHub account. The confirmation card uses Cindy's official bot by default; if a working account is already configured under **Plugins > Cindy GitHub**, that account appears as an optional submission identity.

Before submitting, Cindy helps clarify missing details so the issue is actionable. For bugs, it can collect reproduction steps and user-approved, redacted diagnostic summaries; the confirmation card always shows the final public content. After creation, Cindy returns the issue link and can help interested users reproduce or fix the problem from source because Cindy is open source.

`/cindy-make [request]` uses one expandable card in the current task's message stream: **1. Prepare environment → 2. Check upstream**. The request must be supplied after the command; a bare `/cindy-make` only shows usage guidance and does not create a card or start environment checks. It first reuses compatible system tools or previously installed Cindy-managed tools, then downloads and installs missing portable tools. Every required environment check must pass before it automatically searches public Issues and PRs in `makecindy/cindy`. From home, Cindy creates only a local task to hold the card. No model connection or Agent turn is required. Only the explicit slash command starts the workflow; ordinary messages are unaffected, and a same-name Skill retains priority. This stage accepts plain text, not attachments, references or comments. Use it on the local Desktop; SSH, device-link and Mobile entry are not supported.

Portable Node.js, pnpm, Python and Git LFS packages are selected for Windows x64, macOS x64/arm64 and Linux x64/arm64 (glibc). Windows can also install portable MinGit. macOS Git comes with Xcode Command Line Tools; Linux Git comes from the distribution's package manager. Missing system compilers (Visual Studio C++ Build Tools and Windows SDK, Xcode Command Line Tools, or Linux C/C++ tools) show installation instructions in the card. Cindy does not run admin commands or install global tools. At least 2 GiB of free space is required to provision tools; at least 10 GiB is recommended before a build. OS/ABI compatibility is verified by starting each staged tool; a failure is shown for manual installation or retry.

Downloads come from pinned publisher URLs and must pass SHA-256 verification before extraction or execution. Tools are installed under the `cindy-make` subdirectory of Cindy's data directory. Completed tools persist and are reused after restart; failed or cancelled attempts never replace a working tool. Global PATH and Git configuration stay unchanged. `/cindy-make-doctor` can check these managed tools but never installs anything itself.

The card shows download progress and offers Stop while preparing or searching, then Retry after a problem or cancellation. Progress and retries update the same message and keep the request. Successful installs are rechecked automatically; no extra click is needed to start upstream search. Only one preparation/search runs at a time. There is no Back button; rechecking runs the environment checks again before another search and reuses already-installed tools.

Upstream search uses up to three literal keywords extracted from the request and shows those keywords with up to five possible matches. This is a keyword search, not a guarantee of semantic similarity or an exhaustive search. Each result includes its link, number, title, Issue/PR kind, state, and available author, update date and body excerpt. Closed PRs are checked for merge status; if verification fails, that status is explicitly unverified. A closed Issue is not necessarily fixed, and a merged PR is not necessarily in an official release. A successful search with no matches says so; network errors, rate limits and timeouts are shown as failures, never as no matches.

After a successful search, choose **Wait for upstream** or **Continue with a personal version**. This iteration records the choice in the card only: waiting does not subscribe to notifications or enable automatic updates, and choosing a personal version does not yet download source or start a build. Source preparation, code changes, packaging, version switching and upstream merging are later stages. Checks, request text, results and the choice are temporary and disappear when the app reloads or restarts. No GitHub account is required.

**Settings > Cindy Make** runs the same read-only environment check whenever the page opens, with a manual recheck action and an **Open tools directory** button inside the card. Missing portable tools can be installed from the card. This page and `/cindy-make-doctor` remain environment-only; neither starts upstream search. In development builds, **Test Installation: Ignore System Tools** checks portable tools using only Cindy-managed copies and simulates missing Windows native compiler prerequisites so their official installation guide can be tested. System Git and compiler prerequisites on macOS/Linux are checked normally. Turning the switch on only rechecks; click the install button to install missing tools. Completed managed installs are reused. The switch applies immediately within the current window and resets on reload/restart. Packaged builds do not expose or accept this test option. Both checks and preparation cards label results produced with the test switch on.

**Using the palette:**

- Start typing to filter. Matching is **contains-based** (case-insensitive substring matching on the command name) — not fuzzy.
- Up to 25 matches shown at a time.
- **↑ / ↓** move focus, **Enter** runs the focused command, **Esc** closes the palette.

**Notes:**

- If a name collides across sources (same command in a skill and in a built-in), the higher-priority source wins; the lower-priority one is silently skipped (logged as a warning).
- Most built-in app commands run inside the desktop app (a few, like `/workflows` and `/jump-session`, are handled directly in the UI); agent commands are sent as prompt prefixes to the agent.
