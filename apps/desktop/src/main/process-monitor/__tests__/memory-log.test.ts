/**
 * memory-usage 采样行的上报契约。`memory-usage` 被精确放行进日志上报白名单
 * (log-upload-and-redaction §1.2),前提是行内只有进程类型与数字:getAppMetrics 的
 * `name` / `serviceName` 可能带 webContents 标题或插件服务名,一旦被格式化进来就会
 * 随上报离开本机。单独成文件:sampler.test.ts 测的是资源用量面板的合并逻辑,与这里不同模块。
 */
import { describe, expect, it } from 'vitest';

import { formatMemorySample } from '../memory-log.js';

const MB = 1024 * 1024;

describe('formatMemorySample', () => {
  it('groups processes by type largest first and never includes names', () => {
    // getAppMetrics 的真实形状带 name / serviceName。
    const metrics = [
      { type: 'Browser', memory: { workingSetSize: 1720 * 1024 } },
      { type: 'Tab', memory: { workingSetSize: 180 * 1024 }, name: 'Secret task title' },
      { type: 'Tab', memory: { workingSetSize: 1366 * 1024 } },
      { type: 'Utility', memory: { workingSetSize: 49 * 1024 }, serviceName: 'plugin-private-id' },
    ];
    const line = formatMemorySample(
      { rss: 1720 * MB, heapUsed: 640 * MB, heapTotal: 700 * MB, external: 85 * MB, arrayBuffers: 40 * MB },
      metrics,
      { mcpBridgeSessions: 66 },
    );
    expect(line).toBe(
      'sample main{rss=1720 heapUsed=640 heapTotal=700 external=85 arrayBuffers=40} ' +
        'processes=4 total=3315 mcpBridgeSessions=66 Browser=1720 Tab=1366,180 Utility=49 (MB)',
    );
  });
});
