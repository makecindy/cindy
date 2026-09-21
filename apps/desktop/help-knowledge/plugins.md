---
id: plugins
title: Plugins (extending what the agents can do)
summary: What plugins are, how to browse / install / enable / disable them, per-working-directory control, the permission model, and invoking one with a $command.
tab: ghosts
---
Plugins (internally "意识" / Ghost) extend what the agents can do — they add AI-callable tools, dockable UI panels, and "ask Cindy to make it" media generation. Each plugin is a self-contained `.cindy` capability pack that runs in its own isolated sandbox.

**The Plugins page:**

- Open it from the **Plugins** entry in the left sidebar.
- Browse by origin: **all / built-in / team-shared / external**. The team-shared (enterprise) group only shows if your account belongs to an organization.
- Each plugin has a detail page — that's where you enable it, connect an account / enter an API key, and read what it can do.

**Built-in plugins that ship with the app:**

- **Cindy Art** (`$cindy-art`) — generate and edit images and short videos.
- **Cindy Web Search** (`$cindy-web-search`) — public web search (add your own Brave or Tavily key on its detail page).
- **Cindy Mermaid** (`$cindy-mermaid`) — build / repair Mermaid diagrams.
- **Cindy GitHub** (`$cindy-github`) / **Cindy GitLab** (`$cindy-gitlab`) — read / write issues, PRs / MRs, reviews, CI, releases.
- **Filo Google** (`$filo-google`) — Gmail / Calendar / Drive / Sheets.

**Enabling and disabling:**

- **Enable / disable (globally)** from the plugin's detail page. Disabling puts its tools and panel to sleep but keeps the plugin installed — its layout position is remembered and restored when you re-enable it.
- **Disable for one working directory only** — a plugin can be turned off just for a specific project. In that project's sessions it behaves as if it isn't installed (its tools and `$command` are unavailable there); everywhere else it stays on.

**Installing:**

- Install from the marketplace, or add a `.cindy` file manually (drag it in / pick it from disk).
- Choosing Install, dragging a package, or picking one from disk installs and enables the selected plugin directly. Installation does not add a permission or version-confirmation step; review its declared capabilities on the plugin detail page.
- The server selects the release appropriate for this Cindy version before marketplace delivery. Desktop does not apply a second `minCindyVersion` gate; custom marketplaces and local `.cindy` packages follow the same install policy.
- Updates from stable marketplace sources are applied automatically when the plugin is idle. Failed attempts retry later; you can still click Update to retry immediately.

**Using a plugin with `$command`:**

- Type its command at the **start** of a message — e.g. `$cindy-art a poster for…`. Only enabled plugins that declare that command match.
- You don't have to use `$command`: the agents can also pick an enabled plugin's tools on their own when a task calls for it.

**The permission / sandbox model (why plugins are safe):**

- A plugin's sandbox has **no direct filesystem, network, or system access**. The host mediates every operation and enforces its actual execution context.
- Autonomous/background plugin behavior must stay within the capabilities and scopes declared directly in its manifest. Whether an in-flight plugin tool runs is decided by the existing Agent authorization flow; network and working-directory operations bind to that call, while bundled code and CLIs continue to use the existing Node worker. Plugin authors do not need a client change or a manifest Slot to pre-register a specific command, host, or path.
- **Autonomous network** access is limited to a domain allowlist the plugin declares; the host proxies every request. Credentials never enter the sandbox — the host injects them only into declared requests whose target matches that declaration.
- Because of this, a plugin **can't see your files** on its own. A file reaches a plugin only when you or the agent explicitly hand one over (an image attachment, or a directory the host passes through after an ownership check).

**Configuring a plugin's account / API key:**

- Do it on the plugin's **detail page**. Plugins that use a key (web-search, GitHub/GitLab tokens) have a field there; the value goes straight into the host's encrypted store and can't be read back.
- Plugins that use OAuth (for example Filo Google) show a **Connect account** button instead.

**Notes:**

- Enabling or disabling a plugin takes effect on the **next** agent query, not retroactively in the current turn.
- Skills (`/` slash commands) and Plugins (`$` commands) are two tabs of the same management surface — see the Skills topic for skills.
