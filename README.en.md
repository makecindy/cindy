<p align="center">
  <img src="apps/mobile/assets/splash/cindy-splash-illustration.webp" alt="Cindy" width="200" />
</p>

<p align="center">
  <strong>CONSIDER IT DONE.</strong><br />
  An all-in-one AI assistant that operates your computer to get real work done — not just answer questions.
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License" /></a>
  <a href="https://github.com/makecindy/cindy/actions/workflows/ci.yml"><img src="https://github.com/makecindy/cindy/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-22.x-brightgreen.svg" alt="Node.js 22.x" /></a>
  <a href="https://pnpm.io"><img src="https://img.shields.io/badge/pnpm-10-orange.svg" alt="pnpm" /></a>
</p>

<p align="center">
  🌐 <a href="https://cindy.cn">国内版</a> | <a href="https://cindy.app">海外版</a>
</p>

<p align="center">
  ⬇️ <a href="https://cindy.cn/#download">China download</a> | <a href="https://cindy.app/#download">Global download</a>
</p>


Cindy runs locally on your own machine, uses your files and logged-in apps, and
is powered by Claude Code and Codex as
its underlying agent engines. It can drive your browser, computer, and phone,
coordinate multiple agents as a team, and dispatch tasks from IM and schedules.

This repository is the open-source **client** for Cindy — the desktop and mobile
apps plus their shared packages, organized as a pnpm monorepo.

The client is free to use, and its source code is open under Apache-2.0. Charges
apply only when you use Cindy-provided tokens or APIs. You can also configure
your own API key. See the [China site](https://cindy.cn/#pricing) or the
[global site](https://cindy.app/#pricing) for service details, pricing, and
downloads.

## What's in this repo

| Path | Description |
| --- | --- |
| `apps/desktop` | Electron desktop client |
| `apps/mobile` | Expo / React Native mobile client |
| `packages/*` | Shared client capabilities (auth, device-link, agent orchestration, model providers, …) |
| `apps/*-bin` | Tool binaries shipped with the desktop app; only android-platform-tools is committed (via Git LFS) — claude-code, codex, and ripgrep are downloaded per platform by `pnpm install` and never checked in |
| `cindy-protocol/` | Wire protocol shared with the server (git submodule) |

**Not in this repo:** the backend service lives in a separate
repository and is not part of this monorepo.

| Mode | Account requirement | Availability |
| --- | --- | --- |
| Hosted service | Cindy cloud account | Use Cindy's full hosted service. See [China pricing](https://cindy.cn/#pricing) or [global pricing](https://cindy.app/#pricing). |
| Local mode | No Cindy sign-in required | Choose “Local mode” on the login screen to use local agents. Server-backed capabilities are unavailable in this mode. |

## Prerequisites

- **Node.js** 22.x
- **pnpm** 10.x (v11 is not yet supported)
- **Git LFS**

## Getting started

Contributor setup, public submodule initialization, Git LFS, dependency updates,
and access requirements are maintained in
[`CONTRIBUTING.en.md`](CONTRIBUTING.en.md).
The public checkout only needs the protocol submodule; plugins are installed through
SkillHub or manually.

Minimal entry point:

```bash
git clone https://github.com/makecindy/cindy.git
cd cindy
git submodule update --init --recursive cindy-protocol
git lfs pull
pnpm install
```

## Development entry points

```bash
# China-region Cindy account
pnpm restart:desktop:remote --region=cn

# Global-region Cindy account
pnpm restart:desktop:remote --region=global
```

Remote development uses your own Cindy cloud account and existing login state, so
you can continue existing sessions and work while developing the client. Use `cn`
for China accounts and `global` for overseas accounts; do not rely on the internal
default. Full desktop, mobile, data-isolation, and validation workflows are in
[`CONTRIBUTING.en.md`](CONTRIBUTING.en.md).

“Local mode” on the login screen is an unauthenticated local-agent mode, not a
connection to a local server. Server-backed capabilities are unavailable in this
mode.

**About the default servers:** the client connects to Cindy's official cloud
services by default (endpoint manifests in
[`config/endpoint.json`](config/endpoint.json) and
[`config/endpoint.global.json`](config/endpoint.global.json); desktop
auto-updates also come from the official CDN). This is intentional — external
developers don't need to self-host a server: sign in with your own Cindy
account in a dev build and develop / test directly against the official
servers.

## Architecture

- [`DESIGN.md`](DESIGN.md) — visual design system, color tokens, and UI conventions
- [`docs/README.md`](docs/README.md) — complete documentation and rules index
- [`CONTRIBUTING.en.md`](CONTRIBUTING.en.md) — contributor setup, validation, and submission workflow
- [`AGENTS.md`](AGENTS.md) — engineering rules, launch/runtime contracts, and module boundaries
- [`docs/dev-rules/`](docs/dev-rules/) — deep-dive architecture docs (e.g. Orca multi-agent orchestration)

## Contributing

Contributions go through pull requests into `main`. Read
[`CONTRIBUTING.en.md`](CONTRIBUTING.en.md) first, then use
[`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md).
Please also follow [`CODE_OF_CONDUCT.en.md`](CODE_OF_CONDUCT.en.md). For ordinary
usage questions, see [`SUPPORT.en.md`](SUPPORT.en.md); report security issues
privately through [`SECURITY.en.md`](SECURITY.en.md).

## Security

Never commit credentials or authorization files to the working tree. If you
discover a security issue, follow [`SECURITY.en.md`](SECURITY.en.md) to report it
privately rather than opening a public issue.

## Privacy & telemetry

**Official distribution builds** include [TapDB](https://www.taptap.io/tapdb)
usage analytics for product-level aggregate statistics (device / OS / app-version
metadata; associated with your account ID after sign-in). It does **not** collect
chat content, file content, or working-directory data. In addition, while signed
in to a cloud account the client sends an online heartbeat to Cindy services
(account ID, platform, and version only). Crash dumps stay on the local machine
and are never uploaded automatically.

**Building from source?** You are not required to keep analytics:

- Mobile is off by default — without TapDB credentials (`clientId` /
  `clientToken`) injected at build time, `apps/mobile/src/analytics/mobileTapdb.ts`
  is a no-op;
- Desktop can be fully stripped by removing the `initTapdb()` call in
  `apps/desktop/src/renderer/index.tsx` (implementation lives in
  `apps/desktop/src/renderer/analytics/`).

## License / 许可证

Except as otherwise noted, the source code in this repository is licensed under
the [Apache License, Version 2.0](LICENSE). Individual source files do not
carry per-file license headers; the repository-root `LICENSE` governs.

Model weights, datasets, prompts, trademarks, and other separately identified
materials may be subject to their own license terms and are not automatically
covered by the repository-level Apache-2.0 grant. Third-party open-source
components retain their own copyright and license. Their attribution notices and
SPDX SBOMs are managed under [`docs/legal/`](docs/legal/), with artifact-specific
outputs in [`docs/legal/notices/`](docs/legal/notices/). See [`NOTICE`](NOTICE)
for this project's copyright and attribution information.
