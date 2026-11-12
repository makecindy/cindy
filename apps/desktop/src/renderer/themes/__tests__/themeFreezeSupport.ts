/**
 * DS-2b 快照守卫共用文案与读盘。测试专用，不进入产品代码。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function readJsonFixture<T>(metaUrl: string, relativeFromCaller: string): T {
  return JSON.parse(readFileSync(fileURLToPath(new URL(relativeFromCaller, metaUrl)), 'utf8')) as T;
}

export function themeFreezeMismatch(what: string, fixturePath: string): string {
  return [
    `${what} 与 DS-2b 冻结快照不一致。`,
    '红灯不是禁令。有意改值的合法路径 = 同一 PR 更新本快照 + 按治理合同 §6 交证据 + 设计师批准。',
    `更新方式：把实时提取结果写回 ${fixturePath}（同一 PR 更新快照，不要加豁免）。`,
    '保护值（CINDY 皮肤族 DESIGN.md §15、U2 二级信息色、annotation-accent）另有比「改快照 + 设计师批准」更严的门槛，不能只更新本文件。',
    '禁止为绿灯加豁免或绕加载路径。',
  ].join('\n');
}
