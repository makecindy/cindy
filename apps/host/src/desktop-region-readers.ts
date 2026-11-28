/**
 * Desktop and package modules the Host loads that read the build region, and how each behaves on the
 * Host. The region is fixed per release (scripts/build.mjs --region bakes it into shared/brandRegion.ts;
 * from source loaders/raw-hook.mjs follows CINDY_HOST_REGION), so a reader here follows the Host's
 * edition, not the account's realm.
 *
 * Read by the guard in apps/desktop/src/main/maker-host/__tests__/hostDesktopSourceContracts.guard.test.ts
 * (pnpm test:guard). It collects, in the Host's static import graph, every file that imports
 * CURRENT_CINDY_REGION or CURRENT_APP_ID from shared/brandRegion or reads VITE_CINDY_AUTH_REGION /
 * CINDY_AUTH_REGION directly, and fails until each reader is listed here, and each entry still reads.
 * A desktop module that starts reading the region, or comes into the graph (release table 甲 20, the
 * desktop inventory's files outside it today), is judged here before it ships on the Host.
 * It also collects the Host's own region fallbacks, a ternary that maps a realm to cn or global
 * (`x === 'cn' ? 'cn' : 'global'`): unlike `account.realm ?? resolveHostRegion()` it falls to a fixed
 * region, not the release's, so each one says why it cannot be reached and is rechecked when its code moves.
 *
 * Key: `<file>#<what it reads>`, or `<file>#<enclosing function>:realm-fallback`; one sorted entry per line.
 */
export const DESKTOP_REGION_READERS: Readonly<Record<string, { host: string }>> = {
  'apps/desktop/src/main/maker-host/active-catalog.ts#CURRENT_CINDY_REGION': { host: 'Before /models first succeeds, cn hides the unverified XD image, embedding and non-Seedance video models (provider-access-policy.ts); every catalog reader follows, including the engines\' model lists (3c)' },
  'apps/desktop/src/main/maker-host/codexLocalSessionsCore.ts#CURRENT_CINDY_REGION': { host: 'cn also looks for old Codex threads in the legacy xdt-maker codex-home when resuming; the fallback codex-home is unreachable (codex-thread-storage.ts binds assertCurrent)' },
  'apps/desktop/src/main/maker-ipc/piUsageReceiptsCore.ts#CURRENT_CINDY_REGION': { host: 'The Pi receipt pricing context (TurnPricingContext.region) of the turn usage records (release table row 13, 3d): the Host\'s edition, as the desktop\'s' },
  'apps/desktop/src/main/maker-ipc/sessionClaudeTurnUsageCore.ts#CURRENT_CINDY_REGION': { host: 'The Claude turn pricing context (TurnPricingContext.region) of the turn usage records (release table row 13, 3d): the Host\'s edition, as the desktop\'s' },
  'apps/desktop/src/main/maker-ipc/sessionPiTurnUsageCore.ts#CURRENT_CINDY_REGION': { host: 'The Pi turn pricing context (TurnPricingContext.region) of the turn usage records (release table row 13, 3d): the Host\'s edition, as the desktop\'s' },
  'apps/desktop/src/main/usage/modelPricingCore.ts#CURRENT_CINDY_REGION': { host: 'The pricing cache scope (3a): region=<edition> next to the Model Access base URL and the account, so a release shares the scope the desktop of its region writes; no user-visible difference' },
  'apps/desktop/src/shared/brandRegion.ts#env': { host: 'The definition: import.meta.env?.VITE_CINDY_AUTH_REGION, baked from --region in a release (scripts/build.mjs) and CINDY_HOST_REGION from source (loaders/raw-hook.mjs)' },
  'apps/desktop/src/shared/regionalMoney.ts#CURRENT_CINDY_REGION': { host: 'Module-level DEFAULT_USAGE_CURRENCY: the currency of zero amounts for tasks and runs without a cost (localDb/mapper.ts), CNY for cn' },
  'apps/desktop/src/shared/voiceInputData.ts#CURRENT_CINDY_REGION': { host: 'Voice input default language without a saved choice, zh-CN for cn (profile-settings.mjs, the web client\'s boot values)' },
  'apps/host/src/main.ts#disableShareAvailability:realm-fallback': { host: 'account.realm === \'cn\' ? \'cn\' : \'global\' picks the Device Link endpoint; a missing realm would fall to global, not the release region. Unreachable with the current startup order: it is the share availability policy\'s callback (created with the owner runtime, handed to the agent graph and Device Link), and it calls the server with the session token, which exists only once sign-in set the realm' },
  'apps/host/src/main.ts#hostAgentNetPorts:realm-fallback': { host: 'Selects the Agent-Net service and Device Link directory by the signed-in realm. The global fallback for a missing realm is unreachable because startDeviceLink calls this only after authentication sets the realm.' },
  'apps/host/src/main.ts#readDeviceLinkDeviceIds:realm-fallback': { host: 'The shared device-directory reader serves Agent-Net and SSH access only after authentication sets the account realm; its global fallback is unreachable during the signed-in Device Link startup.' },
  'apps/host/src/main.ts#startDeviceLink:realm-fallback': { host: 'account.realm === \'cn\' ? \'cn\' : \'global\' picks the Device Link relay; a missing realm would fall to global, not the release region. Unreachable with the current startup order: the startup task calls it after sign-in set the realm (main.ts ensureRuntime, then startDeviceLink)' },
};
