---
id: skills
title: Skills (reusable agent capabilities)
summary: Create, search, browse, install, disable, uninstall, publish, and update agent Skills; Skills appear as "/" slash commands and are shared across Claude Code, Codex, and Pi.
---
Skills are reusable agent capabilities you package as a folder and load into your sessions. They're managed on the same page as Plugins — **Skills** and **Plugins** are two tabs of one management surface (the Skills tab is the in-app browser for finding, installing, publishing, and updating skills).

**Skills work across local agents:**

- Skills are **engine-shared** — the same installed Skill is available to Claude Code, Codex, and Pi, so you install it once.

**Where skills live on disk:**

- Global (available to every session): the shared root `~/.agents/skills/<name>/`, which is cross-linked to `~/.claude/skills/` and `~/.codex/skills/` so every engine sees the same skills. On Windows that's under `C:\Users\<you>\`.
- Project-scoped (only inside one working directory): `<working-dir>/.agents/skills/<name>/` or `<working-dir>/.claude/skills/<name>/`.
- Each skill is its own folder with a required `SKILL.md` at the root (the prompt / spec the agent reads). Sibling files and subfolders in that folder are also visible to the agent.
- Global and project discovery roots may also contain one namespace/container level (for example an author folder): Cindy checks each discovery root's direct children, then their direct children, and stops there. A folder with `SKILL.md` is a Skill; its child folders are skill resources, not separate Skills.

**Importing a local skill:**

- On the Skills page, use **Import skill** (top-right) to pick a `.zip` package or a standalone `SKILL.md` file.
- A zip must contain a `SKILL.md` (at the package root, or inside a single top-level folder). The YAML frontmatter must include non-empty `name` and `description` fields; `name` must match `^[a-z0-9-]{1,200}$`.
- You then choose where to install: global, a known project, or another directory. Cindy extracts metadata from the file automatically and lists the skill with that name and description.
- Imported skills can be uninstalled from the detail page, and you can publish them to SkillHub later if you want.

**Using an installed skill:**

- Hover over a local skill in the `/` suggestions and choose **View skill details** in its information panel to open that exact skill. This does not insert or send the command. Pi package skills remain usable from `/`, but do not show this local detail shortcut; manage them through their package.

- Type `/` in the composer to open the slash-command palette; your installed skills show up there alongside built-in and agent commands. Pick one to run it.

**Creating or learning a Skill from the composer:**

- Cindy includes `/cindy-skill-creator`. Invoke it with a description of the Skill you want, such as `/cindy-skill-creator Create a Skill that checks release notes`. Invoking it without a description asks what you want to create.
- The current Agent creates or updates the Skill directly with its normal file tools. It does not use the `/learn` staging flow.
- Ask for a Skill in the composer, for example “Find a release-notes Skill” or `/cindy-skill-creator Search our organization's code-review Skills`. The Agent can search SkillHub's public marketplace or your organization's catalog. Without a specified scope, organization identities search both; personal identities search the public marketplace. Results identify their source, including when two Skills share a name. Search alone does not install anything.
- You can also ask `/cindy-skill-creator` to upload your own Skill to SkillHub or publish a new version directly in the conversation. Give the local Skill folder (or the Skill just created) and, for a first upload, who should be able to access it. Ordinary local creation/editing does not automatically publish it.
- Uploads use Cindy's signed-in account, which determines ownership; choosing sharing targets does not change that ownership. The Agent can list your published Skills, upload the folder, and check scan/review status. Upload success does not mean public approval. Updating requires confirmed original authorship and management access, and preserves visibility and ownership; a missing authorship flag is not treated as permission. This works in a local desktop task, including when controlled from a phone; SSH files must first be made available on the Cindy host.
- Each Agent upload or version update follows the task's permission mode: Ask requests approval for that publication, Auto reviews it against your request, and Full Access bypasses operation approval. A previous helper-tool approval does not authorize later publications. Search, listing, and status queries remain automatic.
- Unless you request another location, new Skills go to `~/.agents/skills/<name>/`. Ask for a project-specific Skill to create it under `<working-dir>/.agents/skills/<name>/`.
- Cindy also includes `/learn`. Bare `/learn` distills the current task; `/learn <description>` learns from a described workflow; `/learn hub:<scope>:<slug> [instructions]` learns from a SkillHub Skill. Cindy gathers evidence, runs the distillation in a separate task, and shows a diff for review before saving the proposed Skill.
- The built-in `cindy-skill-creator` and `learn` entries appear in the local Skill list with an Official badge. You can disable or enable either entry there; because they ship with Cindy, they cannot be uninstalled. The setting applies to new or restarted Agent sessions. Disabling `learn` also disables the **Learn this skill** action in SkillHub after the local Skill list has refreshed.

**Disabling or uninstalling a local skill (Desktop):**

- Open a skill's detail page to use the switch in the top action bar. For a market skill installed in multiple locations, select the local copy from the location dropdown beside the switch. Turning it off keeps the files and removes the skill from new-task command previews. Active tasks retain the skill preference snapshot applied when their Agent started, including their command palette. New or restarted Claude Code, Codex, and Pi agents apply that choice; an already-running agent keeps its existing context.
- Renaming a local skill while publishing keeps its enabled or disabled setting. If renaming fails, Cindy restores the original folder and content.
- For a Skill inside a namespace/container folder, renaming changes only the Skill's own folder name; the namespace stays the same.
- The switch is local to this device and Cindy profile. It does not edit external CLI settings, sync to other devices, or override a native engine's own disabled state. Enable it again to let the engine discover it normally.
- In the skill's details, use **… → Uninstall skill**. Confirm the location and shared-file impact. Standalone skills, including locally written skills without a market installation record, move to the system trash. Recovery is through the operating system's trash.
- External source imports remove only their discovery links and keep the external source files. Package-owned Skills must be removed through their owning package. Cindy's built-in Skills cannot be uninstalled, but they can be disabled. Skills provided by Cindy plugins are managed on the owning plugin's page, including when discovered through shared Skill links.
- Offline removal of an automatically synced skill is remembered on this device, including after restart or sign-in. Automatic sync skips it until you explicitly install it again.
- Uninstalling a shared copy affects external CLIs that use it. It does not unpublish a skill or delete other users' copies. If file removal fails, Cindy keeps the installation. If cleanup is interrupted, the notice offers **Retry cleanup**. The unfinished operation survives closing, reloading, and restarting Cindy; reopen Skills in the same Cindy profile and account to continue. Cindy pauses conflicting installations until cleanup completes. Retrying never moves files to the trash a second time and preserves externally restored or replaced content.

**Publishing your own skill:**

- Find the publish action on the Skills page and point it at the skill's local folder. It zips the folder and uploads it — reading your directory in place, without copying or moving anything.
- On first publish, choose visibility: personal identities support public or private; organization identities support public or organization sharing. Public publication is subject to review.
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
