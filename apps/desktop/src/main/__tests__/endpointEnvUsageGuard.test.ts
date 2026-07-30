/**
 * 端点类 import.meta.env 使用守门(静态断言)。
 *
 * 远程端点清单上线后,端点必须走 clientEndpointsService 运行期读取;任何新增的
 * 模块级 / 散点 `import.meta.env.VITE_<端点>` 读取都会把该端点静默钉死在构建期
 * 烘焙值上——不报错、typecheck 拦不住,只有改 OSS 清单时才暴露。本测试扫描
 * src 全量 .ts/.tsx 源码,把端点类 VITE_* 的直接读取限制在两个白名单文件里:
 *  - src/shared/endpoints.ts(烘焙值权威源)
 *  - src/main/clientEndpointsService.ts(烘焙 map 组装)
 *
 * 新端点消费一律走 getClientEndpoint()(main)或 electronAPI.clientEndpoints
 * (renderer),不要扩白名单。VITE_CINDY_AUTH_REGION 等
 * 非端点构建身份不在管控范围。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ENDPOINT_ENV_KEYS = [
  // 现役:本区与对端的两份端点清单自举基址。
  'VITE_ENDPOINT_MANIFEST_BASE_URL',
  'VITE_ENDPOINT_MANIFEST_PEER_BASE_URL',
  // 以下为已退役键(2026-07 端点清单重构后不再注入)——保留在名单里防复活:
  // 谁重新读它们,拿到的永远是空串/漂移值。
  'VITE_API_BASE_URL',
  'VITE_CINDY_AUTH_BASE_URL',
  'VITE_DEVICE_LINK_API_BASE_URL',
  'VITE_OAUTH_BROKER_API_BASE_URL',
  'VITE_HEARTBEAT_URL',
  'VITE_SLACK_HOOK_WS_URL',
  'VITE_WEBSITE_URL',
  'VITE_XD_GATEWAY_BASE_URL',
  'VITE_CDN_BASE_URL',
  'VITE_CDN_INTERNAL_BASE_URL',
];

// clientEndpointsService 已不再读 import.meta.env(烘焙 map 随 baked 兜底退役),
// 白名单收缩为唯一的烘焙适配层。
const ALLOWED_FILES = new Set([path.join('shared', 'endpoints.ts')]);

const PATTERN = new RegExp(`import\\.meta\\.env\\.(?:${ENDPOINT_ENV_KEYS.join('|')})\\b`);

function* walkSourceFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkSourceFiles(full);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield full;
    }
  }
}

describe('端点类 import.meta.env 只允许出现在白名单文件', () => {
  it('src 下无越权直接读取', () => {
    const violations: string[] = [];
    for (const file of walkSourceFiles(SRC_ROOT)) {
      const rel = path.relative(SRC_ROOT, file);
      if (ALLOWED_FILES.has(rel)) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (PATTERN.test(content)) violations.push(rel);
    }
    expect(
      violations,
      `以下文件直接读取端点类 import.meta.env(应改走 getClientEndpoint / electronAPI.clientEndpoints):\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('白名单文件本身仍存在(防重命名后守门空转)', () => {
    for (const rel of ALLOWED_FILES) {
      expect(fs.existsSync(path.join(SRC_ROOT, rel)), rel).toBe(true);
    }
  });
});
