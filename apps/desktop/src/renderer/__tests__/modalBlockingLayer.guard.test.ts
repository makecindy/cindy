import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `modal-blocking` 层只能经 confirm({ blocking: true }) 拿到（DESIGN.md §6 层级刻度，2026-11-22 维护者裁决）。
 *
 * 这一层压在所有弹窗、菜单和浮层之上，只给「不处理就无法继续使用应用」的全局提示（如登录过期）。
 * 若普通弹窗或授权请求直接写 `z-modal-blocking` / `Z_INDEX_LAYERS['modal-blocking']`，阻断提示就会
 * 和它们同层、按 DOM 顺序被盖住，又回到登录过期框看不见、点不到的问题。新增合法使用方须先改 §6。
 *
 * 测试价值：静态跨文件契约，放 guard tier；最小失败输入是任一 renderer 源文件出现 `modal-blocking`。
 */

const RENDERER_ROOT = join(__dirname, '..');
const ALLOWED = new Set(['components/ui/confirm-dialog-provider.tsx']);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return ['__tests__', '__mocks__', 'generated'].includes(name) ? [] : sourceFiles(path);
    }
    return /\.(?:tsx?|css)$/.test(name) && !/\.(?:test|spec)\./.test(name) ? [path] : [];
  });
}

describe('modal-blocking 层的使用方', () => {
  it('只有 ConfirmDialogProvider 的 blocking 槽位使用 modal-blocking', () => {
    const users = sourceFiles(RENDERER_ROOT)
      .filter((path) => readFileSync(path, 'utf8').includes('modal-blocking'))
      .map((path) => relative(RENDERER_ROOT, path).split(sep).join('/'));
    expect(users.filter((file) => !ALLOWED.has(file))).toEqual([]);
    // 允许名单不能空转：provider 改名或不再用这一层时，名单要跟着收掉。
    expect(users).toEqual([...ALLOWED]);
  });
});
