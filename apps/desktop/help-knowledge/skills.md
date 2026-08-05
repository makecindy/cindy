---
id: skills
title: Skills (reusable agent capabilities)
summary: Browse, install, publish, and update agent skills; installed skills appear as "/" slash commands and are shared across Claude Code and Codex.
---
Skills are reusable agent capabilities you package as a folder and load into your sessions. They're managed on the same page as Plugins — **Skills** and **Plugins** are two tabs of one management surface (the Skills tab is the in-app browser for finding, installing, publishing, and updating skills).

**Skills work with both agents:**

- Skills are **engine-shared** — the same installed skill is available to both Claude Code and Codex, so you install it once.

**Where skills live on disk:**

- Global (available to every session): the shared root `~/.agents/skills/<name>/`, which is cross-linked to `~/.claude/skills/` and `~/.codex/skills/` so every engine sees the same skills. On Windows that's under `C:\Users\<you>\`.
- Project-scoped (only inside one working directory): `<working-dir>/.agents/skills/<name>/` or `<working-dir>/.claude/skills/<name>/`.
- Each skill is its own folder with a required `SKILL.md` at the root (the prompt / spec the agent reads). Sibling files and subfolders in that folder are also visible to the agent.

**Using an installed skill:**

- Type `/` in the composer to open the slash-command palette; your installed skills show up there alongside built-in and agent commands. Pick one to run it.

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
