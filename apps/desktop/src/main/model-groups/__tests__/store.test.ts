/**
 * 测试价值
 * - 生产入口与可观察结果：writeModelGroupsConfig / readModelGroupsConfig——模式详情里的开关存下后，主进程读回的配置。
 * - 规则依据：docs/product-rules/model-groups.md §4.5 每个模式的「出问题时自动换来源」默认开，只存关掉的状态。
 * - 现有覆盖缺口：配置文件的写入没有测试。
 * - 最小失败输入：关掉开关后读回仍是开着；或关掉再打开后仍存着 false。
 * - tier：unit，真实文件读写，不启动 Electron。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const paths = vi.hoisted(() => ({ file: '' }));

vi.mock('../../maker-host/logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('../../ownerContext.js', () => ({ ownerScopedPath: () => paths.file }));

import { modelGroupAutoSwitchOn, type ModelGroupRoute, type ModelGroupsConfig } from '../../../shared/modelGroups.js';
import { readModelGroupsConfig, writeModelGroupsConfig } from '../store.js';

const ROUTE = { id: 'r1', name: 'R', strategy: 'order' as const, candidates: [{ agentKind: 'codex' as const, providerId: 'a', model: 'gpt' }] };

afterEach(() => {
  if (paths.file) fs.rmSync(path.dirname(paths.file), { recursive: true, force: true });
});

describe('model groups store', () => {
  it('keeps one mode\'s auto switch off once the user turns it off, and clears it when turned back on', () => {
    paths.file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mg-store-')), 'model-groups.json');
    const save = (change: (latest: ModelGroupsConfig) => ModelGroupsConfig) => writeModelGroupsConfig(change(readModelGroupsConfig()));
    const editRoute = (patch: (r: ModelGroupRoute) => ModelGroupRoute) => save((latest) => ({ ...latest, routes: latest.routes.map(patch) }));
    save(() => ({ routes: [ROUTE, { ...ROUTE, id: 'r2' }] }));
    expect(readModelGroupsConfig().routes.map(modelGroupAutoSwitchOn)).toEqual([true, true]);
    // The mode page turns it off the way ModelGroupsSection does, for r1 only.
    editRoute((r) => (r.id === 'r1' ? { ...r, autoSwitch: false } : r));
    expect(readModelGroupsConfig().routes.map(modelGroupAutoSwitchOn)).toEqual([false, true]);
    // Editing the mode keeps the user's choice.
    editRoute((r) => (r.id === 'r1' ? { ...r, name: 'R2' } : r));
    expect(readModelGroupsConfig().routes[0]).toMatchObject({ name: 'R2', autoSwitch: false });
    // Turned back on: nothing is stored for it.
    editRoute(({ autoSwitch: _was, ...rest }) => rest);
    expect(readModelGroupsConfig().routes.map(modelGroupAutoSwitchOn)).toEqual([true, true]);
    expect(JSON.stringify(JSON.parse(fs.readFileSync(paths.file, 'utf8')))).not.toContain('autoSwitch');
  });
});
