# Searching, uploading and updating Skills in SkillHub

Use the relevant workflow when the user asks to find a Skill in SkillHub, upload their own Skill, or publish changes to their existing Skill. For example: “找一个生成发布说明的技能”, “在组织里搜索代码审查技能”, “把这个 Skill 上传到 SkillHub，只给我自己用” or “把我的 release-notes Skill 更新到线上”. Searching does not install or publish anything. If the user only asks to create or edit local files, finish that work without publishing.

## Discover the host tools

Use the available `cindy_helper` MCP server: call `list_tools` with `category: "skills"`, then invoke the returned tools through `call_tool`. This category includes `search_skills`, `list_my_published_skills`, `publish_skill`, and `get_skill_publish_status`. Use their returned schemas. The host reuses Cindy's signed-in identity, catalog search, packaging, upload, registry and review services; no API key or separate CLI setup is needed.

These tools run on the Cindy desktop hosting the current task. Phone/device-link conversations controlling that task use the same tools. SSH tasks cannot upload remote paths through the local host: make the Skill available on the Cindy host and publish from a local task. If the tools are unavailable, explain that limitation and direct the user to the Skills page; do not invent endpoints or read Cindy's credential files.

## Search the public marketplace or organization

Call `search_skills` with a short `query` describing the requested capability. Use `scope: "market"` for an explicitly public-market request and `scope: "team"` for an organization-only request. When the user has not specified a scope, omit it: the host searches both catalogs for organization identities and only the public marketplace for personal identities. Organization search uses the signed-in organization's existing access permissions, not a user-supplied organization identifier.

Present relevant results with their name, description, author, version and public/organization source. Keep `catalog_scope` with each result: identical names from different catalogs are not interchangeable. Each catalog has its own `next_cursor`; for more results, pass that cursor and its explicit `scope` with the same query. If one catalog fails, show the available results and say which catalog could not be searched; an empty page or a failed catalog does not prove no matching Skill exists elsewhere.

Use `list_my_published_skills`, not catalog search, when locating the user's own publication for an update. Search results alone do not establish authorship. If the user wants to install a result, use an available installation workflow or direct them to the matching source on the Skills page; do not claim search installed it.

## Prepare the local folder

Identify the exact Skill folder from the user’s path, the Skill just created in this task, or the installed local copy. A folder must contain `SKILL.md` with valid YAML `name` and `description`; include the scripts, references and assets it needs. For a supplied ZIP, inspect and extract it with the current Agent's file tools into a task-specific directory first. A lone `SKILL.md` should be placed in its own folder. Inspect the package contents and preserve the user's files.

For a newly authored Skill, validate with this Skill's `scripts/quick_validate.py`. Existing Skills may have additional valid frontmatter such as `version`; preserve that metadata even if the authoring validator flags unsupported keys. The upload tool validates YAML, `name` and `description` against the publishing contract. Check that the folder contains only the intended Skill and its resources; remove credentials or unrelated private files from the upload copy. Pass an absolute folder path and a `name` matching its frontmatter. If changing the published name, update a separate copy when needed rather than silently renaming the user's source.

## First upload

Call `list_my_published_skills` to see the signed-in identity's allowed visibility choices and locate any existing publication; follow `next_cursor` if needed. Choose `mode: "create"` only for a new publication. Ask for visibility if the user's request does not already specify it:

- `private`: only the personal owner; available to personal identities.
- `shared`: organization sharing; available to organization identities. Ownership comes from the signed-in identity. Supply audience teams/departments only through `visible_slugs` when the user specifies those targets; do not guess identifiers or send owner selectors such as `team_slug`.
- `public`: public SkillHub publication, subject to review. Never infer public visibility from “upload”.

Call `publish_skill` with `path`, `name`, `mode: "create"`, and `visibility`. Include an appropriate `display_name`, `summary` and `tags` when available. Use the existing user request as authorization; do not ask them to reconfirm a complete request.

## Update a published Skill

Locate the exact publication with `list_my_published_skills`; updates require `is_creator: true` and `can_manage: true`. A listed or manageable Skill is not necessarily authored by this account; missing authorship information is not permission to update it. Edit the intended local folder and validate it, then call `publish_skill` with `mode: "update"`, its existing `name`, the local `path`, and an optional `changelog`, `display_name` or `summary`.

The server assigns the next version. Do not guess a version number or manually increment one for this workflow. Updates preserve visibility, ownership and tags: omit those fields. Managing a team Skill does not necessarily make the user its original author; `NOT_AUTHOR` means the current account cannot upload a new version. Do not evade it by silently creating another publication.

## Report the result

Report the returned name and version. `status: "uploaded"` confirms upload, not review approval or public availability. Use `get_skill_publish_status` with that exact name/version to inspect the scan or review result. If pending, explain that it is awaiting review and stop polling; if rejected, explain the returned reason and address it before publishing again when requested.

On a timeout or uncertain result, first inspect the published list and version status. Do not automatically repeat an upload that may have committed. Sign-in, identity, folder access, manifest and author errors should be resolved for the same intended publication; they are not reasons to broaden visibility or create a duplicate.
