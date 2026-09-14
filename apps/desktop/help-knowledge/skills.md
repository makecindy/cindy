---
id: skills
title: Skills (reusable agent capabilities)
summary: Browse, install, disable, uninstall, publish, and update agent skills; installed skills appear as "/" slash commands and are shared across Claude Code and Codex.
---
Skills are reusable agent capabilities you package as a folder and load into your sessions. They're managed on the same page as Plugins — **Skills** and **Plugins** are two tabs of one management surface (the Skills tab is the in-app browser for finding, installing, publishing, and updating skills).

**Skills work with both agents:**

- Skills are **engine-shared** — the same installed skill is available to both Claude Code and Codex, so you install it once.

**Where skills live on disk:**

- Global (available to every session): the shared root `~/.agents/skills/<name>/`, which is cross-linked to `~/.claude/skills/` and `~/.codex/skills/` so every engine sees the same skills. On Windows that's under `C:\Users\<you>\`.
- Project-scoped (only inside one working directory): `<working-dir>/.agents/skills/<name>/` or `<working-dir>/.claude/skills/<name>/`.
- Each skill is its own folder with a required `SKILL.md` at the root (the prompt / spec the agent reads). Sibling files and subfolders in that folder are also visible to the agent.

**Importing a local skill:**

- On the Skills page, use **Import skill** (top-right) to pick a `.zip` package or a standalone `SKILL.md` file.
- A zip must contain a `SKILL.md` (at the package root, or inside a single top-level folder). The YAML frontmatter must include non-empty `name` and `description` fields; `name` must match `^[a-z0-9-]{1,200}$`.
- You then choose where to install: global, a known project, or another directory. Cindy extracts metadata from the file automatically and lists the skill with that name and description.
- Imported skills can be uninstalled from the detail page, and you can publish them to SkillHub later if you want.

**Using an installed skill:**

- Hover over a local skill in the `/` suggestions and choose **View skill details** in its information panel to open that exact skill. This does not insert or send the command. Pi package skills remain usable from `/`, but do not show this local detail shortcut; manage them through their package.

- Type `/` in the composer to open the slash-command palette; your installed skills show up there alongside built-in and agent commands. Pick one to run it.

**Disabling or uninstalling a local skill (Desktop):**

- Open a skill's detail page to use the switch in the top action bar. For a market skill installed in multiple locations, select the local copy from the location dropdown beside the switch. Turning it off keeps the files and removes the skill from new-task command previews. Active tasks retain the skill preference snapshot applied when their Agent started, including their command palette. New or restarted Claude Code, Codex, and Pi agents apply that choice; an already-running agent keeps its existing context.
- Renaming a local skill while publishing keeps its enabled or disabled setting. If renaming fails, Cindy restores the original folder and content.
- The switch is local to this device and Cindy profile. It does not edit external CLI settings, sync to other devices, or override a native engine's own disabled state. Enable it again to let the engine discover it normally.
- In the skill's details, use **… → Uninstall skill**. Confirm the location and shared-file impact. Standalone skills, including locally written skills without a market installation record, move to the system trash. Recovery is through the operating system's trash.
- External source imports remove only their discovery links and keep the external source files. Package-owned or built-in skills must be removed through their owning package; their uninstall action is unavailable here. Skills provided by Cindy plugins are managed on the owning plugin's page, including when discovered through shared skill links.
- Offline removal of an automatically synced skill is remembered on this device, including after restart or sign-in. Automatic sync skips it until you explicitly install it again.
- Uninstalling a shared copy affects external CLIs that use it. It does not unpublish a skill or delete other users' copies. If file removal fails, Cindy keeps the installation. If cleanup is interrupted, the notice offers **Retry cleanup**. The unfinished operation survives closing, reloading, and restarting Cindy; reopen Skills in the same Cindy profile and account to continue. Cindy pauses conflicting installations until cleanup completes. Retrying never moves files to the trash a second time and preserves externally restored or replaced content.

**Publishing your own skill:**

- Find the publish action on the Skills page and point it at the skill's local folder. It zips the folder and uploads it — reading your directory in place, without copying or moving anything.
- On first publish, you set the skill's **visibility**: PUBLIC (anyone in the org) or DEPARTMENT_SCOPED (only the departments you choose).
- The local registry records what you published, so the app knows it's "yours" for future updates.

**Updating an already-published skill:**

- On your own skill's detail page you'll see a **发布新版本** (Publish New Version) button.
- Edit the local folder however you want and publish — the version is **auto-incremented server-side**, you don't pick a number.
- **Old versions stay live alongside the new one.** Users who already installed an older version keep it until they choose to update.
- The display name and description are sent on every republish, so editing those metadata fields just means doing a republish.

**Managing an already-published skill:**

- Change who can see or use your skill from the management menu — public, shared with selected teams / departments, or private to you.
- **Unpublish** makes it private again and returns ownership to your personal scope; it does not remove copies other users already installed.
- **Authorship is fixed.** Only the original author's account can publish new versions of a given skill (enforced server-side as `NOT_AUTHOR`).

**Browsing and installing others' skills:**

- The marketplace lets you install skills into your global skills directory. You can request a specific version on install; the local registry tracks which version you have.

**Notes:**

- A skill folder without a `SKILL.md` at its root won't be picked up (lowercase `skill.md` is also accepted).
- Project-scoped skills only show up in sessions whose working directory matches — useful for skills tied to a particular repo's conventions.
- Editing files inside an installed skill folder takes effect on the next session start; you don't need to reinstall.
- Uninstalling only removes your local copy. For your own published skills, use unpublish or manage visibility to change market availability.

In a new-task draft, the slash hover panel offers detail links for global skills. Project skill detail links are available after creating a task, when SkillHub can include that project in its scan.
