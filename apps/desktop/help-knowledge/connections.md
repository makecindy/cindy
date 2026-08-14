---
id: connections
title: Connecting external accounts
summary: External accounts (Google, Jira / Confluence, GitHub, GitLab) are connected on their plugin detail pages under Plugins; Slack and Telegram are bound under Settings > IM bots; Codex sign-in lives in Settings > Model Providers.
---
External account connections have moved out of the old "Third-Party Platforms" section — each integration now lives on its own plugin detail page under **Plugins**, and the plugin's tools use the account you connect there.

**Where to connect what:**

- **Slack** — bound with a single toggle under **Settings > IM bots** (the "Cindy" tab). One browser sign-in covers both directions: the Slack channel bot that receives tasks, and the agent Slack tools (search / read / post). If Slack tools don't work on an older binding, toggle it off and on once to re-authorize.
- **Telegram** — under **Settings > IM bots** (the "Cindy" tab), turn on Telegram and choose **Link Telegram**. Open the one-time link, start the official Cindy bot, and complete confirmation if prompted. The same card lets you cancel, retry, open the bot, add it to a group, or unlink; no personal bot token is required.
- **Google** (Gmail / Calendar / Drive / Sheets) — handled by the Filo Google plugin (Plugins > Filo Google).
- **GitHub** — handled by the Cindy GitHub plugin (Plugins > Cindy GitHub; existing PAT connections are migrated automatically). This connection is optional for `/issue`: feedback uses Cindy's official bot by default, and a working GitHub connection only adds the option to submit as yourself.
- **GitLab** — handled by the Cindy GitLab plugin (Plugins > Cindy GitLab; existing PAT connections are migrated automatically).
- **Codex** — sign in under Settings > Model Providers (separate from the Codex CLI binary the app ships with).
- **FeiShu** — bot only (App ID / Secret under Settings > IM bots; see the FeiShu bot topic). FeiShu is no longer a sign-in method for Cindy itself.
- **Cindy AI** — Settings > Model Providers. Web-search keys are configured on the matching plugin detail page (Cindy Web Search).

**Managing connections:**

- Each plugin detail page shows the connected accounts (with status) and lets you reconnect, disconnect, or switch the default account.
- Disconnect removes the local token only; you may also want to revoke access on the provider's side.
- A connection error usually means the token expired or was revoked on the provider's side; reconnect to refresh.
