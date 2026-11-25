import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const settingsPrompt = fs.readFileSync(new URL('./settings.md', import.meta.url), 'utf8').trimEnd();
export const promptSha256 = createHash('sha256').update(settingsPrompt).digest('hex');
const virtualId = 'virtual:cindy-cloud-settings-guidance';
const resolvedId = '\0' + virtualId;

// The guidance rides on the getter every engine's cloud prompt already uses.
const promptFile = 'apps/desktop/src/main/plugin-oauth/prompt.ts';
const getterAnchor = 'get: () => appendCloudPluginOauthPrompt(base, getInstanceConfig() !== null),';
// Checked, not rewritten: each engine still has a host prompt and still goes
// through that getter, so dropping one engine fails the cloud build.
const wiring = {
  'apps/desktop/src/main/maker-host/runtimeConfigsCore.ts': [
    'systemPrompt: composeHostPrompt(claudeSystemPrompt),',
    'systemPrompt: composeHostPrompt(codexSystemPrompt),',
    'systemPrompt: composePiSystemPrompt(`${hostSystemPrompt.trim()}\\n\\n${businessOwnershipPrompt.trim()}`, piSystemPrompt),',
  ],
  'apps/desktop/src/main/maker-host/runtime-configs.ts': [
    'withCloudPluginOauthPrompt(desktopRuntimeConfigs.buildClaudeRuntimeConfig(',
    'withCloudPluginOauthPrompt(desktopRuntimeConfigs.buildCodexRuntimeConfig(',
  ],
  'apps/desktop/src/main/maker-host/pi-host.ts': [
    'withCloudPluginOauthPrompt(buildPiRuntimeConfig(',
  ],
};
export const targets = [promptFile, ...Object.keys(wiring)];

export function appendCloudSettingsPrompt(existing, cloudInstance) {
  return cloudInstance ? `${existing}\n\n${settingsPrompt}` : existing;
}

const once = (code, anchor, relativePath) =>
  assert.equal(code.split(anchor).length, 2, `Cloud prompt integration changed: ${relativePath}`);

// Returns the transformed text; it never writes the client checkout.
export function transformCloudSource(code, relativePath) {
  if (relativePath === promptFile) {
    assert.ok(!code.includes(virtualId), 'Cloud guidance must not be injected twice');
    once(code, getterAnchor, relativePath);
    const getter = getterAnchor.slice('get: () => '.length, -1);
    code = code.replace(getterAnchor, `get: () => appendCloudSettingsPrompt(${getter}, getInstanceConfig() !== null),`);
    return `import { appendCloudSettingsPrompt } from '${virtualId}';\n${code}`;
  }
  const anchors = wiring[relativePath];
  if (!anchors) return null;
  for (const anchor of anchors) once(code, anchor, relativePath);
  return code;
}

export function cloudSettingsGuidancePlugin({ sourceRoot, onTransform = () => {} }) {
  assert.ok(path.isAbsolute(sourceRoot), 'Explicit absolute client source root required');
  const seen = new Set();
  return {
    name: 'cindy-cloud-settings-guidance',
    enforce: 'pre',
    resolveId(id) { return id === virtualId ? resolvedId : null; },
    load(id) {
      if (id !== resolvedId) return null;
      return `const settingsPrompt = ${JSON.stringify(settingsPrompt)};\nexport ${appendCloudSettingsPrompt.toString()}`;
    },
    transform(code, id) {
      const relativePath = path.relative(sourceRoot, id.split('?')[0]).split(path.sep).join('/');
      const transformed = transformCloudSource(code, relativePath);
      if (transformed === null) return null;
      seen.add(relativePath);
      onTransform({ relativePath, promptSha256 });
      return { code: transformed, map: null };
    },
    buildEnd(error) {
      if (error) return;
      // Install on the main entry only: a missing engine is a failed cloud build.
      assert.deepEqual([...seen].sort(), [...targets].sort(), 'Cloud guidance did not reach all three engines');
    },
  };
}
