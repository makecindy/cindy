# Claude multi-account (profiles) — design

> Status: design + phase 1 implementation (core modules, no behaviour change yet).
> Branch: `feat/claude-multi-account`. Owner: CODER7657 fork.

## 1. Goal

Let one Cindy user keep **several Claude subscription accounts logged in at once** and switch the
account a task runs on **without logging in again**, while:

- the **master** account keeps working exactly as today (`~/.claude`, no `CLAUDE_CONFIG_DIR`);
- every account **reads and writes the master's local memory** (`CLAUDE.md`, per-project memory,
  transcripts, skills, plugins, agents, commands, settings);
- nothing from an extra account's cloud (claude.ai connectors) leaks into the user's work;
- an unfinished task can be **picked up by another account** with full understanding and the
  **fewest possible tokens**.

Non-goals:

- **No automatic account rotation** when a usage limit is hit. Switching is always a user action.
  Rotating accounts to get around Anthropic's limits breaks Anthropic's terms.
- No Cindy-owned OAuth. See §2.

## 2. Compliance constraint (why the old "independent Claude accounts" were retired)

Anthropic only allows a Claude subscription to be used through **the unmodified official Claude
Code CLI and its own login**. Third-party apps must not provide Claude.ai login or collect, store or
relay subscription credentials (`claude-native-cli.ts` header,
`credentials-and-local-storage.md`). Cindy's earlier independent Claude accounts ran their own
OAuth and stored tokens, so they were retired (`CLAUDE_ACCOUNT_RETIRED_REASON`).

This design keeps the rule by construction:

- An extra account is **only a separate CLI config directory** (`CLAUDE_CONFIG_DIR`).
- Login is `claude auth login --claudeai` run by the bundled CLI with that directory. Status is
  `claude auth status --json`.
- The CLI writes, reads and refreshes `.credentials.json` itself. **Cindy never reads, copies,
  moves or links `.credentials.json`.** The linker has an explicit deny-list for it, with tests.
- Sessions are spawned with `CLAUDE_CONFIG_DIR=<profile>`. Every other subscription rule (no
  `ANTHROPIC_BASE_URL`, no injected tokens, credential env keys stripped) is unchanged.

The existing rule "local CLI sessions must not set `CLAUDE_CONFIG_DIR`" still applies to the
**master** account. Extra accounts are the single, explicit exception.

## 3. Storage layout

```
~/.claude/                       ← MASTER config dir (unchanged, user-owned)
~/.claude.json                   ← MASTER account state (unchanged)

<userData>/owners/<owner>/claude-accounts/
  registry.json                  ← account list + active id (no secrets)
  <accountId>/                   ← EXTRA account = CLAUDE_CONFIG_DIR
    .credentials.json            ← written by the CLI only; never touched by Cindy
    .claude.json                 ← CLI account state; seeded once with master `mcpServers`
    projects   ⇒ junction → ~/.claude/projects       (transcripts + per-project memory)
    skills     ⇒ junction → ~/.claude/skills
    agents     ⇒ junction → ~/.claude/agents
    commands   ⇒ junction → ~/.claude/commands
    plugins    ⇒ junction → ~/.claude/plugins
    output-styles ⇒ junction → ~/.claude/output-styles
    todos      ⇒ junction → ~/.claude/todos
    file-history ⇒ junction → ~/.claude/file-history (rewind/checkpoints survive a switch)
    plans      ⇒ junction → ~/.claude/plans
    CLAUDE.md      ⇐ hard link to ~/.claude/CLAUDE.md
    settings.json  ⇐ hard link to ~/.claude/settings.json
    .cindy/conflicts/            ← a losing copy is kept here, never deleted silently
```

Why these link types:

- **Directory junctions** need no admin rights or Developer Mode on Windows, and they work across
  volumes. On macOS/Linux the same call makes a directory symlink.
- **File hard links** keep `CLAUDE.md` / `settings.json` as one file with two names, so a write
  through either path lands in the master. They need the same volume: `userData` and `~` are both
  on `C:` here. Across volumes the linker falls back to **mirror mode** (see §4.3).
- Because transcripts live in the shared `projects/`, **every existing reader of
  `~/.claude/projects` keeps working unchanged** (local sessions, import, export, anchors,
  resume). That is the main simplification of this design.

## 4. Components

### 4.1 Account registry (`claude-accounts/registry.ts`)
- Pure state plus an injected JSON store. The master entry (`id: 'master'`) is **always present
  and cannot be removed**.
- Extra ids are generated (`acct_<random>`). User input never becomes a path.
- Fields: `id, kind, label, createdAt, lastUsedAt?, identity? {email, subscriptionType}`.
  `identity` comes from `auth status` and is for display only.
- Atomic writes (temp file + rename). A corrupt or unknown-version file → master only, and the bad
  file is kept as `registry.json.corrupt-<ts>`.
- The same email cannot be added twice. The registry rejects duplicates, and duplicates of the
  master too.

### 4.2 Account env resolver (`claude-accounts/accountEnv.ts`)
- `master` → `{}`. The CLI uses its default dir, exactly as today.
- extra → `{ CLAUDE_CONFIG_DIR: <profileDir> }`. Before each spawn the linker must verify the
  profile (`prepare`). A failed prepare **blocks the spawn** with a typed error; it never silently
  falls back to master.

### 4.3 Profile linker (`claude-accounts/profileLinker.ts`)
Idempotent `prepare(profileDir, masterDir)`, run before every CLI spawn on an extra account
(a few `lstat`s, usually under 2 ms):

1. Create a missing master shared dir (empty) so every junction has a real target.
2. For each shared dir:
   - missing → create the junction;
   - correct junction → ok;
   - a real directory (the CLI created it before linking) → **merge** its entries into the master
     (no overwrite; name clashes go to `.cindy/conflicts`), then replace it with a junction;
   - a junction to the wrong target → re-point it.
3. For each shared file:
   - same file id (`dev`+`ino`) → ok;
   - profile file only → move it into the master, then hard link;
   - both exist but differ (the link was broken by an atomic rewrite) → the **newer** content wins
     and becomes the master. The older copy is saved in `.cindy/conflicts`. Then relink.
   - Hard link not possible (`EXDEV`, `EPERM`) → mirror mode: copy master→profile before the spawn
     and profile→master after the turn, newer wins, the same conflict rules apply.
4. Never touch `.credentials.json` or `.claude.json`. These names are hard-denied in code.

`remove(profileDir)`:
1. Unlink every known link entry (a junction or hard link removes **only the link**).
2. Re-scan: if any symlink or junction remains, **abort**.
3. Only then `rm -r` the profile dir.

There is a regression test that the master's files survive removal.

### 4.4 Per-account CLI state (phase 2)
- `claude-native-cli` gets an `accountId` parameter on status, login and plan usage. The cache is a
  map keyed by account. The existing single-account API maps to the active account.
- Login for a new account: create the profile → `prepare` → `claude auth login --claudeai` with
  that profile's env → `auth status`. Not a subscription, or a duplicate email → roll back and
  remove the profile.

### 4.5 Switching and session binding (phase 2)
- **Active account**: global, persisted in the registry, shown in Settings and in a composer
  switcher.
- Each Cindy session records the `claudeAccountId` its current CLI process was spawned with. Env
  is fixed at spawn time, so on the next turn, if the active account differs, the session's CLI
  process is rebuilt with the new env and **resumes the same SDK session id**. The transcript is
  in the shared `projects/`, so the new account sees the whole history.
- A running turn always finishes on the account it started on. Switching never interrupts a turn.
- Collaboration (Orca): each Worker can be pinned to an account. The Lead and Workers default to
  the active account.

### 4.6 Mission handoff: zero-token pickup (`claude-accounts/handoff.ts`)
Prompt caches are per account, so a full resume on a new account re-reads the whole context
**uncached** on its first turn. The handoff planner gives a cheap alternative and states the cost
of each option. It is built **only from local data** and uses **no model tokens**:

- **Context size**: from the last assistant `usage` in the transcript
  (`input + cache_creation + cache_read`).
- **Mission snapshot**, parsed from the transcript JSONL:
  - the original goal (first real user prompt);
  - the latest user instructions;
  - the last plan/todo state (`TodoWrite` input);
  - the last assistant progress text;
  - the last compact summary, if any;
  - files touched (`Edit` / `Write` / `MultiEdit` / `NotebookEdit` paths);
  - unresolved tool errors;
  - whether the last action was **interrupted** (a `tool_use` with no `tool_result`).
- **Options**:
  - `resume`: same session, full fidelity. Estimated cost ≈ context tokens, once.
  - `brief`: a new session seeded with the rendered Mission Brief (usually 1–3k tokens). It tells
    the agent to check the current file state first and not redo completed steps.
- **Recommendation**: `resume` when the context is at most 40k tokens, otherwise `brief`. The user
  always chooses. Nothing is sent anywhere until they confirm.

### 4.7 claude.ai connectors (phase 2)
Extra accounts must not load MCP connectors from that account's claude.ai cloud. To verify against
the real CLI during phase 2: does it honour a documented switch for claude.ai MCP servers? If not,
deny the reported `claude.ai *` servers via flag-settings `deniedMcpServers` (that mechanism
already exists in `capability-routing.ts`).

### 4.8 Usage and limits (phase 2)
- Plan usage is read per account (`get_usage` with that account's env) and shown per account.
- When a limit is reached, the UI shows it and offers the handoff dialog. It **never switches
  automatically**.

## 5. Diagnostics and testing aids
- **Health check** (Settings → Claude accounts → "Check"). Per account it shows:
  - link state (ok / repaired / broken) with the exact path;
  - mirror mode;
  - login state and identity;
  - last used;
  - quota.
- **Handoff preview** ("Preview pickup"): shows the snapshot, the brief and both token estimates
  for the current task without switching.
- **Smoke script** `scripts/claude-accounts-smoke.mjs`. It runs on the real file system in a temp
  dir and checks:
  - linking works;
  - a write through the profile reaches the master;
  - a broken hard link is repaired with the conflict copy kept;
  - removal keeps the master intact;
  - `.credentials.json` is never linked.

  It exits non-zero on any failure.
- Structured logs under the `claude-accounts` logger. Paths are logged; file contents and
  credentials never are.

## 6. Failure modes

| Case | Behaviour |
| --- | --- |
| Profile dir deleted outside Cindy | The account shows "needs login"; prepare recreates the links; the user logs in again |
| Master `~/.claude` missing | Prepare creates the shared dirs; the master stays usable |
| Hard link broken by an editor | Detected by file id; newer wins; the other copy goes to `.cindy/conflicts` |
| Different volumes | Mirror mode, flagged in the health check |
| Account logged out in the CLI | Status shows logged out; a spawn on it is refused with "log in again" |
| Two accounts writing memory at once | Same as two sessions on one account today (append-only transcripts, last write wins on `CLAUDE.md`) |
| Registry corrupt | Master only, the bad file kept, a warning logged |
| Same email added twice | Rejected |

## 7. Phases
1. **Core** (this change): registry, profile linker, env resolver, handoff snapshot/brief, smoke
   script, this doc. Unit tests for each. No runtime wiring, so no behaviour change.
2. **Runtime**:
   - per-account status/login/usage in `claude-native-cli`;
   - `getAuthEnv` and maker-core env carry the account's `CLAUDE_CONFIG_DIR`;
   - session binding and rebuild-on-switch;
   - Orca per-Worker account;
   - connector deny.
3. **UI**:
   - accounts list on the Claude Code provider card (add / switch / log out / remove / check);
   - the composer switcher;
   - the handoff dialog;
   - per-account quota.
