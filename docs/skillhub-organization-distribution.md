# Organization Skill distribution

The enterprise Console manages visibility and automatic installation audiences for organization-owned native skills.
The desktop reads `GET /api/skills-hub/auto-install` from the existing `cindySkillHubApiBaseUrl` after login or identity changes.
The additive response is `{ skills: [{ name, version, catalogScope: "team" }], nextCursor }`; each page contains at most 100 skills.
Department IDs are never submitted by the desktop. The server selects candidates using authenticated membership and both audiences.

Organization candidates take precedence over same-slug product defaults. Existing installers, digest verification, local registry,
conflict protection, ignore preferences and cancellation cleanup remain in use. Policy changes do not uninstall existing files.
A transient error or old server returning 404 does not clear stored preferences or prevent product defaults from being processed.
Users can sign out and back in (or restart Cindy) to pick up changed policies; no live policy polling is introduced.
Older desktop versions retain manual installation but do not consume the new automatic distribution endpoint.

Deploy the server and its migration first, then release the desktop consumer. New endpoint failures are isolated from manual installation.
