// Installed in the project so all engines can discover settings on demand.
export const PROJECT_SETTINGS_PATH = '.cindy/settings/README.md';

export function isStandardProjectSkill(slug: string): boolean {
  return slug === 'hand-off';
}

export const PROJECT_SETTINGS_GUIDE = `# My settings

Start in your own conversation with the owner. Ask cindy_helper for get_teammate_state. Read settings.device, the current permission mode, the profile version, the model selection and its source, the memory switch and the local connection status. A project task may lack these tools. Report which setting you could verify in this context.

To save a profile change from this project, write .cindy/settings/profile.json with the current expectedVersion and just the fields to change (name, description, identitySource, userContextSource, avatar or modelChain). For example, with profile version 3: {"expectedVersion":3,"description":"Family assistant"}. Call update_teammate_profile with that expectedVersion and fromProject=true, then call get_teammate_state. Saving a file alone leaves the live profile unchanged. After a conflict reread the live profile before deciding which changes still apply.

| Setting | Where to read or change it |
| --- | --- |
| Name, introduction, personality | Use get_teammate_state and update_teammate_profile with the current expectedVersion. Send only the requested fields. Read the profile back. A running turn keeps its snapshot. |
| Model | The state shows whether the ordered candidates follow the host default or a teammate override. Get available IDs with get_app_default_model. Save your complete selection with update_teammate_profile. A null modelChain restores inheritance. |
| Project rules and skills | AGENTS.md contains the project rules. Personal skills live under .agents/skills/. The hand-off skill is standard. Its “Your own rules” section belongs to this teammate. Preserve the owner's explicit skill switches. |
| Long-term memory | Read .cindy/memory/README.md before editing individual records. Check the index and read back the requested changes. Use find_teammate_capabilities and set_teammate_capability with kind=feature and id=memory to inspect and change the memory switch. |
| What I know about the owner | The teammate profile's ../memories/USER.md (relative to this project) is separate from project memory. In an owner conversation check this category separately when changing roles. |
| Linked projects | Use list_teammate_projects and set_teammate_project. Reread the list after changing an association. |
| Automations | Use the scheduler's list and get tools for this project. Read back the schedule, enabled state and delivery destination. |
| Tools and permissions | Inspect available skills, MCP servers and toolsets with find_teammate_capabilities. Project mode inherits installed capabilities. The host controls account authorization and permission increases. |
| Avatar and voice | The teammate settings page shows the avatar and per-teammate voice preferences. For an emoji set avatar and expectedAvatar from the live state. For an image place avatar.png, avatar.jpg or avatar.webp in this directory, then apply avatarFile with expectedAvatar and expectedVersion alone. Use configure_teammate_voice to inspect per-setting sources and the revision, list voices for a model, and apply a selection or sentencePlayback. Inspect again after saving. |
| Message platforms | Read the local connections returned by get_teammate_state in the owner conversation. Check live connection status separately from the saved record. For iMessage use configure_teammate_imessage_group in the owner conversation with request {action:"inspect",group:"the exact group name"}. Use a unique match. Save the selected request in .cindy/settings/imessage.json with action "apply", the returned group GUID, connectionRef, revision and the requested replyMode ("mention" or "always"). Call the same tool with action "applyFromProject" and the saved revision. The host reads that project file and shows the exact recipient and group if a new grant is needed. Inspect again and verify assignedToSelf and replyMode. If there is no authorized match, report that the host needs a connection for this group. Login, secrets and running connections belong to the host. After moving computers, check authorization on the destination. |

## Change roles and clean selected categories

1. Read the live profile. Save the requested introduction and personality with its version and read it back.
2. For old work memories, identify the matching records by topic in .cindy/memory/. Delete only those records and their index entries. Reread the index and search the original topic. Keep the owner's preferences in ../memories/USER.md unless the request includes them.
3. For personal skills, list_teammate_skills shows the active and disabled items. Inspect each matching item and call remove_teammate_personal_skill with its exact slug. Reread the list. Leave disabled items in place. The hand-off folder is standard and its “Your own rules” section is personal. Keep both during a personal skill cleanup.
4. Use restore_teammate_standard_skills to repair a missing standard. Reread the active skill or its explicitly disabled entry. Report the changed and retained items in each category and their effective scope. An edited project file, an applied host setting, a missing grant and a refused callback are different outcomes.
`;
