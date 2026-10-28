---
id: plugins
title: Plugins (extending what the agents can do)
summary: Where the Plugins page is, the built-in plugins, installing (marketplace, .cindy file, custom marketplaces), enabling / disabling globally or per project, updates, uninstalling, account / key setup, $commands, panels, and the permission model.
tab: ghosts
---
Plugins extend what the agents can do — they add tools the agent can call, panels that live as tabs in the right sidebar, full-page app views, and integrations with outside services. Each plugin is a self-contained `.cindy` package that runs in its own isolated sandbox.

**The Plugins page:**

- Open it from **Plugins** in the left sidebar, or from **Settings > Plugins**. **Plugins** and **Skills** are the two tabs at the top of the same page (see the Skills topic for skills).
- **Installed** lists your plugins; **Recommended** lists plugins from the marketplace, filtered by source: **All / Public / Team shared / Custom**. **Team shared** only appears if your account belongs to an organization.
- Use **Search plugins** to find one. Each card has a quick action — **Use** opens its panel, **Chat** starts a new task with the plugin, **Manage** (or clicking the card) opens its detail page.
- The detail page is where you enable / disable it, connect an account or enter an API key, see what it contains and its version, view **Your calls** (usage), and uninstall it.

**Built-in plugins:**

- **Art** (`$cindy-art`) — create and edit images or generate short videos.
- **Web Search** (`$cindy-web-search`) — public web search. **No key needed**: by default it searches through Cindy AI using your signed-in account's balance (not available in local mode). To use your own service instead, add a Brave, Tavily, or DeepSeek key on its detail page. A failed search is reported as-is; it never silently switches to another source.
- **Mermaid** (`$cindy-mermaid`) — fix and normalize Mermaid diagrams written by the agent.
- **GitHub** (`$cindy-github`) / **GitLab** (`$cindy-gitlab`) — repositories, issues, pull / merge requests, reviews, CI. GitLab also supports self-hosted instances.
- **Gmail**, **Google Drive**, **Google Calendar**, **Google Sheets** — each is a separate plugin and connects its own Google account authorization. Some organization accounts get a single combined **Filo Google** plugin instead.
- **XD Atlassian** (Jira / Confluence) — an enterprise plugin, only for organizations that provide it.
- **Notion**, plus mail plugins such as **iCloud Mail**, **QQ Mail**, and **163 Mail**.
- The exact list can vary by account and organization.

**Installing:**

- Click **Install** on a Recommended plugin, or open **Add plugin** and choose **Install from file…** to pick a `.cindy` file. You can also drag a `.cindy` file anywhere onto the Cindy window, or double-click it in your file manager.
- **Add plugin > Add Plugin Marketplace…** adds a custom marketplace from a GitHub repository, Git URL, or local folder; its plugins then show under **Custom**.
- Before anything is installed, a **confirmation dialog** lists everything the plugin will be able to do (network addresses, credentials, background tasks, skills, bundled code, panels…). Nothing is installed until you confirm; after that the plugin is enabled right away.
- When you ask an agent to install a plugin, the same confirmation appears as a card in that task — whatever the task's permission mode, including Full Access. This also works from your phone when you control this computer remotely. If you deny it, nothing is installed.
- Plugins installed for you by default (for example, ones your organization rolls out) are installed and updated without a confirmation.

**Updates:**

- Updates from the marketplace are applied automatically when the plugin is idle — **as long as the new version doesn't need more permissions**. If it does, the old version keeps working and the card shows "New permissions need confirmation"; click Update to review and confirm the added permissions.
- When updates are waiting, the page shows "N plugin updates available" with **Update all** (or **Ignore this round**). Failed updates retry later; you can retry right away from there.

**Enabling, disabling, and uninstalling:**

- **Enable / disable** with the switch on the plugin's detail page. Disabling puts its tools and panel to sleep but keeps the plugin installed (its card shows **Disabled**).
- **Off for one project only** — use the scope picker at the top of the Plugins page to choose a project (**Project Scope**), then turn the plugin off there. In that project's tasks it behaves as if it isn't installed (its tools and `$command` are unavailable); everywhere else it stays on. Its card shows **Off in this project**. A plugin disabled globally must be enabled in the **Global** view first.
- **Uninstall** from the detail page (**Uninstall plugin**). Its panel and capabilities are removed; its layout spot is restored if you install it again.
- Enabling or disabling takes effect on the agent's **next** query, not in the current turn.

**Panels and app views:**

- A plugin's panel appears as a tab in the right sidebar and stays across tasks. If you close it, reopen it with **Open in the sidebar** on the plugin's detail page, or from the right sidebar's **+** menu.
- Plugins with a full-page view appear in the left sidebar (under **More** by default; use **Customize** to move one to the top). Right-click one to **Open as page**, **Open in the sidebar**, or **Open in a separate window**.

**Configuring a plugin's account / API key:**

- Do it on the plugin's **detail page**. Plugins that use a key or token (optional search keys for Web Search, GitHub / GitLab / Notion tokens, mail app passwords) have a field there; the value is stored encrypted on this computer and can't be read back.
- Plugins that use account authorization (for example the Google plugins) show a button to connect your account instead.
- If you try to use a plugin that isn't set up yet, Cindy asks you to open its settings first.

**Using a plugin with `$command`:**

- Type its command at the **start** of a message — e.g. `$cindy-art a poster for…`. Only enabled plugins that declare that command match; a matched command turns into a pill with the plugin's icon.
- You can also pick a plugin from the composer's **+** menu, which puts its command at the start for you.
- You don't have to use `$command`: the agents can also pick an enabled plugin's tools on their own when a task calls for it.

**Creating your own plugin:**

- Choose **Add plugin > Create with Cindy**. Cindy opens a new-task draft that uses the built-in plugin creator Skill (`cindy-plugin-creator`); describe what you want and send it with your chosen agent and model.
- That Skill can create, edit, debug, package, and publish plugins. Packaging produces a `.cindy` file; installing and publishing are separate steps you ask for when ready.

**The permission / sandbox model (why plugins are safe):**

- A plugin's sandbox has **no direct file, network, or system access**. Cindy carries out every operation on its behalf.
- Background behavior is limited to what the plugin declared and you approved at install. Whether a plugin tool call in a task runs follows that task's normal permission mode.
- Network access on its own is limited to the addresses the plugin declares. Credentials never enter the sandbox — Cindy adds them only to requests going to the declared address.
- So a plugin **can't see your files** on its own. A file reaches a plugin only when you or the agent explicitly hand one over (for example an image attachment, or a folder you approve).

**Notes:**

- You can manage the plugins installed on your other computers from the same page by switching the computer at the top (the target computer must be online and on a recent Cindy version).
