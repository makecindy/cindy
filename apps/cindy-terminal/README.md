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

## Headless Linux / VPS deployment

Use a normal Unix user on a glibc Linux host. The core host and TUI do not need
Electron, a desktop session or a display server. The following source-build
route is for testing this development package, not a published stable release.
Build on the target OS and architecture; Windows builds cannot be packaged for
Linux. Use Node 22.12+ from the Node 22 line and the repository's pnpm version.

From the repository root on the Linux server:

```sh
pnpm install --frozen-lockfile
pnpm --filter cindy-terminal build
node apps/cindy-terminal/scripts/package-runtime.mjs \
  --out "$HOME/.local/lib/cindy-terminal" --target linux-x64
export PATH="$HOME/.local/lib/cindy-terminal:$PATH"
cindy --version
```

Use `linux-arm64` on an ARM64 host. The output directory must not already exist.
The package includes its Node runtime and native dependencies. Keep it at a
stable path: service registration records absolute executable paths. Add the
PATH entry to your shell configuration if desired.

Builds default to Global. For Mainland China, build with
`CINDY_AUTH_REGION=cn pnpm --filter cindy-terminal build` before packaging and use
a separate profile such as `vps-cn`. The region is embedded in the executable;
changing the service's environment does not change its account endpoints.

### First login and device access

Connect over SSH with a TTY and use the same profile for every command:

```sh
cindy --profile vps vault setup --machine-key
cindy --profile vps login
cindy --profile vps models
cindy --profile vps config set deviceName my-vps
cindy --profile vps config set remoteEnabled true
cindy --profile vps devices list
cindy --profile vps doctor
```

Machine-key mode allows unattended restarts without a desktop Secret Service.
The key is stored locally and protected by filesystem permissions; protect the
Unix account and its profile directory. Passphrase mode instead requires vault
unlocking after a restart. Login and Models are interactive TUI screens; finish
account login and configure a provider and default model before running tasks.
For provider authorization from another computer, see the next section.

Remote access is disabled by default. Sign into the same Cindy account on the
controller and use Device Link to find the enabled host. Client compatibility
and the network path still need to be verified with your actual controller.

### Keep the host running after SSH logout and reboot

On a systemd Linux host, run these commands as the same ordinary user:

```sh
cindy --profile vps service install
cindy --profile vps service activate
cindy --profile vps service boot
cindy --profile vps service status --json
```

`install` registers a user service. `activate` transfers a manually started host
to the service manager; it refuses to interrupt active tasks unless you explicitly
request `--stop-tasks`. Finish those tasks before activating or enabling boot.
`boot` enables user lingering and starts the service so it can survive logout and
start without an interactive login. If the machine's policy prevents this, ask
its administrator to enable lingering for your Unix user with
`sudo loginctl enable-linger <username>` and make its systemd user manager available,
then retry. A minimal container without systemd cannot use this service route;
`cindy --profile vps serve` runs the host in the foreground.

Verify that service status reports both registration and a running process.
Repeat the check from a new SSH session after logout, and after a reboot when
practical. For systemd logs, use the installation ID returned by service status:

```sh
journalctl --user -u <installation.id> -f
```

Systemd captures stdout/stderr in the journal; `cindy service logs` reads the
separate host log file and is not a replacement for the service journal.
Use `service stop`, `service restart` and `service uninstall` with the same
profile to manage it. Uninstalling the service preserves profile data and does
not disable lingering for other services owned by that user.

Profile data defaults to `~/.local/state/CindyTerminal/profiles/vps`, or
`$XDG_STATE_HOME/CindyTerminal/profiles/vps` when set. User units are installed
under `~/.config/systemd/user`, or `$XDG_CONFIG_HOME/systemd/user`. Keep these
environment values consistent between setup and service management. Plugins
that use a browser need the additional checks under [Headless plugin browser](#headless-plugin-browser).

### Restricted outbound networks

Account region and model-provider connectivity are separate. A Mainland China
build still needs access to the selected provider and to engine download sites.
Check `cindy --profile vps engines list --json` before installing: an installed
engine does not need another Install operation to sign in or configure a model.
`cindy --profile vps resources list engines --json` also reports pending install
jobs. A TUI showing Loading after Install may be waiting for a download; closing
the TUI does not cancel that host-owned job.

If the workstation has an HTTP proxy listening on localhost port 7897, run this
on the workstation and keep the SSH connection open:

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 -R 127.0.0.1:17897:127.0.0.1:7897 user@server
```

The server-side proxy listens only on loopback. For a systemd-managed host,
use `systemctl --user edit <installation.id>` as the Cindy Unix user and add:

```ini
[Service]
Environment="HTTP_PROXY=http://127.0.0.1:17897" "HTTPS_PROXY=http://127.0.0.1:17897"
Environment="http_proxy=http://127.0.0.1:17897" "https_proxy=http://127.0.0.1:17897"
Environment="NO_PROXY=localhost,127.0.0.1" "NODE_USE_ENV_PROXY=1"
```

This Node fetch proxy option requires a supporting runtime, such as Node 22.22.0
used for Linux deployment validation. Reload the user manager with
`systemctl --user daemon-reload`, then run `cindy --profile vps service restart`.
The restart refuses to interrupt active tasks. Setting proxy variables only in
an SSH shell does not update an already running systemd service.

The workstation, proxy and SSH tunnel must remain available while this route is
in use. This is not an unattended egress solution. A reachable HTTPS endpoint
returning 403 establishes connectivity, not successful provider authorization.
When retiring the tunnel, remove its proxy drop-in and restart the host after
active tasks finish, or configure another working outbound route.

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

### Custom API-key provider

Cindy account login does not supply a third-party provider's API key. For a
Codex connection whose endpoint supports Responses, choose `openai-responses`
explicitly. Use the provider's exact model ID and API base URL, including `/v1`
when required. In the TUI, blank optional request headers are valid.

For example, in Bash on the target host (replace the URL and model ID):

```bash
set +x
read -r -s -p 'Provider API key: ' provider_key
printf '\n'
if [ -n "$provider_key" ]; then
  printf '%s' "$provider_key" | cindy --profile vps providers add \
    --provider custom-codex --name 'Custom Codex' --engine codex \
    --url 'https://provider.example/v1' --protocol openai-responses \
    --model '<model-id>' --key-stdin
fi
unset provider_key
```

Run this with shell tracing disabled (`set +x`); the key is read without echo
and passed through stdin, not a command-line argument. After saving succeeds:

```sh
cindy --profile vps models use '<model-id>' --provider custom-codex --engine codex
cindy --profile vps chat 'Reply only OK. Do not use tools.' --once \
  --provider custom-codex --engine codex --model '<model-id>' --json
```

The second command sends a real inference request and may incur a charge.
A saved/connected provider means credentials are configured; a completed reply
verifies the actual model route. To replace an existing key, use
`providers edit custom-codex --engine codex --key-stdin` instead of adding the
same ID again.

### Engine management

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
