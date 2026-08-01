/**
 * 仓内清单正本 config/endpoint.json(cn)与 config/endpoint.global.json(global)
 * 的 CI 守门测试。
 *
 * 发布方式是人肉上传各自 region 的 hotfix CDN(`<base>/endpoint.json`,暂无发布
 * 脚本),这条测试是上传前的唯一自动防线:改 CDN 前必须先改仓内正本并让本测试
 * 通过。客户端仍会在清单原文无法解析时阻断,所以这里保证正本永远能被客户端
 * parser 接受;region 不适用的 endpoint 字段允许缺失或留空。区域身份和两区清单
 * 地址由客户端构建配置提供，不写进远端清单。
 *
 * 构建期自举 CDN 基址直接读取同一份清单的 cdnBaseUrl，不再维护第二份镜像。
 * 清单即业务端点唯一事实源:parser 会把缺失/空白 endpoint 归一为空串。
 *
 * `_` 前缀键约定为正本内注释(JSON 无注释语法;客户端 parser 按未知字段忽略),
 * 未知字段检查对其豁免。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CLIENT_ENDPOINT_KEYS,
  CLIENT_ENDPOINT_REVIEW_KEY,
  CLIENT_ENDPOINTS_SCHEMA_VERSION,
  parseClientEndpointManifest,
} from '../clientEndpoints';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const MANIFESTS = [
  { label: 'cn', filePath: path.join(REPO_ROOT, 'config', 'endpoint.json') },
  { label: 'global', filePath: path.join(REPO_ROOT, 'config', 'endpoint.global.json') },
] as const;

describe.each(MANIFESTS)('config/endpoint*.json 守门($label)', ({ filePath }) => {
  const rawText = fs.readFileSync(filePath, 'utf8');

  it('必须能被客户端共享 parser 接受(JSON/schema/非空 URL 仍需合法)', () => {
    const result = parseClientEndpointManifest(rawText);
    expect(result).toMatchObject({ ok: true });
  });

  it('schemaVersion 与客户端支持版本一致', () => {
    const parsed = JSON.parse(rawText) as { schemaVersion?: number };
    expect(parsed.schemaVersion).toBe(CLIENT_ENDPOINTS_SCHEMA_VERSION);
  });

  it('无未知字段(字段名拼错会被客户端当未知字段忽略,静默不生效)', () => {
    const parsed = JSON.parse(rawText) as Record<string, unknown>;
    const keys = Object.keys(parsed).filter(
      (key) => key !== 'schemaVersion' && !key.startsWith('_'),
    );
    const allowed = new Set<string>([
      ...CLIENT_ENDPOINT_KEYS,
      CLIENT_ENDPOINT_REVIEW_KEY,
    ]);
    expect(keys.filter((key) => !allowed.has(key))).toEqual([]);
  });
});
