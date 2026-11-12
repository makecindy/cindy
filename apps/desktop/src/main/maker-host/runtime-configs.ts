import { createAgentRuntimeConfigs } from './runtimeConfigsCore.js';
/**
 * Desktop AgentRuntimeConfig 实现。
 * endpoint、行为开关与宿主资源路径由 desktop host 在这里统一注入,
 * maker-core 只消费抽象配置,不依赖 Electron 或部署环境。
 *
 * The configs live in runtimeConfigsCore.ts, shared with the Node Host; this module
 * binds the Electron reads and keeps the exports Desktop callers already use.
 */

import type { AgentRuntimeConfig } from '@cindy/maker-core';
import { app } from 'electron';
import path from 'node:path';
import { getCachedBinaryStatus } from '../agent-binaries/index.js';

export { claudeUpstreamEndpoint } from './runtimeConfigsCore.js';

// Candidate directories for the bundled ripgrep (body of the former bundledRipgrepDir).
function desktopRipgrepCandidates(key: string): string[] {
  return app.isPackaged
    ? [path.join(process.resourcesPath, 'tools', 'ripgrep')]
    : [
        // 非打包环境(dev / 测试)首选 app 目录;测试环境的 electron mock 可能
        // 不提供 getAppPath,此时跳过该候选,用 cwd 相对候选兜底。
        ...(typeof app.getAppPath === 'function'
          ? [path.join(app.getAppPath(), '..', '..', 'apps', 'ripgrep-bin', key)]
          : []),
        path.join(process.cwd(), 'apps', 'ripgrep-bin', key),
        path.join(process.cwd(), '..', 'ripgrep-bin', key),
      ];
}

export const desktopRuntimeConfigs = createAgentRuntimeConfigs({
  userDataPath: () => app.getPath('userData'),
  ripgrepCandidates: desktopRipgrepCandidates,
  codexBinaryPath: () => getCachedBinaryStatus('codex').binaryPath,
});

/** Bundled ripgrep executable; throws when missing (see runtimeConfigsCore.ts). */
export function getRipgrepBinaryPath(): string {
  return desktopRuntimeConfigs.getRipgrepBinaryPath();
}

/** Startup fail-fast probe for the bundled ripgrep (issue #1956). */
export function ensureBundledRipgrepReady(): void {
  desktopRuntimeConfigs.ensureBundledRipgrepReady();
}

/** Claude runtime config; `endpointFn` is read on every spawn (see runtimeConfigsCore.ts). */
export function buildDesktopClaudeRuntimeConfig(endpointFn: () => string): AgentRuntimeConfig {
  return desktopRuntimeConfigs.buildClaudeRuntimeConfig(endpointFn);
}

/** Codex runtime config, built once at module load as before. */
export const desktopCodexRuntimeConfig: AgentRuntimeConfig = desktopRuntimeConfigs.buildCodexRuntimeConfig();
