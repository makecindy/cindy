import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopRoot = resolve(__dirname, '../..');
const read = (relative: string): string =>
  readFileSync(resolve(desktopRoot, relative), 'utf8').replace(/\r\n?/g, '\n');

describe('writable directory grant wiring', () => {
  it('issues picker evidence in Main and binds active task additions to the IPC sender', () => {
    const bootstrap = read('main/bootstrap-electron.ts');
    const register = read('main/maker-ipc/register.ts');
    const dialogStart = bootstrap.indexOf("'dialog:show-open-directory'");
    const dialogEnd = bootstrap.indexOf("'dialog:show-open-file'", dialogStart);
    const dialog = bootstrap.slice(dialogStart, dialogEnd);
    expect(dialog).toContain('assertTrustedAppRendererEvent(event)');
    expect(dialog).toContain('issueWritableDirectoryPickerGrant({');
    expect(dialog).toContain('senderId: event.sender.id');
    expect(register).toContain('consumeWritableDirectoryPickerGrants({');
    expect(register).toContain('scopeId: sessionId');
    expect(register).toContain('senderId: options.senderId');
  });

  it('uses the reserved local draft task id for picker scope and persisted session creation', () => {
    const draft = read('renderer/features/cc-agent/NewMakerDraftRoute.tsx');
    expect(draft).toContain('const localDraftSessionIdRef = useRef(makeDraftSessionId())');
    expect(draft).toContain('writableGrantScope={localDraftSessionIdRef.current}');
    expect(draft).toContain('const sessionId = localDraftSessionIdRef.current');
    expect(draft).toContain('goalSessionId = localDraftSessionIdRef.current');
  });

  it('blocks raw local DB updates and consumes picker evidence before local create', () => {
    const sessions = read('main/localDb/ipc/sessions.ts');
    const createStart = sessions.indexOf("ipcMain.handle('local-db:sessions:create'");
    const updateStart = sessions.indexOf("ipcMain.handle('local-db:sessions:update'");
    const create = sessions.slice(createStart, updateStart);
    expect(create).toContain('consumeWritableDirectoryPickerGrants({');
    expect(create.indexOf('consumeWritableDirectoryPickerGrants({')).toBeLessThan(
      create.indexOf('db.insert(sessions)'),
    );
    // update handler 只做 adapter,业务体在 updateSessionInDb(MCP 会话操作工具共用同一路径)。
    const update = sessions.slice(updateStart, sessions.indexOf("'local-db:sessions:patch-meta'"));
    expect(update).toContain('return updateSessionInDb(sid, p, opts)');
    const updateBody = sessions.slice(
      sessions.indexOf('export async function updateSessionInDb('),
      sessions.indexOf('export async function patchSessionMetaInDb('),
    );
    expect(updateBody).toContain('p.extraDirs !== undefined || p.writableDirs !== undefined');
  });
});
