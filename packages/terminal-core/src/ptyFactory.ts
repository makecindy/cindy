/**
 * node-pty 模块加载器（DI 友好）。
 *
 * 为什么不直接 `import { spawn } from 'node-pty'`：
 *   - vite.main.config.ts 把 `node-pty` 标 external，本文件被打包后 `import` 仍然
 *     由 Node 在运行时 require —— 但 vite 静态分析阶段如果发现裸 import，可能会
 *     在 dev / prod 走出不一致路径。用 `createRequire(import.meta.url)` 跟
 *     betterSqliteFactory.ts 同款，把"加载哪个 node-pty"显式绑到本 bundle 文件
 *     位置（packaged 下走 app.asar.unpacked/node_modules/node-pty/...）。
 *   - DI：把"spawn 一个 PTY"抽象成 `PtySpawnFn` 类型，PtyManager 接收它做依赖
 *     注入。生产代码用 `defaultPtySpawn`，单测可以注入 fake spawn 不碰真 PTY。
 */

import { createRequire } from 'node:module';

import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from 'node-pty';

// 绑定到本 bundle 文件位置，确保 dev / packaged 都解析到同一份 node-pty。
const requireFromHere = createRequire(import.meta.url);

let cached: typeof import('node-pty') | null = null;

function loadNodePty(): typeof import('node-pty') {
  if (cached) return cached;
  cached = requireFromHere('node-pty') as typeof import('node-pty');
  return cached;
}

/** PtyManager 依赖注入入参：(command, args, options) → IPty。 */
export type PtySpawnFn = (
  command: string,
  args: string[],
  options: IPtyForkOptions | IWindowsPtyForkOptions,
) => IPty;

/** 真正调用 node-pty 的默认实现。生产代码用这个，单测注入 fake。 */
export const defaultPtySpawn: PtySpawnFn = (command, args, options) => {
  return loadNodePty().spawn(command, args, options);
};
