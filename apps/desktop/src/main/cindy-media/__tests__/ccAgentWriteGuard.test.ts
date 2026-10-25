/**
 * ccAgentWriteGuard.test.ts — 历史媒体目录防回潮守门(规则 25)。
 * ---------------------------------------------------------------------------
 * `userData/cc-agent/` 是冻结的历史兼容层:历史协议只读服务历史地址,存量写入点已
 * 按迁移计划切到 cindy-media,**不许再有新增代码路径拼 cc-agent 目录**。
 *
 * 守门方式:静态扫描 main 源码里的 `'cc-agent'` 字符串字面量,持有文件必须
 * ⊆ 下面的白名单。新文件想引用 cc-agent(哪怕只读)会让本测试红灯——这是
 * 有意的摩擦:先读 docs/dev-rules/media-storage-and-protocols.md,确认属于豁免场景
 * (老地址只读服务 / 声明过的存量遗留)再把文件加进白名单,并在 PR 里说明。
 *
 * 白名单条目的存在理由(删掉某文件的 cc-agent 引用后应同步移出):
 *   - imageCacheStore / videoCacheStore / modelCacheStore:冻结老 store,
 *     只读服务 xdt-image/video/model 历史地址 + 声明过的存量回落写入;
 *   - im/host.ts:IM 老目录 paths(非图片文件与回落副本)+ 注入说明;
 *     (confluence.ts / jira.ts 已随 lizi_jira / lizi_confluence 退役删除,
 *      2026-07-14 迁入 xd-atlassian 意识;mcp-integrations/feishu.ts 已随主机
 *      飞书 token 链退役删除,2026-07-17 授权切 xd-feishu 意识 OAuth broker;
 *      历史附件只读路径都留在 imageCacheStore)
 *   - session-share/sessionShareExport.ts / sessionShareImport.ts:读老地址打包 +
 *     非媒体散件/回落的老目录;
 *   - cindy-media/legacyDeadDirs.ts:死目录清退——对历史兼容层的唯一
 *     允许删除操作,只认三个死目录名单,不新增任何写入;
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const MAIN_ROOT = path.resolve(__dirname, '../..');
const SHARED_MEDIA_ROOT = path.resolve(MAIN_ROOT, '../../../../packages/media-core/src');
const TERMINAL_ROOT = path.resolve(MAIN_ROOT, '../../../../apps/cindy-terminal/src');

/** 允许出现 'cc-agent' 字面量的 main 源码文件(相对 src/main,POSIX 分隔)。 */
const ALLOWED_FILES = new Set([
  'cindy-media/legacyDeadDirs.ts',
  'im/host.ts',
  '../../../cindy-terminal/src/im/transport-host.ts',
  '../../../../packages/media-core/src/legacy-image-cache.ts',
  'modelCacheStore.ts',
  'session-share/sessionShareExport.ts',
  'session-share/sessionShareImport.ts',
]);

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__' || entry.name === 'node_modules' || /\.test\.[cm]?tsx?$/.test(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTsFiles(abs);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      yield abs;
    }
  }
}

/**
 * 命中判定:**独立的 'cc-agent' 路径段字面量**(path.join 风格,目录引用的
 * 唯一常规写法)。曾按 review 建议试过宽扫"任意字符串含 cc-agent",实测误伤
 * 三个无关文件(renderer 路由 '/cc-agent/boot'、老 IPC channel 名
 * 'cc-agent:plan-file-write')——同名不同物,噪声大于收益,回退精确匹配。
 * 已接受的残余风险:模板串拼接(`${dir}/cc-agent/x`)绕得过本守门,交由
 * review 的规则 25 必查兜底。
 */
const CC_AGENT_IN_STRING_RE = /['"`]cc-agent['"`]/;

describe('cc-agent 写入防回潮守门(规则 25)', () => {
  it("Desktop、终端和共享媒体源码引用 'cc-agent' 目录的文件必须在冻结白名单内", () => {
    const offenders: string[] = [];
    for (const file of [MAIN_ROOT, SHARED_MEDIA_ROOT, TERMINAL_ROOT].flatMap(root => [...walkTsFiles(root)])) {
      const content = fs.readFileSync(file, 'utf-8');
      if (!CC_AGENT_IN_STRING_RE.test(content)) continue;
      const rel = path.relative(MAIN_ROOT, file).split(path.sep).join('/');
      if (!ALLOWED_FILES.has(rel)) offenders.push(rel);
    }
    expect(
      offenders,
      `以下文件新引用了冻结的 cc-agent 历史目录。新媒体写入必须走 cindy-media 总仓` +
        `(docs/dev-rules/media-storage-and-protocols.md);` +
        `确属只读服务老地址等豁免场景时,把文件加进本测试白名单并在 PR 里说明:\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('白名单不含已经不再引用 cc-agent 的文件(保持清单与现实同步)', () => {
    const stale: string[] = [];
    for (const rel of ALLOWED_FILES) {
      const abs = path.join(MAIN_ROOT, ...rel.split('/'));
      if (!fs.existsSync(abs)) {
        stale.push(`${rel}(文件不存在)`);
        continue;
      }
      const content = fs.readFileSync(abs, 'utf-8');
      if (!CC_AGENT_IN_STRING_RE.test(content)) {
        stale.push(`${rel}(已无 cc-agent 引用,请移出白名单)`);
      }
    }
    expect(stale).toEqual([]);
  });
});
