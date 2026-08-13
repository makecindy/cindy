import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * cindy-brain/index.ts owns Electron process singletons and cannot be imported
 * in the Node test environment, so keep the session-message permission boundary
 * covered with the established main-process source-contract pattern.
 */
describe('Ghost current-session message permission boundary', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/main/cindy-brain/index.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('requires the new session-message add-on before exposing the current session', () => {
    const start = source.indexOf("if (request.kind === 'get-current-session') {");
    const end = source.indexOf("if (request.kind === 'send-message') {", start);
    const body = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("ghost.manifest.slots.includes('session-context')");
    expect(body).toContain("ghost.manifest.slots.includes('agent')");
    expect(body).toContain('ghost.manifest.agent?.sessionMessage !== true');
    expect(body).toContain("throwIpcError('PERMISSION_DENIED', '插件未声明当前任务消息能力')");
  });

  it('rejects current-session reads when the plugin is disabled for the focused workdir', () => {
    const start = source.indexOf("if (request.kind === 'get-current-session') {");
    const end = source.indexOf("if (request.kind === 'send-message') {", start);
    const body = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain(
      'isGhostDisabledForWorkdir(id, fsSnapshot?.workingDir ?? row?.workingDir)',
    );
    expect(body).toContain("message: '插件已在当前任务的工作目录中停用'");
    expect(
      body.indexOf('isGhostDisabledForWorkdir(id, fsSnapshot?.workingDir ?? row?.workingDir)'),
    ).toBeLessThan(body.indexOf('buildGhostCurrentSessionSnapshot('));
  });

  it('rejects sends when the plugin is disabled for the focused task workdir', () => {
    const start = source.indexOf("if (request.kind === 'send-message') {");
    const end = source.indexOf("throwIpcError('INVALID_PARAMS', '未知的 session 请求类型')", start);
    const body = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain('const focusedSession = await getSessionFsSnapshot(request.sessionId);');
    expect(body).toContain('isGhostDisabledForWorkdir(id, focusedSession.workingDir)');
    expect(body).toContain("message: '插件已在当前任务的工作目录中停用'");
    expect(body.indexOf('isGhostDisabledForWorkdir(id, focusedSession.workingDir)')).toBeLessThan(
      body.indexOf('ghostSessionMessageLastSentAt.set(id, now)'),
    );
  });
});
