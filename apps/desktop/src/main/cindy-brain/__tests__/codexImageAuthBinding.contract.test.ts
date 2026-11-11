// Guard tier: engineering-conventions section 3.2. Existing cross-file
// credential, permission, protocol, race, and design contracts are isolated
// from runtime unit tests. No new input or assertion is introduced here.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe("codexImageAuthBinding", () => {


  it('bootstrap statically injects auth before Ghost IPC registration', () => {
    const bootstrap = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/bootstrap-electron.ts'),
      'utf-8',
    );
    const brain = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
      'utf-8',
    );

    expect(bootstrap).toContain("from './maker-host/anthropic-responses-bridge-host.js';");
    expect(bootstrap).toContain('getChatgptBridgeAuth,');
    expect(bootstrap).toContain('invalidateChatgptBridgeAuth,');
    expect(bootstrap.indexOf('setCodexImageAuthBinding({')).toBeGreaterThan(-1);
    expect(bootstrap.indexOf('setCodexImageAuthBinding({')).toBeLessThan(
      bootstrap.indexOf('registerGhostIpc();'),
    );
    expect(brain).not.toMatch(
      /import\(\s*['"]\.\.\/maker-host\/anthropic-responses-bridge-host\.js['"]\s*\)/,
    );
  });
});
