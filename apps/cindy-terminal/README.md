# Cindy Terminal

The terminal host runs on Node without Electron or a display server. `cindy`
opens the TUI; `cindy serve` runs the foreground host. Profiles isolate accounts,
models, tasks, plugins and device identities. Use `--profile <name>` consistently
when managing a host. `cindy --help` lists the available commands.

Development builds use `pnpm --filter cindy-terminal build`, then
`node apps/cindy-terminal/dist/cli.js`. Platform packages include Node and native
dependencies; build them on the target OS with `scripts/package-runtime.mjs`.
The platform acceptance workflow checks the packaged executable, PTY, WebRTC and
resident service. This package is under development; a passing smoke test does
not establish full Desktop/Mobile feature parity.

`cindy tasks clear <id>` clears the selected session's context using the same
host operation as the GUI. Add `--device <id>` to clear a remote session.
The TUI exposes this in the session's Commands menu (Ctrl+P → Clear context).

`cindy tasks import-scan --json` lists local native CLI history without importing
it. Pass selected entries as `{"items":[{"source":"codex","id":"<native-id>"}]}`
to `cindy tasks import --stdin`; `source` also accepts `claude`. These commands use
the GUI's existing history scanner and importer on the host computer.

## Provider authorization

In the TUI, choose Models → Add provider, choose a preset and select OAuth
when offered. The provider can then be connected from its configuration menu.
`cindy providers login --provider <id>` opens the same login surface;
`--device <id>` performs authorization on the selected remote host. Device-code
providers show an authorization URL and code. For browser callbacks completed
on another computer, paste the final callback URL into the masked input.
The existing encrypted controller exchange carries that input to the host.
Access and refresh tokens stay in its account-scoped encrypted vault.

`cindy providers status --provider <id>` reports connection state;
`cindy providers logout --provider <id>` disconnects that saved provider.
`cindy providers login --provider openai` uses the official Codex device-code
login. It works through the same protected remote configuration surface. The
host keeps its OpenAI login in the current Cindy account's encrypted vault and
routes Codex, Claude Code and Pi through a private proxy. It does not reuse or
modify `~/.codex` credentials.

`cindy providers login claude-code` connects an existing official Claude CLI
subscription, or launches `claude auth login --claudeai` in the foreground.
Claude credentials stay exclusively in the CLI's default credential store.
`cindy providers logout claude-code` revokes Cindy's permission to use that login;
it does not log out the CLI. A different Cindy account must explicitly connect.
The native Pi CLI's own `/login` remains available through the engine menu.

Engine installation, updates and repairs can target another terminal host with
`cindy engines list|install|update|repair [engine] --device <id>`. The Models
page advertises the same engine controls when the selected host supports them.
Installations continue on that host if the controller disconnects; a failed
installation preserves the previous executable. Switching Cindy accounts aborts
that account's pending installation. Reopening the engine page shows its result.

## Plugin task settings

`cindy plugins` opens installed plugins on the selected host. Task-capable plugins
expose their model and default permission settings, plus a Background tasks link.
Changing the default model affects new tasks; existing tasks retain their selected
model. Lowering a plugin's default permission prevents its existing higher-permission
tasks from accepting further plugin input. Uninstalling a plugin reveals its hidden
tasks while preserving their history.

GUI clients use the same host preferences, including reasoning effort and Fast
mode where the selected model supports them. Remote plugin management supports
market and uploaded `.cindy` installations, confirmation and cancellation,
global and per-project enablement, sidebar visibility, and uninstall receipts.
An outdated settings page must be refreshed before it can overwrite a newer edit.

After declining a plugin's write request, open its task locally and choose
“Confirm plugin write permission again” from the task command menu. Over SSH,
run `cindy attach <id>` on that server. The matching CLI inspection command is
`cindy tasks plugin-permission <id>`; append `retry` to request confirmation again.
The pending question can be answered in another attached TUI or with `cindy requests`.
This recovery operation retains Desktop's local-owner boundary.

## Local models

Models → Local models opens Ollama and llama.cpp on the selected computer. Installation uses
verified official macOS, Windows or Linux archives. Linux zstd extraction uses
the included Node runtime. Starting Ollama executes `ollama serve`; it never
opens a desktop application. A managed server stores model weights inside its
owner profile. An already running external Ollama can also be used; filesystem
cleanup never touches that external server's model directory.

`cindy local-models` opens the same TUI. CLI operations accept `--device <id>`:

```sh
cindy local-models install ollama
cindy local-models get ollama
cindy local-models download ollama --stdin
# stdin: {"name":"<Ollama model name>"}
cindy local-models list
cindy local-models pause '<Ollama model name>'
cindy local-models resume '<Ollama model name>'
cindy local-models disable '<Ollama model name>'
cindy local-models install llamacpp
cindy local-models files llamacpp --stdin
# stdin: {"repo":"<Hugging Face organization/repository>"}
cindy local-models download llamacpp --stdin
# stdin: {"repo":"<organization/repository>","file":"<model.gguf>"}
cindy local-models start llamacpp
cindy local-models stop llamacpp
```

Long operations return a host-owned job. `get` reports its status and progress;
disconnecting the controller does not cancel a download. Pause state survives
host restart for Ollama. llama.cpp supports pause/resume while the host stays
running; stopping that host cancels its incomplete transfer. Changing the Cindy
account retires its active operations. Enable
and disable use the same saved model visibility settings as other providers.
`delete` removes downloaded weights; `cancel` discards an incomplete download.

llama.cpp verifies the official runtime archive and each GGUF shard before
publishing them. Its selected-host model list includes the shared curated
catalog and files discovered from a Hugging Face repository. Starting a task
starts an installed router when needed. An explicit Start/Restart applies newly
downloaded models and context settings; downloads never restart active tasks.

## Headless plugin browser

The host, login and model configuration do not need a browser on the server.
Plugins that execute browser code use a separate, ephemeral Chromium sandbox.
Cindy first looks for system Chrome/Edge/Chromium, then downloads its pinned
Chromium on demand. It never opens the user's personal browser profile.

```sh
cindy browser status
cindy browser install
cindy browser check
cindy doctor
```

`status` only locates an existing executable. `install` prepares the browser and
checks it. `check` runs the actual sandbox with a blank page and no external
request. `doctor` also reports browser readiness without downloading anything.
These commands take `--profile` and `--json`.

On Linux, install the distribution's browser runtime dependencies if the check
reports `BROWSER_SYSTEM_DEPENDENCIES_MISSING`. A system browser package usually
installs those dependencies together. Run the host as a normal user; root is not
a supported Chromium sandbox identity.

Ubuntu 23.10+ can restrict user namespaces for a downloaded Chromium binary.
If the check reports `BROWSER_SANDBOX_UNAVAILABLE`, an administrator can review
and install the exact-binary AppArmor profile:

```sh
cindy browser sandbox-profile > cindy-terminal-chromium.apparmor
sudo install -m 644 cindy-terminal-chromium.apparmor /etc/apparmor.d/cindy-terminal-chromium
sudo apparmor_parser -r /etc/apparmor.d/cindy-terminal-chromium
cindy browser check
```

Use the same Cindy profile for each command. Regenerate the policy if the browser
executable path changes. The rule permits that executable to create user
namespaces; review ownership and write access to the executable and its parents
before installing it. It does not disable the system-wide restriction or
Chromium's sandbox. See the
[Chromium AppArmor documentation](https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md).

## Remote credentials

TUI plugin credential forms submit through a local protected controller. The
controller pins the target device identity and installed plugin revision, then
uses the existing signed, encrypted settings exchange. The target's original
credential endpoint owns persistence. Generic remote resource actions reject
raw credential submissions. Unsupported peers must be upgraded for that form;
there is no plaintext fallback.

Ordinary CLI actions accept JSON from `--stdin`; keep secrets out of shell
arguments, scripts checked into Git, and task messages. Plugin HTML settings and
declarative credential forms use the same target vault.


Independent ChatGPT and SuperGrok accounts can be added from **Models → Add
connection**. Each entry keeps its own encrypted credentials and discovered
models on the selected computer; disconnecting one leaves other accounts intact.
Claude subscriptions continue to use the original Claude Code login.

For automated engine updates behind a shared GitHub egress address,
`CINDY_GITHUB_API_TOKEN` can supply a short-lived read-only token to the update
command. It is sent only to `https://api.github.com` release metadata requests,
never release downloads or native CLI children. `RELEASE_RATE_LIMITED` means the
lookup must be retried after GitHub's quota resets; existing engines are retained.

Model context limits use the same owner-scoped preferences and runtime refresh as Desktop. In the TUI, open a provider and choose **Context limit**. The CLI supports `cindy models context get|set|reset <model> [tokens] --provider <id> --engine <engine>`; `--device <id>` selects a remote terminal host. Reset removes the override and follows the catalog again.
