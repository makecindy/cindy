// @vitest-environment jsdom

/**
 * expandedStore — 展开态按「显示被忽略的目录」分片持久化。
 *
 * 起因(评审 P2):放行态展开过 node_modules / Library 后切回隐藏态,旧实现按
 * workdir 单一键恢复 → init 会把上百个隐藏的巨大目录当成"已展开"并行 listDir
 * (本地卡顿,SSH 上一条条 RPC)。隐藏态必须只看到「隐藏态里展开过的目录」。
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { loadExpandedSet, saveExpandedSet } from '../expandedStore';

describe('expandedStore 按 showIgnoredDirs 分片', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('放行态写入不污染隐藏态', () => {
    saveExpandedSet('/repo', new Set(['Assets', 'node_modules']), { showIgnoredDirs: true });

    expect([...loadExpandedSet('/repo')]).toEqual([]);
    expect([...loadExpandedSet('/repo', { showIgnoredDirs: true })]).toEqual([
      'Assets',
      'node_modules',
    ]);
  });

  /**
   * 评审 P1：旧实现用 `::reveal` 裸后缀，workdir 以 `::reveal` 结尾时（如
   * `/srv/project::reveal`）它的隐藏键恰好等于 `/srv/project` 的 reveal 键，两个
   * 项目的展开态互相覆盖。新键用不可打印的 NUL 分隔（POSIX 路径不允许含 NUL）。
   */
  it('workdir 以 ::reveal 结尾时不与截断后的 reveal scope 撞键', () => {
    saveExpandedSet('/srv/project::reveal', new Set(['a']));
    saveExpandedSet('/srv/project', new Set(['b']), { showIgnoredDirs: true });

    expect([...loadExpandedSet('/srv/project::reveal')]).toEqual(['a']);
    expect([...loadExpandedSet('/srv/project', { showIgnoredDirs: true })]).toEqual(['b']);
  });

  /**
   * 评审 P1：**不**回退旧版 `::reveal` 键 —— 它同时可能就是**另一个 workdir 的
   * 隐藏键**，回退只是把撞键换了个方向（`/srv/project` 的 reveal 态读到
   * `/srv/project::reveal` 的隐藏态），又会对无关路径发 listDir。旧键无法区分两种
   * 语义，所以一律不读。
   */
  it('不读旧版 ::reveal 键:不把别的 workdir 的隐藏态误当自己的 reveal 态', () => {
    // `/srv/project::reveal` 以自己的**隐藏态**存了展开数据（合法写入）。
    saveExpandedSet('/srv/project::reveal', new Set(['node_modules']));
    // `/srv/project` 的 reveal 态没有自己的数据 → 必须是空的，不能借到上面那份。
    expect([...loadExpandedSet('/srv/project', { showIgnoredDirs: true })]).toEqual([]);
    // 而它自己的隐藏态照旧读到自己的数据。
    expect([...loadExpandedSet('/srv/project::reveal')]).toEqual(['node_modules']);
  });

  it('隐藏态沿用历史键:升级后原有展开态不丢', () => {
    saveExpandedSet('/repo', new Set(['Assets/Scripts']));

    expect([...loadExpandedSet('/repo')]).toEqual(['Assets/Scripts']);
    // 放行态是独立一份,不复用隐藏态的展开面。
    expect([...loadExpandedSet('/repo', { showIgnoredDirs: true })]).toEqual([]);
  });

  it('两态各自清空互不影响', () => {
    saveExpandedSet('/repo', new Set(['Assets']), { showIgnoredDirs: true });
    saveExpandedSet('/repo', new Set(['README.md']));

    saveExpandedSet('/repo', new Set(), { showIgnoredDirs: true });

    expect([...loadExpandedSet('/repo', { showIgnoredDirs: true })]).toEqual([]);
    expect([...loadExpandedSet('/repo')]).toEqual(['README.md']);
  });
});
