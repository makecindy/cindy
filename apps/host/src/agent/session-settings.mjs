const appliedSettings = new WeakMap();

/** Initial facts come from the same options that constructed the live Session. */
export function rememberLiveSessionSettings(live, options) {
  appliedSettings.set(live, { ...options, providerId: options.providerId ?? null,
    planModeEnabled: options.planMode });
}

/** Reused sessions must apply current task settings, not keep the first
 * turn's model. Skip unchanged options so unsupported live switches are not
 * invoked for an ordinary continuation. Direct settings edits update this same
 * snapshot below. Plan is per-message intent at dispatch, not an instruction
 * to overwrite the runtime's armed state; only direct picker edits do that. */
export async function applyQueuedSessionSettings(live, options, stored) {
  const previous = appliedSettings.get(live) ?? stored;
  const desired = { ...options, providerId: options.providerId ?? null };
  const current = { ...previous,
    ...(typeof live.model === 'string' ? { model: live.model } : {}),
    ...(live.stablePermissionModeState?.mode ? { permissionMode: live.stablePermissionModeState.mode } : {}),
  };
  const patch = {};
  for (const key of ['model', 'providerId', 'permissionMode', 'effort', 'fastMode']) {
    if (desired[key] !== undefined && desired[key] !== current[key]) patch[key] = desired[key];
  }
  await applyLiveSessionSettings(live, patch, stored);
}

/** Apply preferences to an existing execution session before persisting them. */
export async function applyLiveSessionSettings(live, patch, stored) {
  if (!live) return;
  const remember = fields => appliedSettings.set(live, { ...(appliedSettings.get(live) ?? stored), ...fields });
  if (typeof patch.permissionMode === 'string') {
    await live.setPermissionMode(patch.permissionMode);
    remember({ permissionMode: patch.permissionMode });
  }
  if (typeof patch.model === 'string' || Object.hasOwn(patch, 'providerId')) {
    await live.setModel(patch.model ?? stored.model, {
      ...(Object.hasOwn(patch, 'providerId') ? { providerId: patch.providerId } : {}),
      ...(typeof patch.effort === 'string' ? { effort: patch.effort } : {}),
    });
    remember({ model: patch.model ?? stored.model,
      ...(Object.hasOwn(patch, 'providerId') ? { providerId: patch.providerId } : {}),
      ...(typeof patch.effort === 'string' ? { effort: patch.effort } : {}) });
  } else if (typeof patch.effort === 'string') {
    await live.setEffort(patch.effort);
    remember({ effort: patch.effort });
  }
  if (typeof patch.fastMode === 'boolean' || patch.fastMode === 'ultrafast') {
    await live.setFastMode(patch.fastMode);
    remember({ fastMode: patch.fastMode });
  }
  if (typeof patch.planModeEnabled === 'boolean') {
    await live.setPlanMode(patch.planModeEnabled);
    remember({ planModeEnabled: patch.planModeEnabled });
  }
}
