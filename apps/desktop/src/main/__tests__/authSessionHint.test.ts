import { describe, expect, it } from 'vitest';
import path from 'node:path';

import { hasPersistedSessionHint } from '../authSessionHint';

/** 全部走注入的 fake fs,不落盘(规则 23:测试不得触碰真实 userData / 仓库路径)。 */
function makeDeps(files: Record<string, string | true>) {
  const userDataPath = path.join('/fake-user-data');
  const abs = (rel: string) => path.join(userDataPath, rel);
  const table = new Map(Object.entries(files).map(([rel, content]) => [abs(rel), content]));
  return {
    userDataPath,
    existsSync: (p: string) => table.has(p),
    readFileSync: (p: string) => {
      const content = table.get(p);
      if (content === undefined || content === true) throw new Error('ENOENT');
      return content;
    },
  };
}

describe('hasPersistedSessionHint', () => {
  it('真首启(无 token 文件、无 app-session.json)→ false', () => {
    expect(hasPersistedSessionHint(makeDeps({}))).toBe(false);
  });

  it('存在持久化 refresh token → true(cloud 会话冷启动可恢复,非首启)', () => {
    expect(
      hasPersistedSessionHint(
        makeDeps({ 'safe-storage/cindy_auth_refresh_token.enc': true }),
      ),
    ).toBe(true);
  });

  it('legacy token 文件同样算存量会话', () => {
    expect(
      hasPersistedSessionHint(makeDeps({ 'safe-storage/refresh_token.enc': true })),
    ).toBe(true);
    expect(
      hasPersistedSessionHint(
        makeDeps({ 'safe-storage/cindy_auth_account_refresh_token.enc': true }),
      ),
    ).toBe(true);
  });

  it('app-session.json activeMode=local → true(本地模式直进应用)', () => {
    expect(
      hasPersistedSessionHint(makeDeps({ 'app-session.json': '{"activeMode":"local"}' })),
    ).toBe(true);
  });

  it('app-session.json 为 signed-out / 损坏 → false(不阻止首启判定)', () => {
    expect(
      hasPersistedSessionHint(makeDeps({ 'app-session.json': '{"activeMode":"signed-out"}' })),
    ).toBe(false);
    expect(hasPersistedSessionHint(makeDeps({ 'app-session.json': 'not-json' }))).toBe(false);
  });

  it('探测函数抛异常时兜底为 false(退化为改动前行为)', () => {
    expect(
      hasPersistedSessionHint({
        userDataPath: '/fake-user-data',
        existsSync: () => {
          throw new Error('EACCES');
        },
        readFileSync: () => {
          throw new Error('EACCES');
        },
      }),
    ).toBe(false);
  });
});
