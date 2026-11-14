/**
 * 跨文件契约:「边做边压」清理必须绑定**发起操作时**的账号。
 *
 * 确认框可能开着很久(用户去回消息、切账号)。若先弹框、确认后才解析归属,删除目标就会
 * 变成「确认那一刻」的账号 —— 删掉的是另一个账号的会话正文备份。这里用源码顺序锁住
 * bootstrap 里的接线:capture(弹框前) → confirm(用户操作) → recheck(删除前) → clear。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const bootstrap = readFileSync(
  new URL('../bootstrap-electron.ts', import.meta.url),
  'utf8',
);

describe('live compact cleanup owner wiring', () => {
  it('captures the owner before the confirm dialog and rechecks it before deleting', () => {
    const start = bootstrap.indexOf("ipcMain.handle('cindy-media:spine-clear'");
    expect(start).toBeGreaterThan(-1);
    const block = bootstrap.slice(start, start + 1200);

    const captured = block.indexOf('captureSpineDir()');
    const confirmed = block.indexOf('confirmFixedDirectoryClear(event');
    const recheck = block.indexOf('ownerScope.isCurrentOwner()');
    const cleared = block.indexOf('clearSpineDir()');

    expect(captured).toBeGreaterThan(-1);
    expect(confirmed).toBeGreaterThan(captured);
    expect(recheck).toBeGreaterThan(confirmed);
    expect(cleared).toBeGreaterThan(recheck);
  });

  it('resolves the shadow directory per active owner instead of a shared path', () => {
    expect(bootstrap).toContain(
      "ownerScopedUserDataPath('pi-agent-home', 'compaction-spine')",
    );
    expect(bootstrap).not.toContain(
      "path.join(app.getPath('userData'), 'pi-agent-home', 'compaction-spine')",
    );
  });
});
