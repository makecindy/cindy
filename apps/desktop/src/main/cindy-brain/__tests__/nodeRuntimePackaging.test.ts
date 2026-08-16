/** nodeRuntimePackaging.test — 正式包保留安全 Fuses，同时带上 utilityProcess 入口。 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const desktopRoot = path.resolve(process.cwd());

describe('Node runtime packaging contract', () => {
  it('使用独立 utilityProcess bundle，且不重新打开 RunAsNode / Node 参数开关', () => {
    const forge = fs.readFileSync(path.join(desktopRoot, 'forge.config.ts'), 'utf8');
    expect(forge).toContain("entry: 'src/main/cindy-brain/nodeRuntimeWorkerProcess.ts'");
    expect(forge).toContain("entry: 'src/main/cindy-brain/forgeScaffoldWorkerProcess.ts'");
    expect(forge).toContain("entry: 'src/main/cindy-brain/ghostSnapshotWorkerProcess.ts'");
    expect(forge).toContain("target: 'preload'");
    expect(forge).toContain('[FuseV1Options.RunAsNode]: false');
    expect(forge).toContain('[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false');
    expect(forge).toContain('[FuseV1Options.EnableNodeCliInspectArguments]: false');
    expect(forge).toContain('[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true');
    expect(forge).toContain('[FuseV1Options.OnlyLoadAppFromAsar]: true');
  });

  it('scaffold worker is parentPort-only and does not reopen RunAsNode', () => {
    const worker = fs.readFileSync(
      path.join(desktopRoot, 'src/main/cindy-brain/forgeScaffoldWorkerProcess.ts'),
      'utf8',
    );
    expect(worker).toContain('parentPort');
    expect(worker).toContain('verifyParent');
    expect(worker).toContain('sameForgeScaffoldParentIdentity');
    expect(worker).toContain('fs.promises.mkdir(request.targetName)');
    expect(worker).not.toContain('ELECTRON_RUN_AS_NODE');
    const capability = fs.readFileSync(
      path.join(desktopRoot, 'src/main/cindy-brain/forgeScaffoldCapability.ts'),
      'utf8',
    );
    expect(capability).toContain('child.kill()');
  });

  it('工作入口通过 parentPort 接收虚拟 stdin，不启动外部 node 命令', () => {
    const worker = fs.readFileSync(
      path.join(desktopRoot, 'src/main/cindy-brain/nodeRuntimeWorkerProcess.ts'),
      'utf8',
    );
    const broker = fs.readFileSync(
      path.join(desktopRoot, 'src/main/cindy-brain/nodeRuntimeBroker.ts'),
      'utf8',
    );
    expect(worker).toContain("data.type === 'stdin'");
    expect(worker).toContain('requireFromWorker(entryPath)');
    expect(broker).toContain('utilityProcess.fork');
    expect(broker).not.toContain("ELECTRON_RUN_AS_NODE: '1'");
  });

  it('代启子进程(childSpawn)仍走同一 utilityProcess 通道,worker 侧只暴露窄接口', () => {
    const worker = fs.readFileSync(
      path.join(desktopRoot, 'src/main/cindy-brain/nodeRuntimeWorkerProcess.ts'),
      'utf8',
    );
    const broker = fs.readFileSync(
      path.join(desktopRoot, 'src/main/cindy-brain/nodeRuntimeBroker.ts'),
      'utf8',
    );
    // 窄接口冻结挂载,原样模式伪装 argv,不引 child_process 自己生进程。
    expect(worker).toContain('__CINDY_NODE__');
    expect(worker).toContain('Object.freeze({ spawnEntry })');
    expect(worker).toContain('GHOST_NODE_CHILD_MODE_FLAG');
    expect(worker).not.toContain("require('node:child_process')");
    expect(worker).not.toContain("from 'node:child_process'");
    // broker 守门:形状校验 + 申报清单 + 数量顶 + 级联收尾。
    expect(broker).toContain('parseGhostNodeChildToHostMessage');
    expect(broker).toContain('GHOST_NODE_MAX_CHILDREN_PER_GHOST');
    expect(broker).toContain('GHOST_NODE_CHILD_MODE_FLAG');
  });
});
