/** Apply preferences to an existing execution session before persisting them. */
export async function applyLiveSessionSettings(live, patch, stored) {
  if (!live) return;
  if (typeof patch.permissionMode === 'string') await live.setPermissionMode(patch.permissionMode);
  if (typeof patch.model === 'string' || Object.hasOwn(patch, 'providerId')) {
    await live.setModel(patch.model ?? stored.model, {
      ...(Object.hasOwn(patch, 'providerId') ? { providerId: patch.providerId } : {}),
      ...(typeof patch.effort === 'string' ? { effort: patch.effort } : {}),
    });
  } else if (typeof patch.effort === 'string') {
    await live.setEffort(patch.effort);
  }
  if (typeof patch.fastMode === 'boolean' || patch.fastMode === 'ultrafast') {
    await live.setFastMode(patch.fastMode);
  }
  if (typeof patch.planModeEnabled === 'boolean') await live.setPlanMode(patch.planModeEnabled);
}
