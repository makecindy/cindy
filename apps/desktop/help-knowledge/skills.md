---
id: skills
title: Skills (reusable agent capabilities)
summary: Where the Skills page is; create, import, search, install, edit, disable, uninstall, publish, update, and manage visibility of agent Skills; Skills appear as "/" slash commands and are shared across Claude Code, Codex, and Pi.
---
Skills are reusable agent capabilities you package as a folder and load into your sessions. They're managed on the same page as Plugins: click **Plugins** in the sidebar (or **More → Plugins** if you've hidden it), then the **Skills** tab (the same page is also under **Settings > Plugins > Skills**). The Skills tab lists **Local Skills** on this computer and the **SkillHub** catalog (filters **Public**, **Organization**, **Managed**) for finding, installing, publishing, and updating skills.

- When another computer is linked, use the **Manage computer** picker at the top of the page to view, install, update, or uninstall skills on that computer instead.

**Skills work across local agents:**

- Skills are **engine-shared** — the same installed Skill is available to Claude Code, Codex, and Pi, so you install it once.

**Where skills live on disk:**

- User-created or imported global skills (available to every session): the shared root `~/.agents/skills/<name>/`, which is cross-linked to `~/.claude/skills/` and `~/.codex/skills/` so every engine sees the same skills. On Windows that's under `C:\Users\<you>\`.
- Project-scoped (only inside one working directory): `<working-dir>/.agents/skills/<name>/` or `<working-dir>/.claude/skills/<name>/`.
- Cindy’s preinstalled skills and plugin-provided skills are kept in Cindy-managed directories and loaded into local Claude Code, Codex, and Pi sessions. Cindy does not add them to the user’s shared skill directories, so external CLIs do not discover them automatically. User-created and imported skills keep the locations above.
- Each skill is its own folder with a required `SKILL.md` at the root (the prompt / spec the agent reads). Sibling files and subfolders in that folder are also visible to the agent.
- Skills can also be grouped one folder deep (for example inside an author folder); deeper nesting isn't scanned. A folder with `SKILL.md` is a Skill; its subfolders are that Skill's resources, not separate Skills.

**Importing a local skill:**

- On the Skills page, use **Import skill** (top-right) to pick a `.zip` package or a standalone `SKILL.md` file.
- A zip must contain a `SKILL.md` (at the package root, or inside a single top-level folder). The YAML frontmatter must include non-empty `name` and `description` fields; `name` may contain only lowercase letters, digits, and hyphens.
- You then choose where to install: global, a known project, or another directory. Cindy extracts metadata from the file automatically and lists the skill with that name and description.
- Imported skills can be uninstalled from the detail page, and you can publish them to SkillHub later if you want.

**Using an installed skill:**

- Type `/` in the composer to open the slash-command palette; your installed skills show up there alongside built-in and agent commands (see the Slash commands topic). Pick one to run it.
- Hover over a local skill in the `/` suggestions and choose **View skill details** in its information panel to open that exact skill. This does not insert or send the command. In a new-session draft this works for global skills; project skill details become available once the session has been created. Pi package skills remain usable from `/`, but don't show this shortcut; manage them through their package.

**Creating or learning a Skill from the composer:**

- To create a Cindy **plugin** (a `.cindy` package) rather than a Skill, choose **Add plugin > Create with Cindy** on the Plugins page; it uses the separate built-in plugin creator (see the Plugins topic).
- Cindy includes `/cindy-skill-creator`. Invoke it with a description of the Skill you want, such as `/cindy-skill-creator Create a Skill that checks release notes`. Invoking it without a description asks what you want to create.
- The current Agent creates or updates the Skill directly with its normal file tools. It does not use the `/learn` staging flow.
- Ask for a Skill in the composer, for example “Find a release-notes Skill” or `/cindy-skill-creator Search our organization's code-review Skills`. The Agent can search SkillHub's public marketplace or your organization's catalog. Without a specified scope, organization identities search both; personal identities search the public marketplace. Results identify their source, including when two Skills share a name. Search alone does not install anything.
- You can also ask `/cindy-skill-creator` to upload your own Skill to SkillHub or publish a new version directly in the conversation. Give the local Skill folder (or the Skill just created) and, for a first upload, who should be able to access it. Ordinary local creation/editing does not automatically publish it.
- Uploads use Cindy's signed-in account, which determines ownership; choosing sharing targets does not change that ownership. The Agent can list your published Skills, upload the folder, and check scan/review status. Upload success does not mean public approval. Updating requires that you're the original author and can manage the Skill, and preserves visibility and ownership. This works in a local desktop session, including when controlled from your phone; Skills on an SSH host must first be copied to this computer.
- Each upload or version update follows the session's permission mode: Ask requests approval for that publication, Auto reviews it against your request, and Full Access doesn't ask. Each publication is approved on its own. Search, listing, and status checks don't need approval.
- Unless you request another location, new Skills go to `~/.agents/skills/<name>/`. Ask for a project-specific Skill to create it under `<working-dir>/.agents/skills/<name>/`.
- Cindy also includes `/learn`. Bare `/learn` distills the current session; `/learn <description>` learns from a described workflow; `/learn hub:<scope>:<slug> [instructions]` learns from a SkillHub Skill. Cindy gathers evidence, runs the distillation in a separate session, and shows a diff for review before saving the proposed Skill (see also the Slash commands topic).
- The built-in `cindy-skill-creator` and `learn` entries appear in the local Skill list with an Official badge. You can disable or enable either entry there; because they ship with Cindy, they cannot be uninstalled. The setting applies to new or restarted sessions. Disabling `learn` also disables the **Learn this skill** action in SkillHub after the local Skill list has refreshed.

**Disabling or uninstalling a local skill (Desktop):**

- Open a skill's detail page to use the switch in the top action bar. For a market skill installed in multiple locations, select the local copy from the location dropdown beside the switch. Turning it off keeps the files and removes the skill from the `/` palette of new sessions. Running sessions keep the skills (and command palette) they started with; new or restarted Claude Code, Codex, and Pi sessions apply the change.
- Renaming a local skill while publishing keeps its enabled or disabled setting. If renaming fails, Cindy restores the original folder and content.
- For a Skill inside a namespace/container folder, renaming changes only the Skill's own folder name; the namespace stays the same.
- The switch is local to this device and Cindy profile. It does not edit external CLI settings, sync to other devices, or override a native engine's own disabled state. Enable it again to let the engine discover it normally.
- In the skill's details, use the **⋯** button next to the switch → **Uninstall Skill**. Confirm the location and shared-file impact. Standalone skills, including locally written skills without a market installation record, move to the system trash. Recovery is through the operating system's trash.
- External source imports remove only their discovery links and keep the external source files. Package-owned Skills must be removed through their owning package. Cindy's built-in Skills cannot be uninstalled, but they can be disabled. Skills provided by Cindy plugins are managed on the owning plugin's page.
- Offline removal of an automatically synced skill is remembered on this device, including after restart or sign-in. Automatic sync skips it until you explicitly install it again.
- Uninstalling a shared copy affects external CLIs that use it. It does not remove the published skill or delete other users' copies. If file removal fails, Cindy keeps the installation. If cleanup is interrupted, the notice offers **Retry cleanup**, even after restarting Cindy (reopen Skills with the same account); installs that would conflict wait until cleanup finishes.

**Viewing and editing a local skill:**

- Click a skill under **Local Skills** to open its detail page: its files and frontmatter, an **Edit** / **Save** action for editing files in place, and a **Usage** panel (last 30 days of local use, with **Diagnose this Skill**, which creates a new session with usage stats filled into the composer; it doesn't send automatically).

**Publishing your own skill:**

- On a local skill's detail page, click **Publish to Market**. Cindy packs the skill folder in place (nothing is copied or moved) and uploads it.
- On first publish you set the display name, description, version, optional tags, and **Visibility**: personal identities choose **Public** or **Only me**; organization identities choose **Public** or **Team** (and can publish as a team). Public publication goes through review; the detail page shows the review status.
- Cindy records what you published, so it knows the skill is yours for future updates.

**Updating an already-published skill:**

- On your skill's detail page, click **Publish new version**. The **Version** field is pre-filled with the next patch version (format `x.y.z`); you can change it. Describing what changed is required.
- Publishing a new version doesn't change visibility. Users who installed an older version keep it until they update (**Get update** on the market card, or **Update to v…** on the detail page).

**Managing an already-published skill:**

- In the SkillHub catalog (the **Managed** filter lists skills you can manage), open the skill's **Manage** menu: **Edit info** (display name and description), **Manage visibility** (**Public** / **Team** / **Only me**; choosing Public submits the current version for review, Only me removes it from the market), **Clone**, and **Delete**.
- **Delete** removes the cloud release from the market and team access and can't be undone. Copies other users already installed, and your local files, are not affected.
- Only the original author — or, for team-published skills, the team's admins and publishers — can publish new versions.

**Browsing and installing others' skills:**

- Search the SkillHub catalog, then click **Clone** on a skill and choose an install location: **Global**, one of your **Projects**, or **Other directory**. If a skill with the same name already exists there, Cindy asks before overwriting and keeps a backup of the old copy.

**Notes:**

- A skill folder without a `SKILL.md` at its root won't be picked up (lowercase `skill.md` is also accepted).
- Project-scoped skills only show up in sessions whose working directory matches — useful for skills tied to a particular repo's conventions.
- Editing files inside an installed skill folder takes effect on the next session start; you don't need to reinstall.
- Uninstalling only removes your local copy. For your own published skills, use **Manage visibility** or **Delete** to change market availability.
