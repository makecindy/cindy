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

  it('读取回退旧版 ::reveal 键,升级不丢展开态', () => {
    localStorage.setItem(
      'cc-agent.workdirBrowse.expandedFolders.v1',
      JSON.stringify({ '/repo::reveal': ['node_modules'] }),
    );
    expect([...loadExpandedSet('/repo', { showIgnoredDirs: true })]).toEqual(['node_modules']);
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
