import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// These adapters live in the Electron entrypoint; keep the shared dependency
// wiring covered without booting Electron or touching real credential storage.
const bootstrap = readFileSync(new URL('../bootstrap-electron.ts', import.meta.url), 'utf8');
const register = readFileSync(new URL('../maker-ipc/register.ts', import.meta.url), 'utf8');
const updateService = readFileSync(new URL('../updateService.ts', import.meta.url), 'utf8');
const mainLayout = readFileSync(new URL('../../renderer/components/layout/MainLayout.tsx', import.meta.url), 'utf8');

describe('provider import wiring', () => {
  it('consumes the main pending slot when an import wake-up reaches MainLayout', () => {
    expect(mainLayout).toMatch(/onDeepLinkNavigate\(\(payload\) => \{\s*if \(payload.type !== 'provider-import'\) \{\s*handleDeepLinkPayload\(payload\);\s*return;\s*\}[\s\S]*?takePendingDeepLink\(\)\.then\(\(pending\) => \{\s*if \(pending\) handleDeepLinkPayload\(pending\);/);
  });
  it('passes sanitized JS argv explicitly instead of replaying Electron native startup arguments', () => {
    for (const source of [bootstrap, updateService]) {
      expect(source).toContain('app.relaunch({ args: process.argv.slice(1) });');
      expect(source).not.toMatch(/^\s*app\.relaunch\(\);/m);
    }
  });
  it('drops import credentials before copying argv for a Linux update restart', () => {
    expect(bootstrap).toMatch(/redactConsumedDeepLinkInArgv\(process.argv\);\s*const args = process.argv.slice\(1\);\s*spawn\(exe, args,/);
  });
  it('redacts received argv before dispatch for cold-start and second-instance delivery', () => {
    expect(bootstrap).toMatch(/redactConsumedDeepLinkInArgv\(argv, url\);\s*handleIncomingDeepLink\(url, 'second-instance'\)/);
    expect(bootstrap).toMatch(/redactConsumedDeepLinkInArgv\(process.argv, coldStartUrl\);\s*handleIncomingDeepLink\(coldStartUrl, 'cold-start-argv'\)/);
  });
  it('reuses the settings built-in key bridge and its OpenAI media invalidation', () => {
    expect(bootstrap).toMatch(/registerMakerCoreIpc\(ipcMaker,\s*\{\s*builtinApiKeyDeps,/);
    expect(register).toContain('builtinApiKeyDeps: options.builtinApiKeyDeps');
    expect(bootstrap).toMatch(/onKeyChanged: \(id\) => notifyProviderKeyChanged\(id\)/);
    expect(bootstrap).toMatch(/providerId === 'openai-images'[\s\S]*?notifyOpenAiMediaCredentialChanged\(\)/);
  });
});
