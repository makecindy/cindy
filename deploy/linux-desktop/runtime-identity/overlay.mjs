import assert from "node:assert/strict";
const preload = "apps/desktop/src/preload/preload.ts";
const profile =
  "apps/desktop/src/renderer/components/settings/UserProfileCard.tsx";
const sidebar =
  "apps/desktop/src/renderer/components/sidebar/UserInfoSection.tsx";
export const targets = [preload, profile, sidebar];
const hint =
  "(window.electronAPI as typeof window.electronAPI & { cloudIdentityManaged?: boolean }).cloudIdentityManaged === true";
function once(code, before, after) {
  assert.equal(
    code.split(before).length,
    2,
    `Cloud identity integration changed: ${before}`,
  );
  return code.replace(before, after);
}
// Main already enforces assertInstanceAuthMutationAllowed for logout, add,
// switch and dispatch-login-action. This cloud-only overlay makes UI agree.
// The presentation flag is derived from Main's validated instance window arg.
export function transformCloudIdentitySource(code, file) {
  if (!targets.includes(file)) return null;
  assert.ok(
    !code.includes("cloudIdentityManaged"),
    "Cloud identity overlay must not be injected twice",
  );
  if (file === preload)
    return once(
      code,
      "  platform: process.platform,",
      "  platform: process.platform,\n  cloudIdentityManaged: process.platform === 'linux' && process.argv.includes('--cindy-cloud-main-window'),",
    );
  code = `const cloudIdentityManaged = () => ${hint};\n${code}`;
  if (file === profile)
    return once(
      code,
      "      {mode === 'cloud' && (",
      "      {mode === 'cloud' && !cloudIdentityManaged() && (",
    );
  code = once(
    code,
    "        {renderSavedAccountItems()}",
    "        {!cloudIdentityManaged() && renderSavedAccountItems()}",
  );
  code = once(
    code,
    "        {mode === 'cloud' &&\n        accountsReadyForOwner &&",
    "        {mode === 'cloud' && !cloudIdentityManaged() &&\n        accountsReadyForOwner &&",
  );
  return once(
    code,
    "        {mode === 'local' ? (",
    "        {mode === 'local' && !cloudIdentityManaged() ? (",
  );
}
