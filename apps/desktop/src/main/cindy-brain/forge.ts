/**
 * forge.ts — 意识锻造(agent 帮用户做意识的主机真身,2026-07-11 Lizi 定案)。
 *
 * 两件事,全部纯 Node(零 Electron 依赖,单测直喂目录,规则 14):
 * - FORGE_GUIDE:随主机版本走的《意识编写手册》,经总机 ghost_forge_guide
 *   喂给 agent——替代"人读的作者文档",同事对 AI 说"帮我做个 XX 意识"即可;
 * - packGhostDir:源码目录 → 校验(与装入同一套 validateGhostManifest)→
 *   打包 .cindy 到源码目录自身(id-version.cindy,同名覆盖;shouldSkip 跳过
 *   *.cindy 防套娃)。装入确认弹窗由调用方(mcp-integrations 接线)经双击
 *   转交通道触发,本文件不碰 UI。
 *
 * 安全边界:agent 能写意识源码(它本来就有文件工具),但打包必须过校验、
 * 装入必须过用户确认框(默认沉睡)——与手动拖 .cindy 完全同一条门。
 */

import fs from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

import {
  GHOST_MANIFEST_FILE,
  GHOST_SKILL_MD_MAX_BYTES,
  validateGhostManifest,
  type GhostManifest,
} from '../../shared/ghost.js';
import {
  GHOST_MANIFEST_MAX_BYTES,
  readBoundedFileNoFollow,
} from '../utils/readBoundedFile.js';
import { validateGhostLocaleResourcesInDirectory } from './ghostLocaleFiles.js';
import { checkSkillMdConsistency } from './skillSlot.js';

/** 与 GhostManager 装入侧同一量级的上限(打包侧提前拦,fail fast)。 */
const MAX_BASIC_FILES = 256;
const MAX_NODE_FILES = 2_048;
const MAX_BASIC_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_NODE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_BASIC_CINDY_BYTES = 8 * 1024 * 1024;
const MAX_NODE_CINDY_BYTES = 128 * 1024 * 1024;

/** 打包时跳过的目录/文件(源码目录里的开发残留,不属于意识本体)。 */
function shouldSkip(name: string): boolean {
  if (name.startsWith('.')) return true; // .git / .DS_Store / .disabled 等
  if (name.toLowerCase() === 'node_modules') return true;
  if (name.toLowerCase().endsWith('.cindy')) return true; // 上次打包产物,防套娃
  return false;
}

export type ForgePackResult =
  | { ok: true; cindyPath: string; manifest: GhostManifest }
  | {
      ok: false;
      errorCode: 'DIR_NOT_FOUND' | 'MANIFEST_INVALID' | 'ENTRY_MISSING' | 'TOO_LARGE' | 'INTERNAL';
      message: string;
    };

/** 对话制作插件时可直接生成的四种安全起步模板。 */
export const FORGE_SCAFFOLD_TEMPLATES = [
  'plain',
  'agent-action',
  'node-json-rpc',
  'node-mcp',
] as const;
export type ForgeScaffoldTemplate = (typeof FORGE_SCAFFOLD_TEMPLATES)[number];

export type ForgeScaffoldResult =
  | {
      ok: true;
      dir: string;
      template: ForgeScaffoldTemplate;
      files: string[];
      nextSteps: string[];
    }
  | {
      ok: false;
      errorCode: 'INVALID_INPUT' | 'TARGET_EXISTS' | 'INTERNAL';
      message: string;
    };

interface ForgeScaffoldInput {
  dir: string;
  template: ForgeScaffoldTemplate;
  id: string;
  name: string;
  description?: string;
}

/** 生成插件清单；先走正式校验，再允许任何文件落盘。 */
function scaffoldManifest(input: ForgeScaffoldInput): Record<string, unknown> {
  const common = {
    schemaVersion: 2,
    id: input.id,
    name: input.name,
    description: input.description?.trim() || `${input.name} 插件`,
    whenToUse: input.description?.trim() || `需要使用 ${input.name} 提供的能力时`,
    version: '1.0.0',
    kind: 'chip',
    entry: 'main.js',
    icon: 'assets/icon.png',
  };
  if (input.template === 'agent-action') {
    return {
      ...common,
      slots: ['tool', 'card', 'agent'],
      tools: [
        {
          name: 'show_agent_actions',
          description: '显示继续、分叉或新建 Agent 会话的操作卡片。',
          parameters: { type: 'object', properties: {} },
        },
      ],
    };
  }
  if (input.template === 'node-json-rpc') {
    return {
      ...common,
      slots: ['tool', 'node'],
      tools: [
        {
          name: 'node_echo',
          description: '通过随包 Node 工作进程原样返回一段文字。',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: '要交给 Node 的文字' } },
            required: ['text'],
          },
        },
      ],
      node: {
        entry: 'node/worker.cjs',
        protocol: 'json-rpc-stdio',
        lifecycle: 'on-demand',
        idleTimeoutSeconds: 120,
      },
    };
  }
  if (input.template === 'node-mcp') {
    return {
      ...common,
      slots: ['tool', 'node'],
      tools: [
        {
          name: 'echo_via_mcp',
          description: '调用随包 stdio MCP 的 echo 工具。',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: '要交给 MCP 的文字' } },
            required: ['text'],
          },
        },
      ],
      node: {
        entry: 'node/worker.cjs',
        protocol: 'mcp-stdio',
        lifecycle: 'on-demand',
        idleTimeoutSeconds: 120,
      },
    };
  }
  return {
    ...common,
    slots: ['tool'],
    tools: [
      {
        name: 'hello',
        description: '返回一句问候，用来确认插件已经正常工作。',
        parameters: { type: 'object', properties: {} },
      },
    ],
  };
}

/** 最小浏览器沙箱插件的 main.js。 */
function plainMainSource(): string {
  return `cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call' || msg.tool !== 'hello') return;
  await cindy.send({
    type: 'tool-result',
    callId: msg.callId,
    ok: true,
    result: { message: '插件已经正常工作。' }
  });
});
`;
}

/** 带交互卡片和真实用户点击票的 Agent 模板。 */
function agentActionMainSource(): string {
  return `cindy.onHostMessage(async function (msg) {
  if (msg.type === 'tool-call' && msg.tool === 'show_agent_actions') {
    await cindy.send({
      type: 'card-update',
      callId: msg.callId,
      v: 2,
      html: '<div style="padding:12px"><p>让 Agent 接下来怎么做？</p><button data-ghost-action="continue">继续当前会话</button> <button data-ghost-action="fork">分叉会话</button> <button data-ghost-action="new">新建会话</button></div>',
      height: 150
    });
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: true,
      result: { note: '请用户在卡片上选择下一步。' }
    });
    return;
  }

  if (msg.type !== 'event' || msg.name !== 'card-action') return;
  if (!msg.userActionToken) {
    await cindy.send({
      type: 'card-update',
      callId: msg.spawnCallId,
      v: 2,
      state: 'done',
      html: '<div style="padding:12px">这次点击没有拿到有效通行票，请重新点击原卡片。</div>',
      height: 110
    });
    return;
  }

  const mode = msg.actionId === 'fork' ? 'fork' : msg.actionId === 'new' ? 'new' : 'continue';
  const result = await cindy.agent.run({
    mode: mode,
    promptTemplate: '用户要求：{{user_message}}\\n插件事件：{{event_json}}\\n请继续处理。',
    userMessage: msg.prompt || '请继续处理当前任务',
    event: { actionId: msg.actionId, callId: msg.callId },
    userActionToken: msg.userActionToken,
    title: mode === 'new' ? '插件发起的新任务' : undefined
  });
  await cindy.send({
    type: 'card-update',
    callId: msg.spawnCallId,
    v: 2,
    state: 'done',
    html: result.ok
      ? '<div style="padding:12px">Agent 已收到任务。</div>'
      : '<div style="padding:12px">没有成功发给 Agent，请重新点击后再试。</div>',
    height: 110
  });
});
`;
}

/** 普通 JSON-RPC Node 服务的 main.js。 */
function nodeJsonRpcMainSource(): string {
  return `cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call' || msg.tool !== 'node_echo') return;
  const response = await cindy.node.request({
    method: 'echo',
    params: { text: String(msg.args.text || '') }
  });
  if (!response.ok) {
    await cindy.send({
      type: 'tool-result', callId: msg.callId, ok: false,
      errorCode: 'NODE_REQUEST_FAILED', message: response.message
    });
    return;
  }
  await cindy.send({
    type: 'tool-result', callId: msg.callId, ok: true,
    result: response.result
  });
});
`;
}

/** 普通 JSON-RPC Node 服务的零依赖 worker。 */
function nodeJsonRpcWorkerSource(): string {
  return `const readline = require('node:readline');

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

readline.createInterface({ input: process.stdin }).on('line', function (line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (request.method === 'echo') {
    reply({ jsonrpc: '2.0', id: request.id, result: { text: String(request.params?.text || '') } });
    return;
  }
  reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
});
`;
}

/** stdio MCP 模板的 main.js。 */
function nodeMcpMainSource(): string {
  return `cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call' || msg.tool !== 'echo_via_mcp') return;
  const response = await cindy.node.request({
    method: 'tools/call',
    params: { name: 'echo', arguments: { text: String(msg.args.text || '') } }
  });
  if (!response.ok) {
    await cindy.send({
      type: 'tool-result', callId: msg.callId, ok: false,
      errorCode: 'MCP_REQUEST_FAILED', message: response.message
    });
    return;
  }
  await cindy.send({
    type: 'tool-result', callId: msg.callId, ok: true,
    result: { mcpResult: response.result }
  });
});
`;
}

/** stdio MCP 的最小零依赖 worker，含 initialize / tools/list / tools/call。 */
function nodeMcpWorkerSource(): string {
  return `const readline = require('node:readline');

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

readline.createInterface({ input: process.stdin }).on('line', function (line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'initialize') {
    reply({
      jsonrpc: '2.0', id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'cindy-scaffold-mcp', version: '1.0.0' }
      }
    });
    return;
  }
  if (request.method === 'tools/list') {
    reply({
      jsonrpc: '2.0', id: request.id,
      result: { tools: [{
        name: 'echo', description: '原样返回文字',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text']
        }
      }] }
    });
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'echo') {
    reply({
      jsonrpc: '2.0', id: request.id,
      result: { content: [{ type: 'text', text: String(request.params.arguments?.text || '') }] }
    });
    return;
  }
  reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
});
`;
}

/**
 * 占位图标(128×128 纯色 PNG,离线生成后内嵌)。让「有图标」成为骨架默认:
 * 不配 icon 的插件在面板和身份头里只有默认拼图占位符,作者往往到发布才发现。
 * 官方插件仓惯例图标放 assets/icon.png(见 FORGE_GUIDE §8.1),骨架直接对齐。
 */
const SCAFFOLD_ICON_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAABEElEQVR42u3SMREAIAwAsfpFAAsKOETgtCyYgGZ4A3+J1leqbmECAEYAIABuY259HAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJgEgAAQAAJAAAgAASAABIAAEAACQAAIAAEgAASAABAAAkAACAABIAAEgAAQAAJAAAgAASAABIAAEAACQAAIAAEgAASAABAAAkAACAABIAAEgAAQAAJAAAgAASAABIAAEAACQAAIAAEgAASAABAAAkAACAABIAAEgAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAmASAABAAAkAACAABIAAEgAAQAAJAAAgAASAABIAAEAACQADodQCqFQAAmACAynYAQtWXyojiIUQAAAAASUVORK5CYII=';

/** 按模板产出相对路径到源码内容的完整映射。 */
function scaffoldFiles(input: ForgeScaffoldInput): Record<string, string | Buffer> {
  const manifest = scaffoldManifest(input);
  const files: Record<string, string | Buffer> = {
    [GHOST_MANIFEST_FILE]: `${JSON.stringify(manifest, null, 2)}\n`,
    'main.js':
      input.template === 'agent-action'
        ? agentActionMainSource()
        : input.template === 'node-json-rpc'
          ? nodeJsonRpcMainSource()
          : input.template === 'node-mcp'
            ? nodeMcpMainSource()
            : plainMainSource(),
    'assets/icon.png': Buffer.from(SCAFFOLD_ICON_PNG_BASE64, 'base64'),
  };
  if (input.template === 'node-json-rpc') files['node/worker.cjs'] = nodeJsonRpcWorkerSource();
  if (input.template === 'node-mcp') files['node/worker.cjs'] = nodeMcpWorkerSource();
  return files;
}

/** 判断 Node 文件错误码，不用平台相关的错误文案做分支。 */
function hasFsErrorCode(err: unknown, code: string): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && err.code === code);
}

/**
 * 创建一份不覆盖任何现有内容的插件源码骨架。
 *
 * 文件先写进同目录临时文件夹，全部成功后再一次 rename 到目标；目标已经
 * 存在时直接拒绝，因此并发调用也不会把用户原文件覆盖一半。
 */
export async function scaffoldGhostDir(
  input: ForgeScaffoldInput,
  options?: { sessionWorkdir?: string | null },
): Promise<ForgeScaffoldResult> {
  const template = input.template;
  if (!FORGE_SCAFFOLD_TEMPLATES.includes(template)) {
    return { ok: false, errorCode: 'INVALID_INPUT', message: `不认识的模板:${String(template)}` };
  }
  if (
    !path.isAbsolute(input.dir) ||
    path.resolve(input.dir) === path.parse(path.resolve(input.dir)).root
  ) {
    return { ok: false, errorCode: 'INVALID_INPUT', message: 'dir 必须是一个新的插件目录绝对路径' };
  }
  const resolved = path.resolve(input.dir);
  const workdir = options?.sessionWorkdir;
  if (!workdir) {
    return { ok: false, errorCode: 'INVALID_INPUT', message: '没有会话工作目录,无法确定骨架输出位置' };
  }
  // 字面 startsWith 不设防软链:工作目录里若有 out -> /tmp/out 之类的
  // 软链祖先,字面在内、实际在外。两边都按 realpath 对账——目标还不存在,
  // 就取「已存在的最深祖先」的真身再拼回剩余段。
  let realWorkdir: string;
  try {
    realWorkdir = await fs.promises.realpath(path.resolve(workdir));
  } catch {
    return { ok: false, errorCode: 'INVALID_INPUT', message: '会话工作目录不存在,无法确定骨架输出位置' };
  }
  let realAncestor = resolved;
  const pendingSegments: string[] = [];
  for (;;) {
    try {
      realAncestor = await fs.promises.realpath(realAncestor);
      break;
    } catch (err) {
      if (!hasFsErrorCode(err, 'ENOENT')) {
        return {
          ok: false,
          errorCode: 'INTERNAL',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const parent = path.dirname(realAncestor);
      if (parent === realAncestor) break; // 到根了,根一定存在,防御性兜底
      pendingSegments.unshift(path.basename(realAncestor));
      realAncestor = parent;
    }
  }
  const realTarget = path.join(realAncestor, ...pendingSegments);
  if (!realTarget.startsWith(`${realWorkdir}${path.sep}`) && realTarget !== realWorkdir) {
    return { ok: false, errorCode: 'INVALID_INPUT', message: 'dir 必须在当前会话工作目录内' };
  }
  const files = scaffoldFiles(input);
  // 显式收窄而非 as 断言:manifest 恒为 JSON 字符串,二进制项(占位图标)另存;
  // 未来若误把 manifest 写成 Buffer,这里在编译/测试期就报,而不是运行期 parse 炸。
  const manifestRaw = files[GHOST_MANIFEST_FILE];
  if (typeof manifestRaw !== 'string') {
    return { ok: false, errorCode: 'INTERNAL', message: 'scaffold manifest 必须是 JSON 字符串' };
  }
  const validation = validateGhostManifest(JSON.parse(manifestRaw));
  if (!validation.ok) {
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: `插件信息不合格:${validation.reason}`,
    };
  }

  const targetDir = path.resolve(input.dir);
  try {
    await fs.promises.lstat(targetDir);
    return {
      ok: false,
      errorCode: 'TARGET_EXISTS',
      message: `目标已经存在，不会覆盖:${targetDir}`,
    };
  } catch (err) {
    if (!hasFsErrorCode(err, 'ENOENT')) {
      return {
        ok: false,
        errorCode: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const parentDir = path.dirname(targetDir);
  let stagingDir: string | null = null;
  try {
    await fs.promises.mkdir(parentDir, { recursive: true });
    stagingDir = await fs.promises.mkdtemp(
      path.join(parentDir, `.${path.basename(targetDir)}-scaffold-`),
    );
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(stagingDir, rel);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, content, { encoding: 'utf8', flag: 'wx' });
    }
    try {
      await fs.promises.rename(stagingDir, targetDir);
      stagingDir = null;
    } catch (err) {
      if (hasFsErrorCode(err, 'EEXIST') || hasFsErrorCode(err, 'ENOTEMPTY')) {
        return {
          ok: false,
          errorCode: 'TARGET_EXISTS',
          message: `目标已经存在，不会覆盖:${targetDir}`,
        };
      }
      throw err;
    }
    return {
      ok: true,
      dir: targetDir,
      template,
      files: Object.keys(files).sort(),
      nextSteps: [
        '按需要修改 ghost.json、main.js 和 worker 源码。',
        '调用 ghost_forge_pack 打包并让用户确认安装。',
        'Node 模板不允许在安装或首次运行时执行 npm install、npx 或 postinstall。',
      ],
    };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'INTERNAL',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (stagingDir) {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * 打包核心:校验 + 收集 + 生成 zip buffer,不写盘。packGhostDir(产物进源码目录)
 * 与 packGhostDirToFile(产物去调用方指定路径,自定义市场安装管道用)共用,
 * 保证两条路径的校验与打包规则永远一致。
 */
async function buildGhostPackage(
  dir: string,
  /**
   * 调用方**已经校验过**的规范根(realpath 产物)。传入时,这里会核对自己解析出的
   * realpath 仍等于它,不等即拒。
   *
   * 为什么必须由调用方给:光靠"我自己 realpath 一次、再拿它当 containWithin 的锚点"
   * 是**自我参照**——插件目录或其父目录在调用方校验之后、这里解析之前被换成指向
   * 目录外的符号链接时,解析结果就是那个外部目录,以它为锚点的一切包含性判定自然
   * 全部通过,外部 payload 会被打包进去(外部目录只要留着同样的 ghost.json,清单
   * 对账也发现不了)。锚点必须来自上游的既有结论,不能在下游重新发明。
   */
  expectedRealDir?: string,
): Promise<
  | { ok: true; buf: Buffer; manifest: GhostManifest }
  | Exclude<ForgePackResult, { ok: true }>
> {
  try {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(dir);
    } catch {
      return { ok: false, errorCode: 'DIR_NOT_FOUND', message: `目录不存在:${dir}` };
    }
    if (!stat.isDirectory()) {
      return { ok: false, errorCode: 'DIR_NOT_FOUND', message: `不是目录:${dir}` };
    }
    // 后续所有读取都以 realpath 根做 containWithin 复核:O_NOFOLLOW 只管最后
    // 一个路径分量,校验后中间目录被换成根外链接的窗口靠它堵。
    const realDir = await fs.promises.realpath(dir);
    if (expectedRealDir !== undefined && realDir !== expectedRealDir) {
      return {
        ok: false,
        errorCode: 'MANIFEST_INVALID',
        message: '插件目录在打包前被替换(实际规范路径与调用方校验过的不一致)',
      };
    }

    // 1) 清单先行:与装入侧同一套校验,错在打包期就报清楚。
    // 读到的**原始字节**要留作不可变快照:后面生成 zip 时逐文件重新读盘,若
    // ghost.json 在"这里校验"与"写入 zip"之间被并发改写(保 id/version、加权限
    // 声明),返回的 manifest 与包里那份就会分叉——安装侧拿返回值做审阅比对,
    // 装进去的却是改过的包。快照写入让"校验的 = 返回的 = 包里的"三者恒等。
    // 与市场发现/安装层同一把闸(单句柄限量读,拒符号链接):打包输入目录是
    // 用户可写的活目录,按路径无界 readFile 会跟随链接读到目录外、或被超大
    // 文件耗尽内存。快照字节也必须出自这把闸,不能再按路径重读。
    let manifestRaw: unknown;
    let manifestBytes: Buffer;
    try {
      const bytes = await readBoundedFileNoFollow(
        path.join(realDir, GHOST_MANIFEST_FILE),
        GHOST_MANIFEST_MAX_BYTES,
        { containWithin: realDir },
      );
      if (bytes === null) {
        return {
          ok: false,
          errorCode: 'MANIFEST_INVALID',
          message: `${GHOST_MANIFEST_FILE} 不是普通文件或超过 ${GHOST_MANIFEST_MAX_BYTES} 字节上限`,
        };
      }
      manifestBytes = bytes;
      manifestRaw = JSON.parse(manifestBytes.toString('utf-8'));
    } catch (err) {
      return {
        ok: false,
        errorCode: 'MANIFEST_INVALID',
        message: `${GHOST_MANIFEST_FILE} 缺失或不是合法 JSON:${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const v = validateGhostManifest(manifestRaw);
    if (!v.ok) {
      return { ok: false, errorCode: 'MANIFEST_INVALID', message: `清单不合格:${v.reason}` };
    }
    const manifest = v.manifest;

    // 2) locale 资源必须真实、可解析且提供的条目合法(缺译回退原文,不拒)。
    // 与装入侧使用同一 validator，避免 Forge 能打包、安装却被拒的契约漂移。
    const localeValidation = validateGhostLocaleResourcesInDirectory(dir, manifest);
    if (!localeValidation.ok) {
      return {
        ok: false,
        errorCode: 'MANIFEST_INVALID',
        message: localeValidation.reason,
      };
    }

    // 3) 清单声明的入口文件必须真实在场(打包期拦,别等装入后沙箱 404)。
    const mustExist: string[] = [];
    if (manifest.entry) mustExist.push(manifest.entry);
    if (manifest.node?.entry) mustExist.push(manifest.node.entry);
    if (manifest.panel?.html) mustExist.push(manifest.panel.html);
    if (manifest.settingsHtml) mustExist.push(manifest.settingsHtml);
    for (const item of manifest.skill?.items ?? []) mustExist.push(`${item.dir}/SKILL.md`);
    for (const rel of mustExist) {
      try {
        // lstat 与收集侧(walk 的 Dirent)同一语义:声明的入口若是符号链接,
        // stat 会判"在场"而 walk 不收集它,装出的包缺入口、运行期才 404。
        const st = await fs.promises.lstat(path.join(dir, rel));
        if (!st.isFile()) throw new Error('not a file');
      } catch {
        return { ok: false, errorCode: 'ENTRY_MISSING', message: `清单声明的文件不存在:${rel}` };
      }
    }

    // 3.5) skill 槽:SKILL.md frontmatter 与清单声明必须逐字一致。与装入侧
    // (GhostManager.parse)共用同一裁判,避免"Forge 能打包、安装被拒"的漂移。
    for (const item of manifest.skill?.items ?? []) {
      const skillMdPath = path.join(dir, ...item.dir.split('/'), 'SKILL.md');
      let content: string;
      try {
        // 同一把单句柄限量闸:超限在读之前拒,符号链接不放行。
        const bytes = await readBoundedFileNoFollow(skillMdPath, GHOST_SKILL_MD_MAX_BYTES, {
          containWithin: realDir,
        });
        if (bytes === null) {
          return {
            ok: false,
            errorCode: 'MANIFEST_INVALID',
            message: `${item.dir}/SKILL.md 不是普通文件或超过 ${GHOST_SKILL_MD_MAX_BYTES} 字节上限`,
          };
        }
        content = bytes.toString('utf-8');
      } catch (err) {
        return {
          ok: false,
          errorCode: 'ENTRY_MISSING',
          message: `读取 ${item.dir}/SKILL.md 失败:${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const consistencyError = checkSkillMdConsistency(content, item);
      if (consistencyError) {
        return {
          ok: false,
          errorCode: 'MANIFEST_INVALID',
          message: `skill 条目 ${item.dir}:${consistencyError}`,
        };
      }
    }

    // 4) 收集文件(递归,跳过开发残留),数量/体积设限。
    const files: Array<{ rel: string; abs: string }> = [];
    let totalBytes = 0;
    const maxFiles = manifest.node ? MAX_NODE_FILES : MAX_BASIC_FILES;
    const maxTotalBytes = manifest.node ? MAX_NODE_TOTAL_BYTES : MAX_BASIC_TOTAL_BYTES;
    const seenPackPaths = new Set<string>();
    const walk = async (cur: string, relBase: string): Promise<Exclude<ForgePackResult, { ok: true }> | null> => {
      const entries = await fs.promises.readdir(cur, { withFileTypes: true });
      for (const e of entries) {
        if (shouldSkip(e.name)) continue;
        const abs = path.join(cur, e.name);
        const rel = relBase ? `${relBase}/${e.name}` : e.name;
        const foldedRel = rel.toLowerCase();
        if (seenPackPaths.has(foldedRel)) {
          return {
            ok: false,
            errorCode: 'MANIFEST_INVALID',
            message: `源码目录含大小写折叠后重复的路径:${rel}`,
          };
        }
        seenPackPaths.add(foldedRel);
        if (e.isDirectory()) {
          const bad = await walk(abs, rel);
          if (bad) return bad;
        } else if (e.isSymbolicLink()) {
          // 符号链接一律不穿透。此前是静默跳过——OneDrive 未水合占位文件、
          // 仓库里提交的链接都会被悄悄丢出包外,校验说"在场"、包里却没有,
          // 运行期才 404。改为结构化拒绝,错误可见。
          return {
            ok: false,
            errorCode: 'MANIFEST_INVALID',
            message: `源码目录含符号链接条目,不允许打包:${rel}`,
          };
        } else if (e.isFile()) {
          files.push({ rel, abs });
          totalBytes += (await fs.promises.stat(abs)).size;
          if (files.length > maxFiles) {
            return { ok: false, errorCode: 'TOO_LARGE', message: `文件过多(上限 ${maxFiles} 个)` };
          }
          if (totalBytes > maxTotalBytes) {
            return {
              ok: false,
              errorCode: 'TOO_LARGE',
              message: `总体积超上限(${maxTotalBytes} 字节)`,
            };
          }
        }
      }
      return null;
    };
    const tooLarge = await walk(dir, '');
    if (tooLarge) return tooLarge;

    // 5) 生成 zip buffer。文件收集在此之前完成 + shouldSkip 跳过 *.cindy,
    // 产物自身不会进包;写盘位置由调用方决定(packGhostDir 进源码目录,
    // packGhostDirToFile 进调用方指定路径)。
    const zip = new JSZip();
    // 身份卡用第 1 步的不可变快照,其余文件走同一把单句柄限量闸现读:walk 里
    // 的 stat 只是预算预估,文件可在 walk 与此处之间被换成超大文件或符号链接
    // (网络共享/并发写)。真正的边界在读取时按**剩余总预算**强制执行,任何
    // 文件被并发改动(换链接/删除/膨胀)都结构化拒绝,不把无界字节交给 JSZip。
    let packedBytes = 0;
    for (const f of files) {
      let content: Buffer;
      if (f.rel === GHOST_MANIFEST_FILE) {
        content = manifestBytes;
      } else {
        let bytes: Buffer | null;
        try {
          bytes = await readBoundedFileNoFollow(f.abs, maxTotalBytes - packedBytes, {
            containWithin: realDir,
          });
        } catch {
          bytes = null;
        }
        if (bytes === null) {
          return {
            ok: false,
            errorCode: 'TOO_LARGE',
            message: `文件在打包期间被并发改动或超出剩余体积预算:${f.rel}`,
          };
        }
        content = bytes;
      }
      packedBytes += content.byteLength;
      zip.file(f.rel, content);
    }
    const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const maxCindyBytes = manifest.node ? MAX_NODE_CINDY_BYTES : MAX_BASIC_CINDY_BYTES;
    if (buf.byteLength > maxCindyBytes) {
      return {
        ok: false,
        errorCode: 'TOO_LARGE',
        message: `压缩包体积超上限(${maxCindyBytes} 字节)`,
      };
    }
    return { ok: true, buf, manifest };
  } catch (err) {
    return {
      ok: false,
      errorCode: 'INTERNAL',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 校验 + 打包一个意识源码目录。产物写到源码目录自身(<id>-<version>.cindy,
 * 同名覆盖——同 id 同版本重打包语义上就是同一个包),用户在自己的意识目录里
 * 就能拿到成品;出错返回结构化分类,agent 按 message 修源码即可,不抛异常。
 */
export async function packGhostDir(dir: string): Promise<ForgePackResult> {
  const built = await buildGhostPackage(dir);
  if (!built.ok) return built;
  // 产物跟源码住一起(2026-07 Lizi 定案:拿取直观);文件收集在写盘之前完成
  // + shouldSkip 跳过 *.cindy,自身产物不会进包;同名覆盖。
  const cindyPath = path.join(dir, `${built.manifest.id}-${built.manifest.version}.cindy`);
  try {
    await fs.promises.writeFile(cindyPath, built.buf);
  } catch (err) {
    return {
      ok: false,
      errorCode: 'INTERNAL',
      message: `写入打包产物失败:${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, cindyPath, manifest: built.manifest };
}

/**
 * 打包到调用方指定的绝对路径。自定义市场安装管道用:市场克隆缓存是只读事实,
 * 产物落到临时目录,装完即删。校验与打包规则与 packGhostDir 完全一致。
 *
 * `expectedRealDir` **必填**:这条路径的输入来自用户可写的市场目录,打包器不能
 * 自己 realpath 一次就当锚点(自我参照,见 buildGhostPackage 的说明)。做成必填
 * 而不是可选,是为了让新调用方无法跳过——签名逼着它交出上游已经校验过的规范根。
 */
export async function packGhostDirToFile(
  dir: string,
  destPath: string,
  expectedRealDir: string,
): Promise<ForgePackResult> {
  const built = await buildGhostPackage(dir, expectedRealDir);
  if (!built.ok) return built;
  try {
    // 0o600:临时包可能落在共享 /tmp,不给同机其它用户读权限。
    await fs.promises.writeFile(destPath, built.buf, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    return {
      ok: false,
      errorCode: 'INTERNAL',
      message: `写入打包产物失败:${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, cindyPath: destPath, manifest: built.manifest };
}

/**
 * 《意识编写手册》——ghost_forge_guide 的返回体。随主机版本演进,改了机制
 * 就同步改这里;agent 每次做意识前现拿现读,永不过期。
 */
export const FORGE_GUIDE = `# 意识(Ghost)编写手册

意识是 Cindy 的第三方能力包,文件形态是 \`.cindy\`(zip 包)。装入后可给
主机叠加:AI 可调用的工具、常驻界面面板、模型代办能力。本手册教你(agent)替用户
写一个意识。**流程:先取手册目录 → 按 §0 用提问卡片和用户对齐设计 → 按需用 section
读透相关章(动手前至少读完"沙箱红线"与"打包与测试"两章) → 在工作目录写源码文件 →
ghost_forge_pack 打包 → 用户在弹窗上确认装入。**

从零开始时优先调用 \`ghost_forge_scaffold\` 生成一份不会覆盖现有文件的骨架，再在
骨架上修改。可选模板:\`plain\`(普通沙箱工具)、\`agent-action\`(卡片点击后让 Agent
继续工作)、\`node-json-rpc\`(普通随包 Node 服务)、\`node-mcp\`(随包 stdio MCP)。

## 0. 设计对齐:动手前用提问卡片确认关键决策

用户通常不知道意识能做成哪些形态——你不主动摆出来,他就只会得到一个"默认样子"的
插件。所以写任何代码之前,先用**带选项的提问**和用户对齐设计:宿主支持带选项的
提问卡片(用户点选项即可回答)就优先用卡片;没有就一次只问一个问题、正文里给出
编号选项。规则:

- 一张卡片聚焦一个决策,给 2–4 个具体选项并标注你的**推荐项**,不问开放式的"你想要什么"。
- 选项用用户听得懂的话描述效果与代价(如"常驻会一直占一份后台资源")。
- 只问需求推不出来的;能从用户描述直接推断的不要问,一般 3–6 个决策问完。

值得主动摆出来让用户选的"隐藏"设计选项(详见对应章节):

- **界面形态**:无界面(纯工具)/ 聊天卡片(card 槽,§4.5)/ 停靠面板(panel.position
  left,§5)/ 插件页内独占面板(position "tab",从插件页「使用」打开、离开即关,§5)。
- **唤起方式**:只靠 AI 按 whenToUse 自动想起,还是同时声明 \`command\` 点名词让用户
  显式点名(推荐,§2)。
- **启动模式**:on-demand 按需拉起(缺省,推荐)/ resident 常驻(仅订阅型、要秒响应
  的场景,§2)。
- **后台能力**:要不要旁听事件(subscribe 槽,§4.6)、发系统提示(notify 槽,§4.9)、
  动手前弹确认框征求同意(confirm 槽,§4.18)。
- **联网与凭证**:要不要 network 槽白名单联网(§4.7);要用户填 key 就需要 setup
  就绪声明与 settingsHtml 设置区(§4.7、§4.8)。
- **运行形态**:纯沙箱 main.js 够用,还是要随包 Node 进程装依赖跑重活(node 槽,§4.12)。
- **媒体代办**:要不要让主机代生成/改图/视频(cindy 槽,§2、§4.0.1)。

问完后把选择复述成一份简短设计小结(要解决的问题/目标用户/交互流程/所选形态/
权限边界/验收标准),并顺带说明源码会放在工作目录的哪个文件夹——位置不需要用户选
(骨架只能建在会话工作目录内,装入后归主机统一管理),让用户知情即可。用户确认
小结后再动手。**修改现有意识同样适用**:先读现有 ghost.json 与源码,列出改动会
影响哪些已选形态,再让用户确认。

## 1. 目录结构(最小可用)

\`\`\`
my-ghost/
├── ghost.json    ← 身份卡(必须,zip 根部)
├── main.js       ← 电子脑:后台逻辑入口(声明了 tools/cindy 时必须)
├── assets/
│   └── icon.png  ← 建议:插件图标(声明 icon 字段时必须存在;scaffold 会生成占位图,请替换成自己的)
├── locales/      ← 可选:宿主驱动的清单文案翻译(声明 locales 时英文必须存在)
│   ├── en.json
│   ├── zh-CN.json
│   ├── ja.json
│   └── ko.json
├── node/
│   └── worker.cjs ← 可选:随包 Node/stdio MCP 入口(声明 node 槽时必须,见 §4.12)
├── panel.html    ← 面板界面(声明了 panel.html 时必须)
├── panel.css
├── panel.js
└── settings.html ← 自定义设置区(声明了 settingsHtml 时必须,见 §4.8)
\`\`\`

## 2. ghost.json 身份卡

\`\`\`json
{
  "schemaVersion": 2,
  "id": "my-ghost",            // 小写字母/数字/连字符,1–32 位,全局唯一
  "name": "我的意识",           // 展示名
  "description": "一句话说清这段意识是干嘛的(给人看:装入确认框/详情页)",  // 1–300 字
  "whenToUse": "需要生成图片、插画、配图、修图、P 图、改图时找我",  // 1–300 字,给模型看:进 agent 会话的意识花名册,是"用户不点名时 AI 能不能想起你"的关键。写成场景枚举,可反复调优;缺省时花名册回落用 description
  "icon": "assets/icon.png",   // 建议:插件图标(包内相对路径;扩展名限 png/jpg/jpeg/webp/gif,不收 svg——svg 可携带脚本,虽经 <img> 渲染不执行,仍不给这个面)。不配则面板与消息身份头显示默认拼图占位符;官方插件仓惯例放 assets/icon.png
  "locales": {                 // 可选:插件只跟随宿主语言;不支持/缺失语言固定回退 en
    "en": "locales/en.json",
    "zh-CN": "locales/zh-CN.json",
    "ja": "locales/ja.json",
    "ko": "locales/ko.json"
  },
  "version": "1.0.0",
  "entry": "main.js",          // 电子脑入口(kind 字段已无需填写:意识只有芯片一种形态,缺省即 chip;写了也只认 "chip")
  "launch": "on-demand",       // 可选:电子脑启动模式。on-demand(缺省)=被需要才拉起;resident=唤醒即常驻(确认框会如实标注"常驻运行",绝大多数意识不需要,仅订阅型/需秒响应的场景用)
  "slots": ["tool", "cindy", "panel"],   // 能力白名单,没声明的槽运行时不存在
  "command": "画图",            // 推荐:用户 $画图 显式点名(与已装意识查重,冲突拒装)。
  // 注意:不声明 command 时,插件页"使用"按钮将处于禁用状态——用户无法通过插件页
  // 一键启用/唤起插件,也不能用 $command 显式点名;但 AI 的工具发现与调用不受影响
  // (仅检查插件启用状态与 tools 声明)。除非你的插件完全靠 panel 或 subscribe 驱动,
  // 否则请始终声明一个 command。
  "tools": [ /* 见 §3 */ ],
  "cindy": { "image": ["generate", "edit"] },   // 声明了 cindy 槽时必写:能力详单,见下
  // 三个类目:image / video 的动作是 "generate" | "edit";media 的动作只有
  // "deposit"(把你手里的媒体字节寄存进总仓换指纹,见 §4.0.1)。按需申请,
  // 每条都会在装入确认框里单独列给用户看。
  "panel": { "title": "面板标题", "html": "panel.html", "position": "left",
             "minWidth": 240, "defaultFraction": 0.24,
             "systemButtons": { "maximize": false } },
  // panel.position:面板显示形态。left(缺省)= 停靠主聊天窗左侧;
  // "tab" = 插件页内的独占面板(用户在插件页点插件卡的「使用」打开,离开
  // 插件页即关闭;同一时刻至多一个;此形态没有拖缝宽度,声明 minWidth /
  // defaultFraction 会被拒装,请移除)。right 已退役(右侧是右侧边栏的地盘;
  // 旧包声明 right 自动并入 left,用户想放右边可自己拖拽换位)。
  // top/bottom 暂未支持(排期中)
  // panel.systemButtons(可选,仅停靠形态):标准头系统按钮开关,缺省全开、
  // 声明 false 逐个关闭。当前一批:maximize(撑满内容区)、detach(在独立
  // 窗口中打开)、minimize(最小化为浮动气泡)。标题条本体恒由主机绘制、
  // 关不掉;未知键拒装;position:"tab" 时声明本字段拒装
  "settingsHtml": "settings.html",  // 可选:设置页「自定义设置区」自绘界面(见 §4.8;声明了用户填的凭证时仍必填,用于长期管理/替换/清除;调用前缺失时主机也会在统一 Setup 卡内联收单,见 §4.7)
  "settingsHeight": 360             // 可选:固定高度 px(160–800);缺省 = 随内容自适应(矮内容真收矮,高至 800);内容会动态增减时才声明,避免抖动
}
\`\`\`

### 2.1 本地化资源(locales)

插件语言**只跟随 Cindy 宿主当前语言**。不要读取 \`navigator.language\`、操作系统语言或
浏览器偏好，也不要在插件内保存另一份语言选择。宿主当前支持
\`zh-CN / en / ja / ko\`；插件没提供宿主当前语言时固定使用英文，因此只要声明
\`locales\` 就必须提供 \`en\`。

locale JSON 覆盖清单中已有的可本地化字段。**翻译是可选项**：提供的条目必须合法，
未提供的条目在运行时回退原 manifest 文案(通常是英文)；完整翻译(含每个工具参数
的 title / description)是高质量插件的推荐标准，但不是打包/装入门槛。工具按稳定的
tool name 对齐，协议键、工具名和参数名不翻译：

\`\`\`json
{
  "name": "My Plugin",
  "description": "What this plugin does.",
  "whenToUse": "Use it when ...",
  "tools": {
    "do_thing": {
      "description": "Do the task and return the result.",
      "parameters": {
        "/properties/query": {
          "title": "Query",
          "description": "Describe what to search for."
        }
      }
    }
  },
  "panel": { "title": "Plugin panel" },
  "network": {
    "secrets": {
      "api_key": { "label": "API key", "hint": "Create one in account settings." }
    },
    "connections": {
      "instance": { "label": "Service instance", "hint": "Enter the instance URL and token." }
    }
  },
  "node": {
    "secretBindings": {
      "worker_key": { "label": "Worker key", "hint": "Used only by the local worker." }
    }
  },
  "setup": {
    "kv": {
      "default_repo": { "label": "Default repository" }
    }
  }
}
\`\`\`

可翻译字段：\`name\`、\`description\`、\`whenToUse\`、\`tools\`(工具 description 与参数
文案)、\`panel.title\`、\`network.secrets / connections\`、\`node.secretBindings\`、
\`setup\` 的 kv 标签；凭证、连接、Node 凭证和 kv 项按稳定 key 对齐(提供某个 key 的
条目时 label 必填,hint 可选)。工具参数 schema 中已有的 \`title / description\` 用
JSON Pointer 对齐（如 \`/properties/query\`；根节点用空字符串 \`""\`），参数名、类型、
枚举和协议结构不翻译。缺译不拒绝，只回退原文；但**翻译错位仍是硬错误**——未知
key、未知字段、原清单没有的条目、类型或长度不合格、文件缺失、路径大小写与磁盘
不一致、无效 JSON 或单文件超过 64KB 都会在 Forge 打包期、内置播种期与安装期拒绝。
清单列表、详情页、Panel 标题、安装/配置提示和 Agent 工具目录都消费同一份本地化结果。

所有会作为对象索引的稳定标识——tool name、network secrets / connections key、
node secretBindings key、setup kv key——都不能使用 \`__proto__\`、\`constructor\` 或
\`prototype\`；这些名称是宿主保留键，打包时会直接拒绝。

十六个卡槽:\`tool\`(注册工具给 AI)、\`cindy\`(请 Cindy 本体代办:出图/改图/快问快答,
见 §4 与 §4.0.2)、\`agent\`(让
当前 Agent 开始一个普通用户回合,或派活取回结果,见 §4.11 / §4.11.1)、\`panel\`(常驻
面板)、\`card\`(聊天卡片:自绘工具调用的过程与结果,见 §4.5)、\`subscribe\`(旁听会话
事件 + 拦截用户消息,见 §4.6)、\`network\`(访问自带服务的域名白名单 HTTP,主机代发,
见 §4.7)、\`notify\`(弹系统轻提示,主机画壳带你的身份头,见 §4.9)、\`confirm\`(弹主机
同款确认框征求用户同意并拿回真实点击,见 §4.18)、\`fs\`(请主机
代写文件:私有数据目录/会话工作目录/过户目录三档,见 §4.10)、\`node\`(运行随包
Node 工作进程或 stdio MCP,见 §4.12)、\`session-context\`(派活时主机把当前会话的
可信 session_id / workdir / 只读状态注入 args,见 §4.13)、\`pick\`(请主机弹系统选文件夹窗口,
用户亲选即授权,见 §4.14)、\`preview\`(请主机在右侧栏内置浏览器打开白名单网站的
预览标签,见 §4.15)、\`skill\`(捆绑 Agent Skills:随包 SKILL.md 技能,启用后
Claude Code 与 Codex 都能发现,见 §4.16)、\`workspace\`(请主机为项目目录在
侧边栏创建/复用会话入口,见 §4.17)。

**agent 能力详单**:在 \`slots\` 加 \`"agent"\`，默认只允许在用户真实点击你的
聊天卡片后发起一次 Agent 回合；这一档不写配套字段。若确实需要没有当次点击也能
自动发起，额外写 \`"agent": { "background": true }\`。后台档会在装入确认框单独
显示为更高风险权限，而且仍只能使用用户曾通过点击卡片与你建立关联的会话。
要把任务交给 Agent 干并**取回结果**(而不是发进用户的会话),另写
\`"agent": { "errand": true }\`(可与 background 并存),见 §4.11.1;同样是装入
确认框单列的高风险档。

**node 工作进程详单**(声明 node 槽时必写,详见 §4.12):

\`\`\`json
"node": {
  "entry": "node/worker.cjs",          // 包内 CommonJS 入口，只认 .js/.cjs
  "protocol": "json-rpc-stdio",       // json-rpc-stdio / mcp-stdio
  "lifecycle": "on-demand",           // 可选:on-demand(缺省)/resident(常驻,单列高风险权限)
  "idleTimeoutSeconds": 120,           // 可选:按需档空闲关闭时间,30–3600;resident 禁写
  "entries": ["node/build.cjs"],       // 可选 ≤4 条:额外工作进程入口(每入口一个独立进程,调用时用 entry 指名,见 §4.12.1;不能与 entry / 浏览器沙箱 entry / 彼此重复)
  "childSpawn": true,                  // 可选:worker 可请宿主代启申报入口的原样 stdio 子进程(见 §4.12.4;装入确认框单列一行)
  "secretBindings": [{                 // 可选 1–4 条:safeStorage 持久化凭证按方法临时注入 Worker
    "key": "mail_code",                // 插件内唯一,小写字母开头,1–32 位小写/数字/下划线;禁用宿主保留键(见 §2.1)
    "label": "邮箱授权码",             // 安装确认与设置页展示名
    "methods": ["mail/action"],         // 只在这些 JSON-RPC 方法中注入,每条 1–128 位
    "entry": "node/worker.cjs",         // 可选:逐字命中 node.entry/entries;缺省仅主入口
    "hint": "请填写服务商授权码",       // 可选 ≤200 字
    "url": "https://mail.example.com/settings" // 可选 https 申请页
  }]
}
\`\`\`

node 详单**不接受** \`command\` / \`args\` / \`shell\` / \`env\` 或其它自造字段；
入口固定使用 Cindy 随包运行时启动，用户不需要另装 Node、CLI 或 MCP。
**不要在 worker 里用 \`process.execPath\` / \`child_process.fork\` 再生 Node 子进程**
——正式包关闭了 RunAsNode,那样生出来的不是 Node;要多进程就把入口申报进
\`entries\`,由主机代开。

**preview 详单**(声明 preview 槽时必写,详见 §4.15):

\`\`\`json
"preview": {
  "hosts": ["*.example.dev", "localhost"]   // 1–4 条;语法同 network.hosts;能在右侧栏打开的预览网站白名单,装入确认框逐条展示
}
\`\`\`

**skill 详单**(声明 skill 槽时必写,详见 §4.16):

\`\`\`json
"skill": {
  "items": [{                       // 1–4 条
    "dir": "skills/my-skill",       // 包内技能目录,内必须有 SKILL.md
    "name": "my-skill",             // 硬规则:与 SKILL.md frontmatter name 逐字一致;小写字母/数字加单连字符分段(禁首尾/连续连字符),≤64
    "description": "……"             // 硬规则:与 SKILL.md frontmatter description 逐字一致(确认框展示的就是 Agent 读到的),1–1024 字
  }]
}
\`\`\`

**cindy 能力详单**:声明"这个意识被允许点主机代办菜单上的哪些菜"——只有类目和
动作,**没有任何具体模型/供应商信息**(选型权在主机与用户,意识只表达意图)。
类目与动作:\`image\`(\`generate\`=出图 / \`edit\`=改图)、\`video\`(\`generate\`=
文生视频 / \`edit\`=图生视频,参考图怎么用由 \`refMode\` 决定:首尾帧 1–2 张,
或多张参考图,详见 §4 的 cindy-request 视频段)。
详单里没申请的动作,运行时点单直接被拒;声明了 cindy 槽却漏写详单 = 零能力,
别漏。(旧名 model 槽/字段仍兼容,但新意识一律用 cindy。)

**network 详单**(声明了 network 槽时必写,详见 §4.7):

\`\`\`json
"network": {
  "hosts": ["api.example.com", "*.weather.com"],   // 1–8 条;小写域名至少两段;通配只允许最左 "*.";装入确认框逐条展示给用户
  "secrets": [{                                     // 可选 0–4 条:需要用户填的凭证(你只声明名字和注入位置,值用户填、主机保管)
    "key": "api_token",                             // 小写字母开头,小写/数字/下划线,1–32;禁用宿主保留键(见 §2.1)
    "label": "Example API Token",                   // 给用户看的名称(设置页/确认框)
    "source": "user",                               // 可选:凭证值来源。"user"(缺省)=用户可在调用前的主机 Setup 卡内填写,也可在你的 settingsHtml 里长期管理/替换/清除(当前仍要求同时声明 settingsHtml,见 §4.7);"login-email"=主机登录邮箱自动派生(用户不填;声明它时不允许再写 url,见 §4.7);"oauth"=主机托管 OAuth 授权,值 = 授权换来的 access token(必须同时声明 oauth 详单,见 §4.7 与下方 oauth 字段)
    "hint": "在控制台生成后粘贴",                     // 可选提示(主机 Setup 卡与 settingsHtml 都会用到)
    "url": "https://example.com/settings/keys",     // 可选:控制台/申请地址(仅 https)。调用前缺凭证时,主机 Setup 卡会在输入框旁展示本地化的「获取凭证」入口；settingsHtml 也可用 <a href> 逐字引用它,点击经主机转系统浏览器打开(见 §4.8「外链」)
    "inject": {                                     // 必填:这条凭证怎么进请求
      "header": "Authorization",                    // 注入的请求头名(Host/Cookie 等协议关键头禁用)
      "format": "Bearer {value}",                   // 恰含一个 {value} 占位,其余静态文本
      "hosts": ["api.example.com"]                  // 可选:注入范围(hosts 声明条目的子集,逐字);缺省=全部
    },
    "exchange": {                                   // 可选:key 换令牌二段式(服务要求先拿 key 换临时令牌时声明,主机照单代办,见 §4.7;与 oauth 互斥)
      "url": "https://api.example.com/token",       // 交换端点(https;域名必须命中 hosts 白名单)
      "bodyFormat": "{\\"sub\\":\\"{value}\\"}",        // POST 请求体模板,恰含一个 {value}(原始 key 落点,主机按 contentType 转义)
      "contentType": "application/json",            // 可选:application/json(缺省)/ application/x-www-form-urlencoded
      "tokenPath": "session",                       // 令牌在响应 JSON 里的点分路径(如 "data.token";值须是非空字符串)
      "ttlSeconds": 86400                           // 可选:令牌缓存秒数(60–2592000,缺省 3600)
    },
    "oauth": {                                      // source:"oauth" 时必填(其它来源禁写):主机托管 OAuth 授权详单(见 §4.7)
      "authorizeUrl": "https://accounts.example.com/authorize",  // 授权页(https;域名必须命中 hosts 白名单)
      "tokenUrl": "https://accounts.example.com/token",          // code/refresh 交换端点(https;域名必须命中 hosts)。注:个别服务商(如 xAI)的新版 consent 页不再 302 回 loopback,而是页面 JS 跨源投递授权 code——主机允许的投递来源 = authorizeUrl/tokenUrl 的 origin + hosts 白名单命中的 https 域;consent 页与授权端点不同域时,把 consent 域(如 accounts.x.ai)也声明进 hosts 即可
      "clientId": "xxx.apps.example.com",           // 可选:内置 OAuth 客户端 ID(用户零配置开箱即用;用户在设置页自填的覆盖内置,清除自填即回落)
      "clientIdAlternatives": ["xxx-global.apps.example.com"],  // 可选 ≤8 条:仅 tokenBroker 模式;意识按 app-context 选 App 时,connect 只接受默认值或这里声明的公开 ID
      "clientSecret": "xxx",                        // 可选(须与 clientId 成对):内置 client 的 secret;桌面应用的 client 凭证本非机密,纯 PKCE 服务商可省略
      "scopes": ["read.a", "write.b"],              // 可选 ≤32 条:申请的权限范围(确认框逐条展示给用户)
      "scopeDelimiter": ",",                        // 可选:authorize URL 的 scope 拼接分隔符;缺省空格(OAuth 标准),Slack 这类逗号分隔的服务商声明 ","(目前只认这一个值)
      "pkce": true,                                 // 可选:PKCE(S256)开关,缺省 true
      "extraAuthorizeParams": { "access_type": "offline", "prompt": "consent" },  // 可选 ≤8 条:服务商特有授权参数(协议保留参数禁写)
      "identity": { "url": "https://api.example.com/userinfo", "labelPath": "email", "displayTemplate": "{team} · {user}", "avatarPath": "data.avatar_thumb" },  // 可选:授权后拉一次身份端点给账号打标签(设置页"已连接为 xxx";url 域名须命中 hosts)。labelPath 应指向**唯一且稳定**字段(如邮箱 / user_id)——它是重复授权时的同身份合并判定键,选 name 这类可重名可改名字段会误合并。displayTemplate 可选:人类可读展示名模板,\`{点分路径}\` 占位符从同一份身份响应取值(至少一个占位符,≤200 字符),任一占位符取不到值整体降级为空、回落显示 labelPath 的值——labelPath 的稳定字段不可读(如 Slack 的 user_id)时声明它,设置页与账号工具展示的就是渲染后的名字(邮箱这类本身可读的服务商不需要)。avatarPath 可选:头像 URL 在身份响应里的点分路径(如飞书的 "data.avatar_thumb")——主机取 https 地址后**不带凭证**下载小图(仅 png/jpeg/webp/gif、≤256KB)转 data URL 存库,\`/oauth\` 回查里以 account.avatarDataUrl 给你的 settingsHtml 展示(<img> 直接用)。**下载仅对第一方官方意识生效**(头像地址不受 hosts 白名单约束,第三方声明合法但恒降级 null)——所以页面必须能没头像也好看(如回落姓名首字圆片)
      "redirectPort": 53682,                        // 可选:loopback 回调固定端口(1024–65535)。服务商要求回调 URI 与注册值精确匹配(如 Atlassian)时声明,回调恒为 http://127.0.0.1:<端口>/callback;缺省 = 随机端口(Google 等允许任意 loopback 端口的服务商不用声明)
      "tokenBroker": "jira",                        // 可选:仅第一方官方意识可用(第三方声明拒装)。声明后 code/refresh 交换经 Cindy 服务端 broker 完成(client secret 在服务端,不随包分发),与 clientSecret 互斥;设置页不再支持自填 client
      "brokerBounce": { "path": "/example/bounce", "callbackPath": "/example/callback" }  // 可选:双地址弹跳回调(服务商后台只收 https redirect、不收 http loopback 时用)。必须与 tokenBroker、redirectPort 同时声明;报给服务商的 redirect_uri = broker 服务基地址 + path(主机运行时拼,清单不落域名),浏览器授权后由弹跳路由 302 回 http://127.0.0.1:<redirectPort><callbackPath>
    }
  }],
  "connections": [{                                 // 可选 0–2 条:多连接声明——"地址 + 凭证成对多条"(自建实例场景如 GitLab,详见 §4.7「多连接」)。声明了 connections 时 hosts 可缺省/为空(静态域名与动态连接至少有其一);声明 connections 必须同时声明 settingsHtml
    "key": "gitlab",                                // 小写字母开头,小写/数字/下划线,1–32;禁用宿主保留键;与 secrets[].key 共用命名空间,撞名拒装
    "label": "GitLab 实例",                          // 给用户看的连接类型名(1–64 字;确认框与设置页展示)
    "hint": "填实例域名与 Personal Access Token",     // 可选 ≤200 字提示(建议写进你的 settingsHtml 文案)
    "inject": { "header": "Private-Token", "format": "{value}" },  // 凭证注入形态(规则同 secrets 的 inject);**不允许**声明 inject.hosts——凭证恒只注入对应连接自身的地址,写了拒装
    "maxConnections": 4                             // 可选:每种连接可添加的地址数上限(1–8 整数,缺省 8)
  }]
}
\`\`\`

**setup 就绪声明**(可选,顶层字段):回答"这段意识**用之前必须配好什么**"。用户在
插件页点「使用」或 Agent 调用你的工具时,主机按它做前置检查；没配齐就用统一设置卡
引导用户完成配置：普通 user Secret 直接在卡内填写，OAuth 在卡内发起授权，KV 与连接等
复杂配置再进入插件详情页。配齐后继续原调用。检查、字段绑定、保存状态和恢复都在主机
代码里执行,你只声明需求,不用写卡片回调或检查逻辑,也不要在电子脑里自己重复检查。

\`\`\`json
"setup": {
  "requires": [                                     // 0–8 组;组间全部满足(allOf),组内任一满足(anyOf);空数组 = 显式声明"无使用前置需求"(恒就绪,见下)
    { "anyOf": ["secret:brave_api_key", "secret:tavily_api_key"] },   // "两个 key 任一配好即可"
    { "anyOf": [{ "kv": "default_repo", "label": "默认仓库" }] }       // kv 参数用对象形态,label 必填(弹窗展示名)
  ]
}
\`\`\`

- 条目三种引用:\`secret:<key>\`(\`network.secrets\` 或 \`node.secretBindings\` 声明的
  凭证:Node 绑定与 user 源查已保存、oauth 源查已连接账号;账号全过期时主机弹「重新连接」
  话术)、\`connection:<key>\`(该连接声明下至少添加一条)、
  \`{ "kv": "<键名>", "label": "..." }\`(你 /kv 参数里的顶层键非空且不能是宿主保留键;键名主机无先验,
  label 必填)。Node 凭证同样可参与 setup.requires。
- 引用必须逐字指向已声明的 key,悬空引用**打包期就拒**;\`login-email\` 源凭证恒就绪,
  引用它同样拒(没有配置动作可引导)。kv 引用要求已声明 settingsHtml(没有设置页没人填)。
- **绝大多数意识不需要写本字段**:不声明时主机走启发式——声明过凭证/连接的意识,
  任一项配好即算就绪;什么都没声明的恒就绪。只有启发式判不准才需要显式声明,两种
  典型:"必须**同时**配 A 和 B"(多组声明)、"凭证全是**可选项**、一个不配也能用"
  (写 \`"setup": { "requires": [] }\` 显式声明无前置需求,主机不再用启发式拦你)。
- 检查只管**存在性**(配没配),不管有效性(key 对不对)——填错 key 仍会在真正调用时
  由主机网络层报错,你的工具逻辑照常处理失败即可。

## 3. tools:给 AI 看的说明书(最重要的一节)

\`\`\`json
"tools": [{
  "name": "gen_image", // 小写字母开头,1–64 位小写/数字/下划线/连字符;禁用宿主保留键(见 §2.1)
  "description": "根据文字描述生成一张图片,并把它挂进画廊面板。返回可在聊天中渲染的图片地址。",
  "parameters": {
    "type": "object",
    "properties": {
      "prompt": { "type": "string", "description": "图片内容的文字描述(用户原话透传,不要扩写)" }
    },
    "required": ["prompt"]
  }
}]
\`\`\`

措辞套路(实测有效):description 写清"干什么 + 返回什么";参数 description 里直接
写行为规则(如"用户原话透传,不要扩写"、"仅当用户显式说 X 才传 Y")——AI 会照做。
这是你影响 AI 行为的**唯一合法通道**,不要试图在别处塞指令。

## 3.5 工具面设计:直接声明,还是两段式目录

工具怎么摆有两种形态,按"数量 × 粒度"选,选错会拖累所有会话:

**直接声明(默认,绝大多数意识用这个)**:每个工具在 tools 里逐条声明(§3 的写法)。
适用:工具是"意图级"的——一个工具对应用户会说的一句话(如"生成音乐"、"部署站点"),
数量一只手到一打(主机硬上限 16 项,超了直接拒装)。收益全在明处:AI 靠 description
自然语言触发命中率最高;装入弹窗把每个工具如实列给用户;工具名不存在主机直接拦。

**两段式目录(大工具面专用)**:要包的能力是"端点级"的几十上百个操作(典型:给一个
大 API 面做接入,操作粒度是 list_xxx / get_xxx / create_xxx)时,**别把它们全塞进
tools**——所有意识的工具清单会一起被你一家撑爆,别的意识也跟着遭殃。改为只声明两个
元工具,目录和分发表放进 main.js 自己维护:

\`\`\`json
"tools": [{
  "name": "list_tools",
  "description": "列出本意识可用的操作。不传 category 返回类目概览(类目名+数量);传 category 返回该类目下所有操作的名称与说明。",
  "parameters": { "type": "object", "properties": { "category": { "type": "string", "description": "类目名,来自概览" } } }
}, {
  "name": "call_tool",
  "description": "执行一个具体操作。name 来自 list_tools 的返回;args 按该操作的参数说明传 JSON 对象。",
  "parameters": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "操作名" },
      "args": { "type": "object", "description": "操作参数,不确定时可传 {} 触发错误反馈拿 schema" }
    },
    "required": ["name"]
  }
}]
\`\`\`

两段式必须守的约定(AI 跨意识零学习成本,靠的就是这套一致性):

- 元工具名固定叫 \`list_tools\` / \`call_tool\`,不要自创同义词;
- \`list_tools\` 支持类目下钻:不传 category 给概览,传了给明细——目录大时别一次全量倒出;
- \`call_tool\` 收到不认识的 name 或不合法的 args,失败交卷的 message 里**附上该操作正确的
  参数 schema**——AI 会照着自纠重试,比干巴巴报错省一轮追问;
- 权限透明的代价自己补:装入弹窗只会逐条列出 list_tools / call_tool 两个元工具,用户
  看不出背后有多少操作。把能力范围如实写进 ghost.json 的 description(花名册自述),
  别让用户装完才发现。

分界线的手感:一打以内、意图级 → 直接声明;几十以上、端点级 → 两段式。两段式首次
使用多一跳(先翻目录),目录进上下文后,同一会话的后续调用与直接声明无异。

## 4. main.js 电子脑(沙箱后台逻辑)

跑在无网络、无文件、无 Node 的独立沙箱页里,只有一个全局 \`cindy\`:

\`\`\`js
// 收活:AI 调你的工具时收到 tool-call
cindy.onHostMessage(function (msg) {
  if (msg.type !== 'tool-call') return;
  // msg.tool = 工具名, msg.args = AI 填的参数, msg.callId = 卷号
  // msg.args.attachments(可能出现):用户随消息发给你的图,已由主机过户
  // 到你名下的**指纹数组**——与你自己生成的媒体同等待遇(可当改图源图、
  // 可经 cindy-ghost://<id>/media/<指纹> 上墙)。工具要吃用户图就读它。
});

// 交卷(默认 330 秒内,超时作废;够覆盖一单大文件上传/取件。长任务可续命,
// 见下方"长任务续命"):
cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: {
  xdt_image_urls: ["cindy-media://…"],  // 顶层带这个字段 → 聊天气泡直接渲染图卡
  // xdt_video_urls 同理渲染视频卡。音频用 xdt_audio_tracks(对象数组,逐轨):
  // xdt_audio_tracks: [{ xdt_audio_url: 'cindy-media://….mp3',   // 必填,缺了整轨被丢
  //   kind: 'music',            // 'music'(完整卡:封面/tags/歌词/进度条)| 'sound_effect'(精简卡)
  //   title: '歌名', cover_url: 'cindy-media://….jpg', tags: '风格描述',
  //   lyrics: '歌词', duration_seconds: 176, suno_id: '…' }]      // 除 url 外全可选
  // → 聊天气泡渲染成音频播放器卡。声明了 card 槽的意识也可把播放器直接画进
  // 自己的卡(§4.5 data-ghost-audio 插槽),那时结果多带 xdt_audio_in_card: true
  // + xdt_anchor_card_id(主机验证卡里真含插槽才压基座的重复播放器;
  // xdt_audio_tracks 仍要发——手机端靠它)。
  // 3D 产物(GLB 已入媒体库)可另带
  // _xdt_model_files: [{ provider: 'cindy', url: 'cindy-media://….glb', format: 'GLB' }]
  // ——与 xdt_image_urls 按位配对,用户点对应预览图直接进应用内 3D 查看器。
  //
  // ⚠️ 媒体字段是**数据通道**,不只是桌面渲染指令:IM/远程会话(Slack/飞书)的
  // 出站与手机端都靠这些字段把你的产物送到用户手里。**任何情况下都不要删掉/
  // 省略它们**——包括你把图画进了自己的卡片时(那会让 IM 用户永远收不到图)。
  // 画卡去重用令牌:图入卡带 xdt_images_in_card: true(音频对应
  // xdt_audio_in_card),桌面验证锚卡真含对应媒体后才跳过基座渲染,IM/手机
  // 不受影响。另:主机会对"署名调用"(cindy-request / fetch 带 callId)期间
  // 入库的媒体独立记账,你没声明媒体字段时以 xdt_media_produced 兜底注入
  // ——但那是安全网,别依赖它,正路是老实声明字段。
  // 内联意图令牌(读取类意识用):结果顶层带 xdt_media_inline: true = 这些
  // 媒体是"从文档/消息里读出来的素材",桌面呈现应由主 agent 在最终回复里
  // markdown 内联(![](cindy-media://…)),主机不画卡、也不注"别嵌 markdown"
  // 禁令;IM/远程出站仍按账本自动送图。仅在你**没有**声明 xdt_image_urls 等
  // 复数媒体字段时有意义——声明了媒体字段一律走卡片语义,别两个都带。
  // 生成类意识(画图/做视频)不要用它:生成产物走卡片语义体验才对。
  note: "干完了"
}});
// 失败交卷：errorCode 是可选的插件业务错误码；主机保留码
// (GHOST_NOT_FOUND / GHOST_ASLEEP / GHOST_CRASHED / TIMEOUT / INTERNAL 等)不可由插件写入。
// message 必须包含用户可执行的恢复指引；不要把失败对象 JSON.stringify 到 message。
cindy.send({
  type: 'tool-result',
  callId: msg.callId,
  ok: false,
  errorCode: 'CONFIRM_REQUIRED',
  message: '删除需要确认，请传 confirm:true 后重试',
});

// 长任务续命(超时窗口默认 330s,从派发起算绝对上限 30 分钟):
// - 经 cindy-request 请主机代办且带 callId 的署名单(出图/视频)在途时,
//   主机**自动**替这份卷续命,你不用做任何事;
// - 自己经 network 槽轮询外部长任务时,期间定期(建议 ≤60s 一次)发心跳:
//   cindy.send({ type: 'tool-progress', callId: msg.callId });
//   每次心跳把窗口重新续满一个 330s 档;callId 不是派给你的会被静默丢弃。
// - 预计超过 30 分钟天花板的超长任务,不要吊着一次 tool-call 等:视频代办用
//   mode:'submit' 异步提交(见下),自己的外部任务拆成"提交 + 查询"两个工具。

// Cindy 代办(需声明 cindy 槽 + 能力详单;主机出图、落仓、记账,你只拿到指纹字符串):
// 由 tool-call 触发的代办**务必带上收到的 callId**(归因号:让用户在日志/账单里
// 对上"哪次调用花的钱");面板交互等自发代办可不带。
const r = await cindy.send({ type: 'cindy-request', kind: 'gen_image', prompt: '一只猫', callId: msg.callId });
// r = { ok: true, url: 'cindy-media://blobs/<指纹>.png', hash: '<指纹>', ext: '.png',
//       model: 'gpt-image-2', modelLabel: 'GPT Image 2', width: 1024, height: 1536 }
//     model/modelLabel = 主机实际执行的选型(权威信息)——建议把 modelLabel 写进
//     交卷 note,让用户看得见"这单是谁画的"。
//     width/height = 图片真实像素宽高(仅图片代办;主机解析不出时缺省)——供
//     聊天卡片时用它按比例精确声明卡高(见 §4.5),别拿去写进交卷文案。
// 图像可选画幅 aspectRatio:'1:1' 方图 / '3:2' 横图 / '2:3' 竖图,不传 = 后端自定:
//   { kind: 'gen_image', prompt: '一只猫', aspectRatio: '3:2' }
//   比例是意图声明(同 tier 哲学),主机翻译成该模型支持的具体尺寸,真实像素
//   以返回的 width/height 为准。**图像类专用**(gen_image 与 edit_image 都收;
//   改图不传 = 跟随源图画幅);视频画幅是另一个参数 ratio,值域不同,带错会被拒。
//   用户没提横竖要求时别自作主张,不传让后端自定。
// 改图(需详单含 "edit";源图必须是本意识名下的,1–4 张——含用户过户给你的
// args.attachments 指纹):
//   { kind: 'edit_image', prompt, hashes: ['<指纹>'] }
//   { kind: 'edit_image', prompt, hashes: ['<指纹>'], aspectRatio: '1:1' }  // 换画幅重绘
// 视频(需详单 video 类目;分钟级长任务,返回形态同上,url 是 .mp4。同步等待
// 期间主机自动替你的 tool-call 续命,分钟级任务放心 await):
//   { kind: 'gen_video', prompt }                       // 文生视频
//   { kind: 'edit_video', prompt, hashes: ['<指纹>'] }  // 参考图生视频
// 参考图怎么用:edit_video 的 refMode(可选,不传 = 'first_and_last_frame')
//   'first_and_last_frame'(缺省):1 张 = 拿它当首帧动起来,2 张 = 首尾帧
//     过渡(第 1 张是首、第 2 张是尾)。**hashes 顺序即首尾顺序。**
//   'reference_image':多张参考图锁主体/服装/场景/风格,模型据此另行构图
//     (不是拿某张当首帧)。张数上限随型号(最多 9 张),超了会被明拒并告诉
//     你该型号的上限。这个模式另有一道**总字节闸**:一单参考图加起来不超过
//     100MB(张数没超也可能撞这条),超了同样明拒,换小图或减张数即可
//     ——首尾帧模式没有这道闸。
//     ⚠️ 用这个模式时,**提示词里必须用 [Image 1]、[Image 2] 指明每张图各自
//        的用途**,顺序与 hashes 一一对应——不指明的话模型不知道你给的图是
//        干嘛的,等于白传还照样计费。主机不会替你改写提示词。
//     例:{ kind: 'edit_video', refMode: 'reference_image',
//          hashes: [h1, h2],
//          prompt: '[Image 1] 里的女孩戴着 [Image 2] 的耳环,在雪地里回头微笑' }
//   型号不支持你要的用法时直接明拒(不会偷偷换成另一种用法出片),拒绝话术
//   里带该型号支持的用法,按提示改。
//   注意别和下面异步模式的 mode 搞混:refMode 管"图怎么用",mode 管"同步还是
//   后台跑",两者正交,可以同时传。
// 视频画面参数(四项全可选,不传 = 该型号出厂默认,这也是最省心的用法):
//   ratio:'16:9' | '9:16' | '1:1' | '4:3' | '3:4'(视频专用,别和图像的
//     aspectRatio 混用)
//   resolution:'480p' | '720p' | '1080p'
//   duration:秒(整数)。**各型号支持集不同**——传了不支持的值会被明拒,
//     拒绝话术里带该型号的可用值,按提示改或者干脆不传。
//   fps:帧率(整数),同样按型号校验。
//   例:{ kind: 'gen_video', prompt: '猫在奔跑', ratio: '9:16', resolution: '1080p' }
//   ⚠️ 高分辨率 + 长时长明显更贵也更慢:用户没提要求时不要自作主张调高,
//      不传让型号自己定。
// 要不要出声 audio(可选布尔,**三态,不传与传 false 不是一回事**):
//   不传(缺省,**推荐**):随该型号自己的默认。有的型号原生音画同生,不传
//     出来就是有声的;有的型号压根不出声。不传永远不会因这项被拒。
//   true:显式要音轨。**台词/音效/配乐的内容写在 prompt 里**——台词用双引号
//     括起来(如 男人说:"你好"),音效和配乐直接描述(如 脚步踩在雪地上咯吱作响、
//     背景音乐是轻快的吉他)。主机不替你改写提示词,你不写就只能靠模型自由发挥。
//   false:显式要静音。
//   型号没有音频开关时,**显式传**这项会被明拒(不会静默忽略),拒绝话术会
//     告诉你不传即按该型号默认出片;不传就不会撞这条。
//   例:{ kind: 'gen_video', prompt: '雪地里有人走过,脚步声咯吱作响', audio: true }
//   ⚠️ 用户没提声音需求时就别传:传 true 不会凭空变好,传 false 反而可能把
//      本来有声的型号弄成默片。
//   成功返回多带一个 videoParams: { durationSeconds, resolution, ratio, fps, audio? }
//   = 本单**实际生效**的参数(主机权威)。老宿主会静默忽略这几项,拿 videoParams
//   跟你传的值对一下就知道兑现没有;要在交卷 note 里报参数,以它为准别报你传的。
//   \`audio\` 缺席 = 主机说不上来(型号没这个旋钮,或老宿主不认识这个字段),
//   **别把缺席读成"无声"**;要跟用户说有没有声音,只有它明确是 true/false 时才说。
// 视频异步模式(可能超过 30 分钟续命天花板,或不想吊着 tool-call 等时):
//   加 mode:'submit' → 受理后立即返回 { ok:true, jobId, status:'running',
//   expectedSeconds }(资格审/源图归属仍同步校验,拒绝立即可见),生成在
//   后台继续;用 { kind:'query_job', jobId } 轮询:进行中 { ok:true,
//   status:'running', elapsedSeconds },完成 { ok:true, status:'done', url,
//   hash, ext, model, modelLabel }(取件字段与同步返回同形),失败
//   { ok:false, message }。完成结果保留 30 分钟(每意识最多缓存 16 单完成
//   记录,超出淘汰最旧),过期或应用重启后查无此单(按可重新提交处理);
//   后台在途上限 2 单。建议把插件工具拆成"提交生成 + 查询结果"两个,
//   让 AI 自己掌握轮询节奏。
// 选型两个可选参数,规则:
//   tier:'draft'(快省草稿)| 'standard'(默认)| 'best'(最好)——只表达档位
//     意图,具体用哪个模型由主机决定。这是你唯一该主动用的选型参数。
//   model:仅当**用户在会话里显式点名**某模型(如"用 nano banana")时,把
//     用户点的名字原样透传;白名单外会被拒。**不要**自己替用户选模型——
//     具体型号是主机资产,写死在意识里必腐烂。
// 主机模型目录暂时不可用时(返回 ok:false 且 message 含"模型目录暂时取不到"):
//   这是主机侧临时状态,不代表本意识缺这项能力——**不要频繁重试**,
//   如实告诉用户"当前模型不可用,稍后再试或重启应用",然后结束本次操作。
\`\`\`

### 4.0.1 寄存:让"用户自己的图"也能被 AI 改(deposit_media)

改图/图生视频的 \`hashes\` **只认本意识名下的媒体**。主机生成的图天然在册,
但用户在你面板里**粘贴、拖入**的图,以及面板里早就存着的存量素材,字节只在
面板侧(IndexedDB / 你自己的存档),总仓里没有账——所以在寄存之前,它们不能
当源图。这就是"同一块画布上有的图能改、有的不能"的由来。

寄存把这些字节存进总仓、记到你名下,换回指纹;从此它与你生成的图**同权**。

\`\`\`js
// 需声明:"slots": [..., "cindy"], "cindy": { "media": ["deposit"] }
const r = await cindy.send({
  type: 'cindy-request',
  kind: 'deposit_media',
  data: base64,                  // 媒体字节的 base64,不含 data: 前缀
  label: '用户拖入的参考图',      // 可选,仅供主机侧账目与排查
  callId: msg.callId,            // 可选,仅日志归因
});
// r = { ok:true, url:'cindy-media://blobs/<指纹><后缀>', hash, ext, bytes,
//       deduplicated, quotaUsedBytes, quotaLimitBytes }
// 拿到 hash 就能直接当源图:
await cindy.send({ type:'cindy-request', kind:'edit_image', prompt:'背景换成雪山', hashes:[r.hash] });

// 面板上那件素材被用户删掉时撤回,释放配额(同一能力键,不用另外声明):
await cindy.send({ type: 'cindy-request', kind: 'release_media', hash: r.hash });
// → { ok:true, released, quotaUsedBytes, quotaLimitBytes }
//   released:false = 本就没有这条寄存引用(幂等,不是错误)。
\`\`\`

规矩(都会被主机强制,不是建议):

- **类型按字节判**:主机读魔数,只收图片 / 视频 / 音频 / glb。你自报的 mime 或
  文件名一概不参考,识别不出直接拒——别拿 svg、zip、json 来试;
- **单次 ≤50MB**(解码后字节)。字节要以 base64 走一次 IPC,再大请自己在面板侧
  压缩或分片,别指望上限继续抬;
- **每意识配额 1GB**,只算寄存物(你生成的图不占这个额)。同一张图反复寄存
  不重复占额(内容寻址天然去重)。**满了就拒**——不会静默淘汰旧的,因为
  "昨天能改今天改不了"是比"存不进去"更糟的体验。用 \`release_media\` 释放;
  返回里的 \`quotaUsedBytes\` / \`quotaLimitBytes\` 可用来提前提示用户;
- **频控**:允许 8 张突发,之后约每秒 1 张。批量粘贴不受影响,死循环会被拦;
- **寄存物不是产物**:它不会被当成生成结果自动送进聊天或 IM(用户自己粘的
  参考图被回推出去会是隐私事故),也不进 \`/gallery\` 作品清单。要给用户看,
  自己在面板里用 \`cindy-ghost://<id>/media/<指纹><后缀>\` 渲染,或做成卡片;
- **生命周期**:寄存物跨会话持久(删会话不陪葬),用户卸载你的插件时一并清理。

用户装你的插件时,确认框会单独出现一行「可将它手中的图片、视频或音频存入你的
媒体库」并写明上限——这是唯一一条"不花钱就能写用户媒体库"的能力,所以要用户
单独点头。别为了省事把它当默认能力申请:不做面板素材加工的插件不要声明。

### 4.0.2 快问快答:向 Cindy 的快速通道要一段文字(oneshot_text)

需要"问一句、拿一段文字答案"(总结、分类、改写、抽取)而不需要 Agent 动用
任何工具时,不要发起 Agent 回合——用快问快答,几秒到几十秒出结果,便宜得多:

\`\`\`js
// 需声明:"slots": [..., "cindy"], "cindy": { "text": ["oneshot"] }
const r = await cindy.send({
  type: 'cindy-request',
  kind: 'oneshot_text',
  prompt: '把下面的反馈按情绪分成 正面/负面/中性,只回类别词:\\n' + feedback,
  // expectJson: true,     // 可选:要求只输出 JSON,主机校验可解析
  // maxTokens: 256,       // 可选:回答预算(1–4096,缺省 1024)
  callId: msg.callId,      // tool-call 触发时务必带上(归因)
});
// 成功:{ ok:true, text:'…', model:'…' }(model = 实际应答的通道/型号,仅诊断)
// 失败:{ ok:false, message, errorCode }
\`\`\`

规矩与边界:

- 它走主机的**轻量任务模型链**(用户在设置里配置的快速通道,与会话自动起
  标题同一条),不拉起 Agent、没有工具、碰不到用户文件、不进任何会话——
  要"干活"(读文件、查资料、多步操作)请用派活(§4.11.1);
- 选型不在你手里,也没有 tier/model 参数:链由用户配置,主机逐候选兜底;
- \`errorCode:'NO_CANDIDATE'\` = 用户当前没有可用的快速通道(未配置或凭证
  不可用)。**这是正常失败面**:如实提示用户,不要重试轰炸;
- \`expectJson: true\` 时主机会剥掉代码围栏并校验 JSON.parse,解析失败返回
  \`errorCode:'BAD_MODEL_OUTPUT'\`(message 带原始输出开头供排查)。字段结构
  在 prompt 里自己描述,主机不做逐字段 schema 校验;
- prompt ≤32768 字符;同步返回,没有异步单;每插件在途上限与媒体代办共用
  (用户可配);装入确认框会单列一行「可向 Cindy 的快速通道提问」。

## 4.1 宿主公开上下文(request,无需卡槽)

电子脑需要按宿主构建身份或当前语言选择公开配置/界面文案时,走只读 request。当前只暴露
\`region: 'cn' | 'global'\` 与 \`locale: 'zh-CN' | 'en' | 'ja' | 'ko'\`,
不含登录态、路径、设备信息或凭证:

\`\`\`js
const r = await cindy.request({ kind: 'app-context' });
// → { ok:true, context:{ region:'cn'|'global', locale:'zh-CN'|'en'|'ja'|'ko' } }
\`\`\`

\`settingsHtml\` / panel 没有 preload 桥,读取同一份上下文走同源只读端点:

\`\`\`js
const r = await (await fetch('/app-context')).json();
const region = r.context.region;
const locale = r.context.locale;
\`\`\`

region 只适合选择**已在 manifest 声明过**的公开配置。例如 broker OAuth
可在 \`clientIdAlternatives\` 列出备用 ID,再由 settingsHtml 把选中的
\`clientId\` 放进 \`/oauth/<key>/connect\` body;主机会做清单白名单复验。
不要用 region 推断用户位置、语言或数据归属。

\`locale\` 是插件语言的唯一事实来源。设置页、panel 和电子脑都只使用它；
不要读取 \`navigator.language\`。宿主切换语言时，运行中的电子脑会收到
\`{ type:'host-context-changed', ok:true, context:{ region, locale } }\`，可用
\`BroadcastChannel\` 通知同插件的设置页/panel 重新读取 \`/app-context\` 并换文案。
未运行的插件会在下次启动或页面重新装载时直接读到新语言。插件自身不支持该 locale 时
必须选英文资源。

## 4.5 聊天卡片(card 槽,海报模式)

声明 \`"slots": [..., "card"]\` 即可,无配套清单字段。作用:你的工具调用在聊天流里
不再渲染成通用图卡,而是你自己排版的卡片(过程 + 结果都归你画)。不发供片 =
聊天照旧渲染默认卡,卡片是**每次调用的可选项**。

\`\`\`js
cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'tool-call') return;
  // ① 收到活立刻供第一版过程卡(卡片这一刻才出现在聊天里;不供 = 没有过程态):
  cindy.send({ type: 'card-update', callId: msg.callId,
               html: '<div style="padding:12px">正在起草…</div>', height: 160 });
  // ② 干活;执行中可整版换海报(同一 callId 重发,主机限速 ≥1s/版,超发静默丢):
  const r = await cindy.send({ type: 'cindy-request', kind: 'gen_image', prompt: msg.args.prompt, callId: msg.callId });
  // ③ 交卷**前**发最终版(交卷后 10 秒宽限,过期拒收):
  cindy.send({ type: 'card-update', callId: msg.callId,
               html: '<figure style="margin:0"><img src="' + r.url + '" style="width:100%;border-radius:8px"><figcaption>' + msg.args.prompt + '</figcaption></figure>',
               height: 340 });
  // ④ 交卷(result 必须是 JSON 对象,否则卡片配不上对):
  cindy.send({ type: 'tool-result', callId: msg.callId, ok: true, result: { note: '完成' } });
});
\`\`\`

硬规则(主机代码强制,写了也没用的别写):
- **纯 HTML+CSS,零脚本**:\`<script>\`/事件属性/iframe/svg 等一律被主机
  净化器剥除或连内容丢弃;可用标签为 div/span/p/h1-h4/ul/ol/li/img/figure/table/
  pre/code/style/a 等排版件;
- **动画可以写,但只许动 transform / opacity**(\`@keyframes\` 体内出现其它属性 =
  整卡动画作废,回退主机统一扫光)。动画只在该次调用 running 期间生效——
  交卷后主机自动换成剥掉动画的静态版,历史卡永远静止,你不用(也无法)
  自己收动画。适合做进度态的摆动/呼吸/扫掠;\`transition\` 不受此限;
  另外两条同样触发"动画作废回退扫光":CSS 里写 \`!important\`、keyframes
  里(名字或体内)出现引号;CSS 用反斜杠转义(\`\\61\` 这类 ident 转义)则
  更重——该段样式整段拒收,静态版同罚。用户系统开了「减弱动效」时你的
  动画会被主机强制停播——属预期,别当 bug 修;
- **图片只认你名下的 \`cindy-media://blobs/<指纹>.<后缀>\`**(cindy-request 返回的
  url 直接用;别人的图/外链/data: 一律被剥)。CSS 里的 \`url()\` 同规则;
- **可放交互按钮**(交互卡 v2):卡里可写 \`<button data-ghost-action="<动作id>">U1</button>\`
  (\`data-ghost-action\` 也可挂在 div/span/img 上,把整块当按钮)。用户点击时主机受信桥把
  \`{type:'event', name:'card-action', callId, actionId, sessionId, userActionToken}\` 回传你的电子脑(见下方 onHostMessage
  分支),你据此干活(如调你自己的工具)再 \`card-update\` 换新卡。**仍零脚本**——按钮只是
  声明,点击链路由主机独占,你写不了 onclick、也伪造不了点击。动作 id 限
  \`[A-Za-z0-9_:-]\` ≤128 字符(含 \`:\`,可直接用第三方 customId);不合法的值主机只丢该属性
  (按钮还在但点不动)。发交互卡时把 \`card-update\` 的 \`v\` 标 \`2\`(可选,声明意图);
- **需要用户输入文字的动作**(如"按提示词改写这张图"):按钮上再加
  \`data-ghost-prompt="占位文案"\`(≤128 字,可空串)。用户点击时主机弹标准输入框
  收集文字(textarea,回车发送/Esc 取消),card-action 事件多带 \`prompt\` 字段
  (≤2000 字)——你不用也画不了卡内输入框,输入交互由主机代管;
- **可放外部链接**(外链 v3,经宿主确认):写 \`<a href="https://…">官网</a>\`,或在
  任意可用标签上挂 \`data-ghost-link="https://…"\`(整块可点)。仅收**整串**
  http/https URL(≤2048 字,不合法只丢属性——文字保留、点不动)。用户点击时主机
  先弹确认框亮出真实域名与完整链接,用户确认才在系统浏览器打开——跳转链路由
  主机独占,href 不会真的落进卡片(主机转写成声明属性),你写不了跳转、也
  骗不了确认框上显示的去向。与 \`data-ghost-action\` 同挂时动作优先、链接被忽略,
  一个元素只有一种点击行为;别拿链接文案冒充按钮语义,去向和文案不符只会让
  用户在确认框里看穿;
- 不带 \`data-ghost-action\` 的图片仍是"点开看大图":用户点卡内图片主机自动弹 lightbox
  (大图/标注/另存),零代码;复杂交互(多字段表单等)仍去你的面板做;
- **3D 预览图**:img 再加 \`data-ghost-model="cindy-media://blobs/<指纹>.glb"\`(你名下
  已落库的 GLB 地址,整串精确匹配才生效),用户点击该图 = 应用内 3D 查看器直接加载
  这个模型(可旋转/缩放),不再是普通看大图。适合"3D 生成完成卡":预览 + 模型一次
  到位,结果里就别再重复下发预览图;不合法的值只丢属性(图退化为看大图);
- **卡内音频播放器**:\`<div data-ghost-audio="cindy-media://blobs/<指纹>.mp3">\`
  (仅挂 div;mp3/wav/m4a,你名下已落库的地址,整串精确匹配)。主机会**清空该
  div 的子树**、注入与基座音频卡同款的标准播放器行(播放/暂停 + 进度 scrub +
  时间,28px 高,自动跟主题)——你只声明"这里放一个播放器",播放行为全归主机,
  卡内仍零脚本。可选 \`data-ghost-audio-duration="176"\`(秒)让时长在元数据加载前
  就显示。封面/标题/tags 等排版归你,围着插槽自己画;插槽只出播放器行,给它留
  ≥28px 高。**同一音频画进了卡,交卷 result 里带 \`xdt_audio_in_card: true\` +
  \`xdt_anchor_card_id: <画播放器那张卡的 callId>\`**——令牌是"待验证声明":主机
  锚到你那张卡、确认 html 里真含对应插槽后,才压掉基座按 \`xdt_audio_tracks\`
  画的重复播放器;验证不过(卡被拒/该端看不到卡)自动回退基座渲染,音频不会
  消失。不带令牌 = 基座照画,同一首歌出现两个播放器。手机端(无卡片体系)永远
  按 \`xdt_audio_tracks\` 渲染,该字段照常要发。不合法的值只丢属性(div 与子树
  保留);
- 体积 ≤32KB/版;height 是**初始估计值**(120–900,缺省 240)——文档与图片
  加载后主机会按实际内容高度自动收敛并记住(同一夹取区间,历史回放零动画),
  所以图片按自然比例放即可,**不要固定高度 + object-fit:cover 裁切作品**;
  推荐通栏出血写法 \`width:100%;height:auto\`(宽度撑满卡片,文字区自己
  加内边距);卡片宽约 460px(画布内宽 458)、高度上限 900px,**单主体大图
  优先,别在卡内摆多图对比**(缩小了看不清,对比类展示放面板);
- **height 尽量报准**:估计值和真实内容差得越多,用户第一眼看到的收敛跳动
  越明显。放单张大图时用 cindy-request 返回的 width/height 按比例算:
  \`height: Math.round(458 * r.height / r.width) + 文字区高度\`——首帧即
  最终高度,零跳动;
- **主题(可选)**:主机在卡片头部注了一段和面板同名的 CSS 变量,想跟主机
  换肤就用 \`var(--surface, #f7f7f5)\`、\`var(--text-primary, #1a1a1a)\`、
  \`var(--border-default, #e4e4e0)\` 这类语义色并**务必带回退值**(白名单同
  §5 面板那组);不想跟就照常写死颜色——写死的卡不引用这些 var,完全
  不受影响。用户切主题时主机重建卡片让 var 生效,你无需处理;
- 卡片上方主机画一枚小 chip(你的头像 + 名字 + 运行/完成状态点;可点开看本次
  调用参数),你画不了也冒充不了——它是"这块内容由某意识渲染"的信任签名;chip
  以下整块画布归你,主机不再叠边框/底色/内边距;
- **不铺底色 = 真透明**(全出血海报的推荐姿势):主机不叠底色,同时在上面那段注入块
  里声明了 \`color-scheme: light|dark\`(跟宿主主题实时切),卡片画布因此在两种模式下
  都是透明的、直接透出聊天背景。所以图片顶满卡片、四边不留边是安全的,**不需要**
  为了"避免白底"去自己铺一层 \`--msg-tool-card-bg\`;反过来,别自己写死
  \`color-scheme\`,那会让卡内原生控件在另一种模式下反档;
- 供卡的调用,聊天不再渲染 \`xdt_image_urls\` 的通用图卡(被你的卡替换);其它
  工具/其它调用不受影响。**但 \`xdt_image_urls\` 本身仍必须照发**(数据通道,
  IM/远程会话出站与手机端靠它),图画进卡时结果带 \`xdt_images_in_card: true\`
  即可(与 \`xdt_audio_in_card\` 同款令牌,桌面据此去重,删字段=IM 丢图);
  **跨调用画卡**(如轮询流画回首轮卡位)还需同时回锚 \`xdt_anchor_card_id\`
  = 持卡调用的 callId,桌面凭锚取卡验证含图后才压基座,锚不上会双渲染。

**交互卡的 card-action 处理**(声明了 card 槽即可收;点击触发你的动作、会花配额):

\`\`\`js
cindy.onHostMessage(async function (msg) {
  // 用户点了你卡上的 data-ghost-action 按钮:
  if (msg.type === 'event' && msg.name === 'card-action') {
    // msg.callId = 被点那张卡的归因号(和当初 tool-call 同值);
    // msg.actionId = 你在 data-ghost-action 里写的动作 id;
    // msg.prompt = 用户输入的文字(仅 data-ghost-prompt 类按钮有,非空才带);
    // msg.spawnCallId = 主机铸的**衍生卡位**:画到它 = 原卡下方长出新卡。
    // 声明 agent 槽后还会收到 msg.sessionId 与 msg.userActionToken；后者是
    // 绑定本插件+本会话、两分钟有效且只能使用一次的 Agent 通行票(见 §4.11)。
    cindy.send({ type: 'card-update', callId: msg.spawnCallId, v: 2, state: 'working', // 过程态:会话侧栏保持运行呼吸
                 html: '<div style="padding:12px">⏳ 生成中…</div>', height: 110 });
    const r = await doSomething(msg.actionId, msg.prompt);     // 干活(可调你自己的工具/network 槽)
    cindy.send({ type: 'card-update', callId: msg.spawnCallId, v: 2, state: 'done', // 终版:熄灭呼吸
                 html: renderCard(r), height: 340 });
    return;
  }
  if (msg.type === 'tool-call') { /* …见上… */ }
});
\`\`\`

**新结果画哪张卡**:推荐一律画到 \`msg.spawnCallId\`(衍生卡位)——原卡(图 + 按钮)
原封不动、新卡堆叠长在它下方,用户可以回到原卡反复点不同按钮(MJ 抽卡式玩法);
衍生卡上的按钮再被点,主机会铸下一个衍生卡位,全部平铺挂在最初那张卡下。仍对
\`msg.callId\` card-update = 原地换卡(覆盖原卡,适合"状态刷新"类动作)。

收到 card-action 后你有充足时间干活再换卡:主机在派发点击时会自动重开相关卡的更新
窗口(即使卡片结算很久、你已沉睡、甚至重启后被点),你随后 \`card-update\` 不会被判
"太晚"。动作耗时的话可以先往 \`spawnCallId\` 发一张过程态卡(如"⏳ 生成中"),拿到
结果再发终版卡——两版之间隔 ≥1s(主机限速)。点击是真实用户手势、由主机独占触发,你
声明了 action id 但既伪造不了点击、也自动触发不了(卡里跑不了脚本)。

**活动状态声明(\`state\`,后台/长时生成强烈建议带)**:
- \`state: 'working'\` = 过程态卡。三重效果:①会话侧栏的运行呼吸保持点亮(每版续命,
  静默约 3 分钟自动熄灭兜底);②卡片自绘动画持续播放(不再随调用交卷停播);
  ③**该卡位的更新窗口跨调用保持打开**(自首个 working 版本起封顶 30 分钟,固定
  不滑动)——后续任何调用里都可以继续对同一 callId 供片刷进度;
- \`state: 'done'\` = 终版卡(成功/失败/引导文案都算):呼吸熄灭、动画停播、跨调用
  窗口关闭(回到"交卷后 10 秒宽限"旧语义)。
- 不带 state = 旧语义。非法值(working/done 之外)整条卡被拒。

**生成类意识的推荐模式(媒体资产生成必读)**:结果能画进卡的(图片,以及音频
——用上面的 \`data-ghost-audio\` 插槽,完成卡直接长播放器,别忘了交卷带
\`xdt_audio_in_card: true\` + 回锚),过程卡与终版卡都发在任务的常驻卡位上即可。结果画
不进卡的(视频——卡里放不了视频播放器;供卡会顶掉该次调用的默认媒体渲染,
千万别把卡发在交结果的那次调用上),用"**常驻过程卡**"模式:提交调用立刻发
\`state:'working'\` 过程卡(卡钉在提交调用的卡位),后续轮询调用跨卡位对它刷进度
(仍 working),拿到终态后对它发 \`state:'done'\` 的完成卡(如"✅ 已生成,内容在
下方")——真正的播放器由**没供过卡的轮询调用**按基座默认渲染(视频带
\`xdt_video_urls\`,见 §4 交卷字段),卡与播放器各归其位。

**媒体回锚(常驻过程卡模式必带)**:轮询调用交出媒体时,在 result 里同时带
\`xdt_anchor_card_id: <提交调用的 callId>\`(即你开常驻卡用的那个卷号)。渲染层
会把这次结果的播放器/媒体卡**挂到常驻卡正下方**(替换"生成中"的视觉位置),
而不是留在轮询调用发生的地方——否则 AI 批量提交多个任务、最后统一轮询时,
所有媒体会脱离各自的卡堆在会话末尾。只锚得上**你自己**的卡(主机按 ghost 归属
校验);锚不上(卡已被清理等)自动回退到轮询位置渲染,不影响交卷。该字段是
渲染层配对令牌,AI 会被统一提示忽略它,你不用在 guidance 里解释。

## 4.6 订阅:旁听事件 + 钩子处理消息(subscribe 槽)

一种事件模型,两个类型:
- **监听(\`did-\`)** = 纯数据通知,事后告诉你发生了什么,你改变不了流程——适合做
  统计面板、成本记账、工作流水、"跟随用户正在看的会话"联动等纯观察型能力;
- **钩子(\`will-\`)** = 主机在对话流的关键点**停下来把数据交给你,做完再继续**。
  裁决窗口内你可以做**任何**你权限内的事(经 network 槽调自己的服务、经 cindy 槽
  请主机代办、任意本地计算、跨会话攒状态),最后用一个收敛动作收尾。两个钩点,
  一进一出:
  - \`will-user-message\`(入口):用户消息发给 AI **之前**交到你手上,动作
    allow/block/rewrite——改写不限于"优化提示词":翻译、脱敏、拼接你的知识库
    上下文、加路由标记,任何文本变换都行;block 则是前置合规/安全审;
  - \`will-assistant-message\`(出口):AI 回复完成后交到你手上,动作
    allow/rewrite/**render**——rewrite 同样是任意变换(后置合规改写、双语对照、
    补充署名…),render 则是**基于结果重新绘制呈现**,卡片形态与原文无关
    (图表、评分卡、警告卡、摘要卡都行)——见 §4.6.1。
  纯副作用场景(审计留痕、上报你自己的系统、记账)两头都支持:干完活回 allow
  即可,对话零感知。

主机经管子把事件下发到你的电子脑 \`onHostMessage\`;钩子还要你回一条 \`event-verdict\`。
声明:

\`\`\`json
"slots": [..., "subscribe"],
"subscribe": {
  "topics": ["turn", "session", "activity"],           // did- 旁听(元数据,不含消息内容)
  "hooks": ["will-user-message", "will-assistant-message"]  // will- 拦截(声明任一必须 launch:"resident")
},
"launch": "resident"               // 拦截要求常驻在场(否则每条消息都等你冷启动)
\`\`\`

\`\`\`js
cindy.onHostMessage(function (msg) {
  if (msg.type !== 'event') return;
  // ── did- 旁听:收到就收到,主机不等你,你也改变不了任何事 ──
  if (msg.name === 'did-turn-end') {
    // msg.data = { sessionId, agent, model?, durationMs, endReason, usage? }
    // usage 各字段可选(cc/codex 上报详尽度不同,别假设字段必在):
    //   { inputTokens?, outputTokens?, cacheReadTokens?, cacheCreationTokens? }
    // msg.seq 每意识单调递增;msg.dropped(可选)= 你熄灯期溢出丢弃的事件数。
    // 生命周期:会话被关掉或引擎被替换时,主机会给还在场的那一轮补发
    // endReason: 'interrupted',让 start/end 成对。但这不是投递保证——熄灯期
    // 缓冲溢出照样会丢(见 msg.dropped),状态机别只靠 end 归位。
    return;
  }
  // did-turn-start / did-session-created / did-session-archived 同理(见 topics)。
  // activity topic 只提供内层活动边界元数据:
  // did-thinking-{start,end}: { sessionId, blockId }(不含 reasoning 正文);
  // did-approval-{start,end}: { sessionId, requestId };
  // did-user-input-{start,end}: { sessionId, requestId }。
  // approval = permission / plan_review; user-input = ask_user_question。
  // **blockId / requestId 都是主机生成的不透明配对键**,不是 agent 或 provider 侧的
  // 原始 id:只保证同一段思考 / 同一个请求的 start 与 end 拿到同一个值,同一个上游
  // 请求在不同会话里也是不同值。它们不承载任何语义(看不出是哪个工具、哪个 MCP
  // 服务、是不是计划审批),也**关联不到**主机或 provider 的任何其他标识 —— 别拿它
  // 去和你从别处拿到的 id 对齐,只用来配对。
  // **按 requestId 配对,不是全局开关**:一轮里并行工具调用可能同时挂着多个审批,
  // 每个 requestId 各发自己的 start / end。要判断"是否仍在等审批",用 requestId
  // 集合(收到 start 加入、end 移除),集合非空即仍在等;别用单个布尔位,否则先结束
  // 的那个请求会把还在等的抹掉。
  // **审批可能跨过 did-turn-end**:codex 计划模式的 plan_review 就是在计划轮次
  // 收尾之后才发起的,你会先收到 did-turn-end、再收到 did-approval-start。所以
  // 别拿 did-turn-end 去清空审批状态——只认对应 requestId 的 did-approval-end。
  // thinking 不同:它只在轮次内,did-turn-end 前主机必定先补发未收口的
  // did-thinking-end。审批 / 等待输入则由主机在真实决策落地(批准、拒绝、回答、
  // 超时、取消)时收口,会话被关闭 / 重建时也会给所有在场 requestId 各补一条 end。
  if (msg.name === 'did-session-switched') {
    // 用户把某个会话切到台前(切换会话 / 从非会话页切回都算)。
    // msg.data = { sessionId, workdir? }。连续停留同一会话不重发。
    // 典型用法:面板按"用户正在看的会话"聚焦展示该会话的数据。
    return;
  }

  // ── will-user-message 钩子:3 秒内必须回裁决,否则主机按放行处理 ──
  // 语义 = "主机停下来交给你做,做完继续":你可以在这窗口里做任何事(记账、
  // 经 network 槽过合规接口…),然后用三种动作之一收尾:
  if (msg.name === 'will-user-message') {
    // msg.data = { sessionId, text };msg.hookId 原样带回。
    if (/(内部代号|密钥)/.test(msg.data.text)) {
      // ① block:打回,不继续(reason 展示在被拦气泡上)。
      cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'block', reason:'疑似包含敏感信息' });
    } else if (msg.data.text.indexOf('润色') === 0) {
      // ② rewrite:改写正文再继续(提示词优化 / 合规改写)。text 替换即将
      //    落库/显示/交给 agent 的正文;v1 静默替换(气泡直接显示改写版,无标记)。
      cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'rewrite',
                   text: '请结构化回答:' + msg.data.text.slice(2) });
    } else {
      // ③ allow:原样继续(纯副作用的钩子也走这条:记完账放行)。
      cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'allow' });
    }
  }
});
\`\`\`

硬规则(主机代码强制):
- **旁听 topic**:\`turn\`(轮次开始/结束,带 agent / 模型 / 耗时 / token 用量)、
  \`session\`(会话创建 / 归档 / 切换——切换 = 用户把哪个会话切到台前,连续停留
  同一会话不重发)、\`activity\`(思考 / 审批 / 等待用户输入的开始结束边界)。
  activity 只带 \`sessionId\` + \`blockId\` 或 \`requestId\`;**不会给 reasoning、工具
  input、命令、文件内容、计划正文、问题内容或答案**。旧插件不声明 activity 时行为
  完全不变;没声明的 topic 主机不投;
- **只覆盖你自己的主会话**:orca worker、后台自动化会话不投(与你无关的噪音)。
  粒度到**轮次**:主会话里由 \`/goal\` 自动续跑、定时任务、hook 渠道发起的轮次不投,
  **连它们触发的审批与提问也不投**。
  已知例外:飞书 / Slack 等渠道**接管**(attached)现有主会话代发的轮次,其
  \`did-turn-*\` 与 thinking 边界仍会投给你(该轮次在主机侧没打来源标记,这是
  \`turn\` topic 的既有行为,不是 activity 引入的);它触发的审批与提问**不会**投
  (走渠道卡的确认面,主机按面拦掉)。所以:\`did-approval-*\` /
  \`did-user-input-*\` 一定是用户本人在 Desktop 上被问到,不会出现没有对应轮次的
  孤儿审批;但 \`did-turn-*\` / \`did-thinking-*\` 偶尔可能来自渠道代发的轮次,别把
  "有 thinking"直接等同于"用户本人正在用 Desktop";
- **旁听是 fire-and-forget**:主机投完即走,你崩了/慢了不影响任何会话;熄灯期事件
  进队列(上限 100,溢出丢最旧,下一条带 \`dropped\` 计数),事件到达会把你按需
  拉起补投——但订阅型意识**建议 \`launch:"resident"\`**(要秒收就得在场)。
  **\`dropped\` 非零就必须重置你本地派生的状态**:被丢的可能正是某条
  \`did-turn-end\` 或 \`did-*-end\`,你要是继续拿旧状态往下推,就会永久停在
  "在忙 / 在等审批"。收到 \`dropped\` 时把状态清空、以此后到达的事件为准;
- **钩子超时 = 放行**:\`will-\` 裁决必须 3 秒内回,超时主机按 allow 放行(聊天绝不
  因你卡死);连续 3 次超时/崩溃,主机**熔断**你的钩子能力(降级为只旁听 + 提示
  用户),旁听不受影响。要过外部合规接口就在窗口内 \`await cindy.fetch\`(network
  槽),但整段必须 3 秒内出裁决;
- **三种动作**:\`allow\`(原样继续)/ \`block\`(打回,reason ≤200 字符,显示在被拦
  气泡)/ \`rewrite\`(改写正文再继续,\`text\` ≤16000 字符替换即将落库/显示/交给
  agent 的正文)。多个钩子意识按装入序串行,**链式变换**(前一个改写的输出是后
  一个的输入),任一 block 即短路;
- **block 的呈现**:消息发不出去(不落库不起 turn),气泡照常显示,其下渲一条
  **error 红条,内容 = 你返回的 reason 原文**(主机直接显示,不加框不署名——所以
  reason 写成一句完整的话)。用户用消息的编辑铅笔改了重发(改干净了自然通过,
  没改就再次被拦);**没有"强制发送"**,拦截就是发不出去;
- **rewrite 静默替换**:气泡直接显示改写后的正文(与交给 AI 的一致),**无标记、
  无弹窗**;空改写 / 改写等于原文一律被忽略;
- **UI 全主机画**:红条、气泡都由主机绘制,你只提供 reason / text 文本,伪装不了、
  也冒充不了别的意识;
- **钩子作用于"即将启动新 turn 的用户消息"**:运行中 turn 里的用户插话(steer)v1
  **不经**你的钩子——拦下 = turn 压根不启动,这是钩子点的语义边界,别假设
  能看到会话里的每一句话;
- **没有绕过通道(v1)**:被拦消息用户只能编辑后重发,重发仍会经你再审。即便
  如此也别把拦截当硬性管控设计(意识是工具不是管理员):reason 要引导用户怎么
  改,而不是单纯说不;
- **权限最重**:声明 hooks 在装入确认框里是最重的一条(「可读取、拦截或改写你
  发出的消息」),用户会看得很清楚,只在真需要时申请。

## 4.6.1 出口钩子 will-assistant-message(对 AI 回复做任意后处理)

AI 每轮回复完成后,主机把**全文**交给你——这是一个**通用后处理点,不限定用途**:
只做副作用(审计留痕 / 上报你的系统 / 记账)然后放行;任意变换正文(合规改写 /
翻译双语 / 脱敏 / 补充引用);或**基于结果重新绘制呈现**——卡片形态与原文无关,
回复里有数据就画图表卡、有结论就画评分卡、命中风险就画警告卡,全凭你的场景想象。
机制是**"先定案 → 一拍后替换"**:AI 回复照常流式显示、正常落库(和没你时一样);
你的处理在**后台独立进行**(不阻塞用户发下一条),处理完再原地更新那条消息。所以——

- **超时给足 5 分钟**(不同于入口钩子的 3 秒):它是后台后置钩,你可以从容跑外部
  接口、自己的 LLM、甚至请主机出图;超时/崩溃一律 fail-open(用 AI 原文定案,
  **绝不丢回复**),连续失败照样熔断降级只旁听;
- **动作 allow / rewrite / render**(**无 block**——AI 已生成,拦无意义)。下例以
  "调自己的服务改写"为演示,替换成你的任何处理逻辑都成立:

\`\`\`js
cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'event' || msg.name !== 'will-assistant-message') return;
  // msg.data = { sessionId, text = 本轮 AI 回复全文 };msg.hookId 原样带回。
  const polished = await cindy.fetch({ url: 'https://api.example.com/polish', method: 'POST',
                                       body: JSON.stringify({ text: msg.data.text }) });
  // ① rewrite:用改写正文替换回复(静默换文本,≤16000 字符)。
  cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'rewrite', text: polished.body });
  // ② 或 render:自绘卡片替换气泡(html 规则同 §4.5 card 槽:纯 HTML+CSS、零脚本、
  //    图片仅本意识 cindy-media 地址;height 初始估计;主机净化 + clamp)。
  // cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'render',
  //              html: '<div style="padding:12px">…</div>', height: 200 });
  // ③ 或 allow:原样定案(记完账放行)。
  // cindy.send({ type:'event-verdict', hookId: msg.hookId, action:'allow' });
});
\`\`\`

硬规则:
- **render 的 html 与 card 槽(§4.5)同一套净化**:纯 HTML+CSS、零脚本、图片只认你
  名下的 \`cindy-media://\` 地址、体积/height 同限、可用主机主题 \`var(--xxx)\`;不合规
  被净化器拒则回退原文;
- **原文始终保留("查看原文")**:render 时 AI 原文仍落库,主机在卡片旁画一个
  "查看原文"切换——你**盖不住** AI 实际说了什么(信任边界,与整个意识系统一致);
- **多个出口钩子意识**按装入序**串行链式**:rewrite 叠加(前一个改写的输出是后一个
  的输入),**render 最后一个胜出**;
- **处理期间那条消息挂"意识处理中"轻指示**(主机画),完成/超时清掉;
- **权限档**:声明 \`will-assistant-message\` 在装入确认框里单列一条(「可读取并重写
  AI 的回复」),比入口钩子更敏感(能看到 AI 完整输出),只在真需要时申请。

## 4.7 网络代发(network 槽)

声明 \`"slots": [..., "network"]\` + network 详单(§2)后,电子脑可用 \`cindy.fetch\`
访问**白名单内的域名**——沙箱本身仍然零直连,请求由主机代发:主机校验域名、
注入凭证、执行 HTTP、把响应给你。规则:

\`\`\`js
const r = await cindy.fetch({
  url: 'https://api.example.com/v1/search?q=hello',  // 仅 https、默认端口;host 必须命中详单白名单
  method: 'GET',            // 可选:GET(缺省)/ POST / PUT / PATCH / DELETE
  headers: { Accept: 'application/json' },  // 可选;Host/Cookie/Authorization 等由主机管,写了也不生效
  body: '{"q":"hello"}',    // 可选:仅 POST / PUT / PATCH / DELETE,≤256KB 文本
  timeoutMs: 30000,         // 可选:文本模式 1s–60s 缺省 30s;媒体模式 1s–300s 缺省 120s
  as: 'text',               // 可选:'text'(缺省)/ 'media'(响应是媒体,主机落仓,见下)
  label: '',                // 可选:仅媒体模式,入账备注/画廊 caption(≤200 字符)
  callId: msg.callId        // tool-call 触发的请求务必带上(归因,同 cindy-request)
});
// 文本成功:{ ok:true, status: 200, headers: { 'content-type': … }, body: '<响应文本>', truncated? }
//   注意 4xx/5xx 也是 ok:true(代发成功,对方说不行)——自己看 status 分支。
//   body 上限 50MB,超限截断并带 truncated:true;文本模式下二进制响应返回 ok:false。
//   超 1MB 的大文本响应与媒体取件共享全局通道(同时只读一单),通道忙时
//   返回 ok:false「大响应通道正忙」——稍后重试即可,小响应不受影响。
// 媒体成功(as:'media' 且响应是受支持媒体):
//   { ok:true, status, headers, media: { url: 'cindy-media://blobs/<指纹>.<后缀>', hash, ext, bytes } }
//   **字节不进你的沙箱**:主机直接落媒体总仓、记到你名下(与 cindy 代办产物同等待遇:
//   可当改图源图、可上画廊、交卷 xdt_image_urls 可渲染)。受支持类型 = 图片(png/jpg/
//   webp/gif)/ 视频(mp4/webm/mov)/ 音频(mp3/wav/m4a/ogg)/ 3D(glb);上限 256MB,
//   超限整单拒(不截断)。Content-Type 只作为线索,落仓前主机会按字节验证真实媒体类型;
//   对缺失、text/plain 或通用 octet-stream 这类常见误报/泛化声明,主机会按受支持
//   媒体的有限魔数尝试识别。识别成功仍走同一媒体总仓,并以字节识别出的 MIME 落仓;
//   识别失败的真实 UTF-8 文本继续回落文本形态,未知二进制拒绝。
//   媒体模式下 2xx 的文本响应(如轮询"生成中"JSON)自动
//   回落文本形态给你看;非 2xx 同样回落文本,方便诊断。
// 失败:{ ok:false, message: '原因' }(白名单外 / 凭证未配置 / 超时 / 网络错误…)
\`\`\`

**凭证语义(必读)**:你在详单里只声明"需要一条叫什么的凭证、注入到哪个请求头";
值由主机加密保管、只在代发请求时注入。**保险库里的明文你的代码永远读不回**——
不要试图让用户把 key 发进聊天,更不要把 key 硬编码在源码里。
这里说的是 \`network.secrets\` 的浏览器沙箱/HTTP 代发语义；确需本地协议时，
\`node.secretBindings\` 是唯一允许把对应凭证交给 Node Worker 的显式例外，
并会在安装权限清单单独披露(见 §4.12.1)。

**调用前缺失的普通 user Secret 由主机统一 Setup 卡收单**：主机只根据你声明的
\`label\` / \`hint\` 生成密码输入，不把值交给 Agent 或你的代码；提交后直接写保险库并
重新检查 setup，全部满足才继续原工具调用。你不要声明表单字段 id、Action id 或聊天卡
回调，也不要让用户把 key 发进聊天。同一 \`anyOf\` 组声明了多种合法配置方式时，
主机会完整展示所有选项供用户选择，不会只取第一项；选项较多时统一卡片正文内部滚动。

**settingsHtml 仍负责详情页里的长期管理**(当前声明 user 凭证仍必须同时声明
settingsHtml,校验强制):你在 settingsHtml 里画输入框供用户主动添加、替换或清除，值经
\`fetch('/secrets/<key>', { method:'PUT', body: JSON.stringify({ value }) })\`
**一次性交给主机保险库**(204 即入库),\`fetch('/secrets')\` 只能查回
\`[{key, saved, tail?}]\` 状态、**永远拿不回值**(tail 是主机截存的**尾 4 位
指纹**,仅够用户回忆"填的是哪个 key";值不足 12 字符时不产——UI 要按没有
tail 也能画来写),DELETE 清除。红线:收单即交,不许把 key 落进 /kv、
BroadcastChannel、日志或任何自存路径(review 必查)。凭证只会注入到它
\`inject.hosts\` 声明的域名请求,重定向出域也不会跟着走。用户没填时 cindy.fetch
返回结构化错误,把 message 原样告诉用户即可(里面带了去哪填的指引)。
无论走 Setup 卡还是 settingsHtml，入库成功时主机会自动弹一条「凭证已保存」的系统提示(带你的身份头,
文案跟随用户语言;无需声明 notify 槽)——设置页里画个就地的轻反馈即可,
不用自己想办法做全局提示。
(历史字段 \`input\` 已退役:遗留 \`"input":"ghost"\` 可被接受并忽略,
\`"input":"host"\` 直接拒——删掉该字段即可。)

**登录邮箱派生凭证(source:"login-email",可选)**:适用于"服务端按登录邮箱派生
鉴权"的第一方服务(如 pages_<邮箱> 形态的 token)。凭证声明 \`"source": "login-email"\`
后,值不再由用户填——主机在每次请求时现读当前登录账号的邮箱,按 \`inject.format\`
模板派生(如 \`"format": "pages_{value}"\` 得到 \`pages_<邮箱>\`)注入请求头;它没有
任何输入动作,装入确认框如实告知"将使用你的登录邮箱"。
未登录 / 登录态没有邮箱时 cindy.fetch 返回带重登指引的结构化错误,把 message 原样
告诉用户即可。注意:声明了 login-email 就不要再写 \`url\`(没有"前往控制台"可去)
也不要配 \`exchange\`(登录邮箱不外送交换端点),两者校验都会拒。你的 settingsHtml
可经 \`fetch('/secrets')\` 查回该凭证的 \`{ key, saved, identity }\`(identity =
当前登录邮箱,拿来只读展示"用的是哪个身份";未登录时 saved:false 无 identity,
照"请重新登录"画)——确认框已如实披露,除展示外别拿它做别的;对该 key 的
PUT/DELETE 一律 405(派生身份不可配置)。

**key 换令牌二段式(exchange,可选)**:有些服务的 API key 不直接当请求凭证,要先
POST 一个交换端点换临时令牌(令牌才进 Authorization)。在凭证上声明 \`exchange\`
(字段见 §2),主机就照单代办整个流程:换取 → 按 ttlSeconds 缓存 → \`inject.format\`
的 {value} 注入**换来的令牌**而非原始 key → 上游 401 时自动作废缓存重换重试一次。
你的代码完全无感——照常 cindy.fetch 就行,key 和令牌都不进沙箱。注意:交换端点
域名必须命中 hosts 白名单;交换端点返回重定向会被阻断;tokenPath 只支持点分对象
路径(不支持数组下标);交换失败(端点非 2xx / 响应缺令牌字段)时 cindy.fetch 返回
结构化错误,message 带状态码与摘录,原样转告用户即可。

**主机托管 OAuth 授权(source:"oauth",可选)**:对接 Google / Atlassian 这类
"标准 OAuth 授权、令牌会过期要刷新"的服务时用。你在凭证上声明 \`"source": "oauth"\`
+ \`oauth\` 详单(字段见 §2:去哪授权、要什么 scopes、服务商特有参数),整个授权
流程由主机可信代码执行:拉系统浏览器、本机回调、code 换 token、到期刷新、
refresh token 保管——**你的代码全程无感也无从插手**,照常 cindy.fetch,主机出网时
现取新鲜 access token 按 \`inject.format\` 注入(上游 401 自动作废重刷、整链重试
一次)。client 凭证(clientId / clientSecret)两种给法:**内置在 oauth 详单里**
(用户零配置,点连接就走——桌面应用的 client 凭证按服务商官方口径本非机密,
写进包里不引入泄露面;授权仍需用户在浏览器亲自同意),或**留空让用户在你的
settingsHtml 里自填**(用户用自己注册的 OAuth 应用,配额风控归用户)。两者可
并存:用户自填的**覆盖**内置值(成对生效),清除自填即回落内置。注意换 client
后旧账号的令牌刷不动(令牌与 client 绑定),会自动标过期引导重连,设置页文案
要如实提示。settingsHtml 里经 \`/oauth\` 协议通道完成收单与连接:

\`\`\`js
// 状态回查(哪些 oauth 凭证槽、client 配没配、连了哪些账号;零令牌字节):
const list = await (await fetch('/oauth')).json();
// → [{ key:'acct', clientConfigured:true, clientCustom:false, accounts:[{ id, label, status:'connected'|'expired', isDefault, createdAt, avatarDataUrl }] }]
// avatarDataUrl = 头像 data URL(声明了 identity.avatarPath 且主机下载成功才有,否则 null;<img src> 直接用)
// clientConfigured = 自填或内置任一在场;clientCustom = 用户自填过(UI 显示"内置应用身份/已自定义")
// client 凭证只写入库(和 /secrets 同纪律,存入后拿不回;clientSecret 可省略 = 纯 PKCE):
await fetch('/oauth/acct/client', { method:'PUT', body: JSON.stringify({ clientId, clientSecret }) });  // 204 即入库
// 「连接账号」按钮 → 主机拉浏览器跑授权(等待时间可能数分钟,给用户 loading 提示):
const connectInit = { method:'POST' };
// broker 模式可选:必须等于 oauth.clientId 或 clientIdAlternatives 中一项;
// 典型用法是先读 /app-context,由意识按 region 选择公开 App ID。
if (selectedClientId) connectInit.body = JSON.stringify({ clientId: selectedClientId });
const r = await (await fetch('/oauth/acct/connect', connectInit)).json();
// → { ok:true, account } 或 { ok:false, error: 'NO_CLIENT_CONFIG'|'ACCOUNT_LIMIT'|'VAULT_WRITE_FAILED'|'INVALID_CONFIG'|'LISTEN_FAILED'|'TIMEOUT'|'CANCELLED'|'CALLBACK_INVALID'|'EXCHANGE_FAILED'|'SERVICE_UNAVAILABLE'|'NETWORK', detail? }
// NETWORK = 客户端无法连接授权服务,提示用户检查网络后重试;
// SERVICE_UNAVAILABLE = broker 路由缺失或服务端 5xx,提示用户稍后重试。
// 授权成功时主机会自动弹「授权成功,已连接 xxx」的系统提示(带你的身份头,
// 无需声明 notify 槽);设置页只管刷新自己的账号列表。
// 断开账号 / 设默认账号:
await fetch('/oauth/acct/accounts/<accountId>', { method:'DELETE' });          // 204(幂等)
await fetch('/oauth/acct/default', { method:'POST', body: JSON.stringify({ accountId }) });  // 204
\`\`\`

多账号:每个 oauth 凭证槽最多 8 个账号;cindy.fetch 可带 \`authAccount: '<账号id>'\`
指定用哪个账号的令牌(缺省 = 默认账号)。同一身份重复授权 = 重连:授权回来的
身份标签(identity.labelPath 的值)与已连账号相同时,主机覆盖那条的令牌并复活状态,不新增
占位——账号 id 稳定,你缓存的 authAccount 不会因用户重连而失效。声明了
identity.displayTemplate 时,\`/oauth\` 回查与连接结果里 account.label 给的是
渲染后的展示名(合并判定仍按 labelPath 的稳定值,展示名变了不会堆出新账号行)。规则:authorizeUrl / tokenUrl / identity.url
的域名都必须命中 hosts 白名单(装入确认框会展示"将引导你在 <授权域名> 完成授权"
+ scopes 全量清单,用户知情放行);oauth 与 exchange 互斥;声明 oauth 凭证必须同时
声明 settingsHtml(没人收 client 凭证就没人能连接)。账号授权失效(AUTH_EXPIRED)
时 cindy.fetch 返回带指引的结构化错误,原样转告用户去设置页重新连接即可。

两个可选的授权细节字段(见 §2 样例):
- \`redirectPort\`:回调固定端口。服务商要求回调 URI 与其后台注册值**精确匹配**
  (含端口,如 Atlassian)时声明,主机回调恒为 \`http://127.0.0.1:<端口>/callback\`;
  端口被占用时连接返回 LISTEN_FAILED(detail 带人话提示,settingsHtml 原样展示
  即可;第一方官方内置意识会先自动结束占用进程并重试,第三方意识不享受此回收
  ——请选一个不易撞车的端口)。Google 这类允许任意 loopback 端口的服务商不用
  声明。
- \`tokenBroker\`:**仅第一方官方意识可用**(第三方声明直接拒装)——code/refresh
  交换改经 Cindy 服务端 broker 完成,client secret 由服务端持有、不随包分发,
  且要求用户已登录 Cindy。声明它时与 clientSecret 互斥;PKCE 缺省开(verifier
  经 broker exchange 透传服务端),不吃 PKCE 的服务商显式 \`"pkce": false\`;
  设置页的 \`/oauth/<key>/client\` 自填通道返回 405(settingsHtml 不要再画
  client 输入区)。
- \`brokerBounce\`:双地址弹跳回调(随 tokenBroker,同样仅第一方)。部分
  服务商后台只收 https redirect、不收 http loopback——声明后报给服务商的
  redirect_uri 是「broker 服务的 https 弹跳路由」(主机用 broker 基地址 + \`path\`
  运行时拼出),浏览器授权后弹跳路由 302 回本机
  \`http://127.0.0.1:<redirectPort><callbackPath>\`。必须与 tokenBroker、
  redirectPort 同时声明(302 目标端口/路径在 broker 服务端写死,三者一套约定)。

连接时还可以降面授权:\`POST /oauth/<key>/connect\` 支持可选 body
\`{"scopes":[...]}\`——本次授权只申请清单 scopes 的**非空子集**(如"只读连接"
按钮只带读 scope);越界或不在清单里的条目 400。不带 body = 申请全量声明面。

**媒体上传(upload,媒体模式的镜像)**:要把媒体文件传给你的服务(改图源图、
参考图等),在 fetch 请求里报总仓指纹,主机验归属、读字节、代组 multipart——
字节同样不进你的沙箱:

\`\`\`js
const r = await cindy.fetch({
  url: 'https://api.example.com/v1/file/',
  method: 'POST',                                   // upload 仅 POST;与 body 互斥;与 as:'media' 互斥
  upload: { hashes: ['<64位指纹>'], field: 'file' }, // 1–4 条;field 缺省 'file'
  // 可选 fields ≤8 条:随行普通表单字段,在文件段之前;值里的字面量 "{bytes}"
  // 由主机替换成全部上传文件的总字节数(要求 size 字段的服务用):
  // upload: { hashes: [...], field: 'file', fields: { parent_type: 'docx_image', size: '{bytes}' } }
  callId: msg.callId,
});
// 响应按文本形态返回(服务端的入库回执 JSON 你自己解析)。
\`\`\`

只能上传**自己名下**的总仓媒体:出生自你(cindy 代办产物 / as:'media' 取件)、
挂你画廊、或用户随消息把图交给你(附件过户,指纹在 args.attachments)。别人的
指纹统一"不存在或不属于本意识"。Content-Type(boundary)由主机独占,你写了也
会被覆盖;单文件 ≤64MB、单次总量 ≤128MB,超限整单拒。

**目录上传(uploadDir,目录过户票据)**:要把用户的一个本地目录整体传给你的
服务(静态站点部署等),流程是"主 agent 过户 → 你凭票上传"——主 agent 调
ghost_call 时把目录**绝对路径**放在顶层 \`dir\` 参数(会话工作目录内直接放行,
工作目录外主机会弹确认卡、用户点允许才过户;自动排除 node_modules/.git/.env
等),主机收集文件后把一次性限时票据注入你的
\`args.dir_deposit\`(含 token / file_count / total_bytes / rel_paths 相对路径清单);
你在工具描述里写清"目录经 ghost_call 顶层 dir 交付",然后:

\`\`\`js
const r = await cindy.fetch({
  url: 'https://api.example.com/deploy',
  method: 'POST',                                   // uploadDir 仅 POST;与 body / upload / as:'media' 互斥
  uploadDir: {
    token: args.dir_deposit.token,                  // 一次性票据:用一次即废,失败重试要主 agent 重新过户
    fields: { name: 'my-site' },                    // 可选 ≤8 条:随行普通表单字段(值里的 "{bytes}" 由主机替换成文件总字节数)
    fileFieldPrefix: 'file-',                       // 可选:文件字段名前缀(第 N 个文件字段名 file-N,filename=相对路径)
    // fileField: 'file',                           // 可选(与 fileFieldPrefix 互斥):单文件精确字段名——票据必须恰含
    //                                              // 1 个文件,filename 只取文件名;"字段名钉死 file"的服务(飞书传文件)用
  },
  callId: msg.callId,
});
\`\`\`

你从头到尾拿不到绝对路径与文件字节(rel_paths 只是相对路径清单,可用来做
preset 判定等纯逻辑);伪造/过期/别人的票据统一"票据无效"。单目录 ≤500 个
文件、单文件 ≤50MB、总量 ≤256MB,超限在过户期就拒。\`dir\` 也接受**单个
文件**的绝对路径(传附件等场景):按单文件票据处理,rel_paths 就一条文件名。

**文件下载落盘(as:'file' + save 票据,uploadDir 的镜像)**:要把下载的文件
(邮件附件、云盘文档等任意类型)存到用户本地时,流程同样是"主 agent 过户 →
你凭票下载"——主 agent 调 ghost_call 时把**目标目录绝对路径**放在顶层
\`save_dir\` 参数(目录必须已存在;会话工作目录内直接放行,工作目录外主机会
弹确认卡、用户点允许才过户),主机把限时
票据注入你的 \`args.save_deposit\`(含 token / dir_name 目录名);你在工具
描述里写清"下载目录经 ghost_call 顶层 save_dir 交付",然后:

\`\`\`js
const r = await cindy.fetch({
  url: 'https://api.example.com/files/123/download',
  as: 'file',                                       // 任意类型字节直接落盘,不进你的沙箱也不进媒体总仓
  saveTo: {
    token: args.save_deposit.token,                 // 限时票据(10 分钟内最多写 16 个文件 / 共 512MB)
    filename: 'report.docx',                        // 可选建议名;缺省从 Content-Disposition / URL 派生
  },
  callId: msg.callId,
});
// 成功:{ ok:true, status, headers, file: { file_name, bytes, mime_type } }
//   file_name 是主机消毒去重后的最终文件名(不覆盖已有文件),交卷时拼
//   args.save_deposit.dir_name 告诉用户"已存到 <目录名>/<文件名>"。
// 非 2xx 自动回落文本形态(错误 JSON 你看得到);单文件上限 256MB 超限整单拒。
\`\`\`

文件名由主机消毒(只留文件名本体、剥路径与控制字符),你从头到尾拿不到
绝对路径与文件字节;伪造/过期/写满的票据统一"票据无效"。

**多连接(connections,可选)**:对接**自建实例**类服务(GitLab 私服、自托管
API 等"每个用户地址都不一样"的场景)时用——静态 hosts 白名单写不出用户的
域名,改声明"连接类型",地址与凭证由用户在你的 settingsHtml 里**成对多条**
添加。声明形态见 §2 样例(\`network.connections\`,0–2 条声明;每条 1–64 字
label + inject 注入形态 + 可选 maxConnections);声明了 connections 时 hosts
可缺省(静态域名与动态连接至少有其一),声明 connections 必须同时声明
settingsHtml。语义要点:

- **动态白名单**:用户添加的每条地址并入本意识的放行域(精确匹配裸域,
  不吃通配;https + 默认端口限制照旧)。**每次新增地址,主机都会弹一个
  受信确认弹窗**(系统模态,不是你的页面)向用户摊牌"该意识请求添加连接
  地址 xxx"——用户拒绝则添加失败(CONFIRM_DENIED),你的设置页如实提示即可;
  同一地址更新 token/label 不再弹(放行面没变)。
- **凭证只注入对应地址**:每条连接的 token 只会注入到那条连接自己的域名
  请求(按声明的 inject.header/format);跳转到另一个连接地址时注入的是
  那个地址自己的 token。inject 不允许声明 hosts(校验拒装)。
- **cindy.fetch 无新参数**:照常发请求即可,URL 命中哪个连接就注入哪个
  连接的凭证;地址没添加过 → 结构化"白名单外"错误(message 带"去设置页
  添加连接"指引),token 缺失 → 结构化"凭证未配置"错误,原样转告用户。

settingsHtml 里经 \`/connections\` 协议通道完成收单(token 只写不读,与
/secrets 同纪律;tail = 主机截存的尾 4 位指纹,仅够用户回忆):

\`\`\`js
// 状态回查(每条声明:上限 + 已添加的连接;零 token 字节):
const list = await (await fetch('/connections')).json();
// → [{ key:'gitlab', label:'GitLab 实例', maxConnections:4,
//      connections:[{ id, host:'gitlab.example.com', label, isDefault, tail }] }]
// 添加/更新一条连接(host = 小写裸域;新地址会触发主机受信确认弹窗,给用户等待提示):
const r = await (await fetch('/connections/gitlab', {
  method: 'POST',
  body: JSON.stringify({ host: 'gitlab.example.com', token: 'glpat-xxx', label: '公司主库' }),
})).json();
// → { ok:true, connection } 或 { ok:false, error:
//    'INVALID_HOST'|'INVALID_TOKEN'|'CONFIRM_DENIED'|'LIMIT'|'VAULT_WRITE_FAILED' }
// 同 host 再 POST = 更新语义:只换 token/label,连接 id 稳定不变。
// 删除 / 设默认连接:
await fetch('/connections/gitlab/<connectionId>', { method: 'DELETE' });      // 204(幂等)
await fetch('/connections/gitlab/default', { method: 'POST', body: JSON.stringify({ connectionId }) });  // 204
\`\`\`

上限:connections 声明 ≤2 条;每条声明下用户可添加 ≤8 条连接(作者可用
maxConnections 收紧到 1–8);token ≤4096 字符。新连接添加成功时主机会自动
弹「连接地址已添加」的系统提示(带你的身份头,无需声明 notify 槽)。

其它硬边界:每意识同时在途 4 个请求;媒体取件/上传共用全局串行闸,同时只
处理一单(忙时返回结构化"正忙",稍后重试即可);重定向最多 3 跳且逐跳重验
白名单;不支持流式/WebSocket。长任务用"提交 + 轮询"两个工具拆开做;在一次
tool-call 内轮询时记得定期发 tool-progress 心跳续命(见 §4"长任务续命")。

## 4.8 设置自绘(settingsHtml)+ 自定义参数存取(/kv)

需要用户配置**凭证之外**的自定义参数(开关、选项、默认风格、服务地址选择等)时,
声明 \`settingsHtml\`——主机在主界面侧边栏「插件」的详情页里渲染你自绘的设置界面,
以后加参数只改你自己的包,不需要主机更新:

\`\`\`json
"settingsHtml": "settings.html",   // 安装目录内相对路径;打包期校验文件必须在场
"settingsHeight": 360              // 可选:固定高度 px(160–800);缺省 = 随内容自适应(矮内容真收矮),超 800 内部滚动
\`\`\`

**渲染环境**:与面板同款沙箱页(零桥、零网络直连、CSP 只认同源)。主题变量与
面板同一套(§5「主题」条的 \`var(--xxx, 回退值)\` 写法照用),主机注入并随换肤
自动重灌;设置区基线背景 = 宿主设置卡片色(与相邻卡片无缝),别再自己铺整页
底色。高度缺省自适应:主机在页面就绪后量内容高度,内容动态增减(展开区、
追加列表)时会自动跟随重量(内部 ResizeObserver 通知宿主再量,你无需做
任何事)。自适应模式下主机会把 html/body 高度钉为 auto、宽度收在设置卡片内
并裁掉横向溢出;同时统一给页面元素应用 box-sizing:border-box、min-width:0
和 max-width:100%,让固定宽控件也能在窄卡片中收缩。布局按"内容自然撑高 +
容器宽度自适应"来写,别用 height:100%/100vh 撑满视口(高度会追不准),也别
依赖固定宽度、横向滚动或自定义 content-box 尺寸;纵向滚动条只在内容超 800px
上限时出现,上限内高度始终贴合内容。只有想把区域高度完全钉死时才声明
settingsHeight(此时主机不注入上述响应式规则,超出部分由你的页面内部滚动)。
意识沉睡时设置区不渲染(显示沉睡提示),唤醒后可用。

**外链(前往控制台)**:设置区/面板里可以放 \`<a href="https://…">\` 链接,但
只有 **href 与身份卡 \`network.secrets[].url\` 声明逐字一致**的地址会被主机放行
——点击时主机拦下导航、转系统浏览器打开(沙箱页自身永远不离开自己协议)。
声明之外的任何外链点了没反应(主机静默拦下),脚本自动跳转也无效(须用户
真点击且页面持有焦点,同一意识 1s 内至多放行一次)。href 直接从身份卡声明里
**原样复制**——浏览器会把导航地址归一化(域名转小写、根路径补尾斜杠),声明
写成非规范形态会导致比对永远失配、链接点了没反应,所以声明本身也用规范形态
(小写域名、根路径带 \`/\`)。典型用法:输入行下方放一条
\`<a class="console-link" href="…">前往控制台获取 ↗</a>\`,方便用户一键去申请 key。

**自定义参数持久化(/kv)**:每段意识有一份主机代管的 JSON 参数(单意识一份,
互相隔离),设置页 / 面板 / 电子脑同源共用,读写都走 \`fetch('/kv')\`:

\`\`\`js
// 读(无数据时得到 {}):
const cfg = await (await fetch('/kv')).json();
// 写(整体覆盖 last-write-wins,不做字段级合并;PUT / POST 等价):
await fetch('/kv', { method: 'PUT', body: JSON.stringify({ style: 'anime', autoRun: true }) });
\`\`\`

规则:
- **路径必须写绝对的 \`'/kv'\`**——settingsHtml 放在子目录(如 \`ui/settings.html\`)时,
  相对路径 \`fetch('kv')\` 会解析成 \`/ui/kv\` 落 404;
- 值必须是 JSON **object**(数组/标量拒,400),序列化 ≤ **64KB**(超限 413);
- 写成功回 204 无 body;读永远回 200 + JSON;
- **卸下意识时清除,沉睡保留**;更新版本保留;
- 设置页与电子脑/面板同源,改完参数可用 \`BroadcastChannel\` 通知对方热生效
  (同一意识的面板/设置页/电子脑共用频道名,消息自带 type 字段区分来源);
- **不要在 /kv 里存任何密钥/token 明文**——凭证一律走 network.secrets 声明，
  调用前可由主机 Setup 卡内联入库，详情页管理走 settingsHtml + /secrets 只写通道
  (§4.7)，这是 review 红线;
- \`/kv\` 与 \`/secrets\`、\`/oauth\`、\`/wake\`、\`/gallery\`、\`/media/\`、\`/preview/\`、\`/__boot__\`
  一样是主机保留路径,安装目录里的同名文件会被遮蔽,起名避开。

最小骨架(**脚本必须外挂文件**——CSP 同源不放行内联 \`<script>\`,写了不执行;
内联 style 属性可用):

\`\`\`html
<!-- settings.html:底色/字色/字体不用自己写——主机注入基线已铺好
     (背景 = 宿主设置卡片色,与相邻卡片无缝;自己再铺整页底色反而会突兀) -->
<!doctype html><meta charset="utf-8">
<body style="margin:0;padding:12px">
  <label>默认风格 <input id="style" style="background:var(--surface,#fff);color:inherit;border:1px solid var(--border-default,#e4e4e0)"></label>
  <button id="save">保存</button>
  <script src="/settings.js"></script>
</body>
\`\`\`

\`\`\`js
// settings.js
const $ = (s) => document.querySelector(s);
fetch('/kv').then((r) => r.json()).then((cfg) => { $('#style').value = cfg.style ?? ''; });
$('#save').onclick = async () => {
  await fetch('/kv', { method: 'PUT', body: JSON.stringify({ style: $('#style').value }) });
  new BroadcastChannel('my-ghost').postMessage({ type: 'settings-changed' });
};
\`\`\`

\`BroadcastChannel\` 只用于让你自己的 panel / 电子脑热更新。聊天里的统一设置卡不监听
这个事件,也不需要你写任何完成回调；\`/oauth\`、\`/kv\`、\`/secrets\`、
\`/connections\` 保存成功后,主机会重新读取真实状态并自动更新卡片、继续原工具调用。

## 4.9 系统提示(notify 槽)

声明 \`"slots": [..., "notify"]\` 后,电子脑可以请主机在屏幕顶部弹一条轻提示(toast)
——适合"没有在途调用、面板也没开着,但有事想轻声告诉用户"的场景:分钟级长任务
完成了、授权快过期了、旁听到值得提醒的事。

\`\`\`js
const r = await cindy.send({ type: 'notify', text: '视频已生成,点面板查看', tone: 'success' });
// r = { ok: true } 或 { ok: false, message: '原因'(被限速/超长/未声明槽等) }
\`\`\`

规则(都由主机强制,写错拿到的是结构化拒绝):

- \`text\`:**纯文本**,≤200 字符,允许 \\n 换行;HTML 不会被渲染(原样当文字显示),
  控制字符会被剥掉。想排版富内容用聊天卡片(§4.5)或面板,不要塞进提示;
- \`tone\`(可选):\`'info'\`(缺省)/ \`'success'\` / \`'warning'\` / \`'error'\`,只影响
  图标与配色;
- **限速**:同一意识两条提示最小间隔 5 秒,超发直接拒(\`ok:false\`),不会排队——
  别拿它刷进度条,进度走聊天卡片的过程版(§4.5);
- **身份头主机画**:提示上自动带你的图标和名字,冒充不了主机通知、也冒充不了别的
  意识;正文里不用再自报家门;
- 提示自动消失、无按钮、无回执——**不是确认框**。要用户点「同意/取消」并把答案交回
  给你,用 §4.18 的 confirm 槽(主机同款确认框);要在聊天流里放按钮用交互卡
  (§4.5 的 data-ghost-action)。

## 4.10 写文件(fs 槽)

声明 \`"slots": [..., "fs"]\` 后,电子脑可以请主机代写文件(创建/覆盖)。沙箱本身
仍然没有文件系统——字节永远由主机落盘,这个槽是"申请主机代写"的资格。装入
确认框会如实展示"可写入文件",没声明就调用只会拿到结构化拒绝。

\`\`\`js
// 写自己的私有数据目录(免确认;适合缓存、大结果落盘、跨生命周期状态)
const w = await cindy.send({ type: 'fs-request', op: 'write', root: 'data',
  path: 'reports/result.json', content: JSON.stringify(data) });
// w = { ok:true, op:'write', path:'reports/result.json', bytes:12345 } 或 { ok:false, message:'原因' }

// 读回 / 列清单 / 删除(仅限 root:'data')
await cindy.send({ type: 'fs-request', op: 'read',   root: 'data', path: 'reports/result.json' });
await cindy.send({ type: 'fs-request', op: 'list',   root: 'data' });          // 可带 path 列子目录
await cindy.send({ type: 'fs-request', op: 'delete', root: 'data', path: 'reports/result.json' });

// 写当前会话的工作目录(仅 write;必须带 tool-call 下发的 callId)
await cindy.send({ type: 'fs-request', op: 'write', root: 'workdir',
  path: 'output/summary.md', content: text, callId: msg.callId });

// 写主 agent 过户的目录(仅 write;token 来自 ghost_call 顶层 save_dir 注入的 args.save_deposit.token)
await cindy.send({ type: 'fs-request', op: 'write', root: 'save',
  path: 'report.json', content: text, token: msg.args.save_deposit.token });

// 语法糖:cindy.fs({...}) ≡ cindy.send({ type:'fs-request', ...})(同 cindy.fetch)
await cindy.fs({ op: 'write', root: 'data', path: 'a.txt', content: 'hi' });
\`\`\`

三档目的地(都由主机强制,写错拿到的是结构化拒绝):

- \`root:'data'\` **私有数据目录**:你的专属储物柜(卸载时整体回收,沉睡保留)。
  免确认,全操作(write/read/list/delete)。配额:总量 256MB、2000 个文件;
  超限写会被拒,自己删旧文件腾地方。**超大工具结果建议落这里再把路径交给
  agent 读**(交卷体量有限时的泄洪通道);
- \`root:'workdir'\` **会话工作目录**:仅 write,必须带当次 tool-call 的 \`callId\`
  (主机凭它定位会话,不认自报)。**是否放行跟随该会话的权限模式**——agent
  编辑文件免批的模式直接写;逐条确认的模式会弹确认卡请用户点头(同目录本
  会话批一次);计划/只读模式一律拒。SSH 远程工作区会话不支持(目录在远端
  机器),会明确报错,请改用 root:'data';
- \`root:'save'\` **过户目录**:仅 write,凭主 agent 在 ghost_call 顶层传 \`save_dir\`
  过户后注入的 \`args.save_deposit.token\` 写入(与 §4.7 fetch \`as:'file'\` 下载
  落盘同一张票:限时、限次数、限字节、文件名主机消毒、永不覆盖已有文件)。

通用规则:

- \`path\` 是相对路径(\`a/b/c.ext\` 形态):正斜杠分段、最多 16 段、无 \`.\`/\`..\`、
  每段以字母/数字/下划线开头且不许以点结尾——**写不了以点开头的隐藏文件**
  (.git / .env 等),这是刻意限制;Windows 保留设备名(NUL / CON 等)也拒;
- \`content\` 默认按 UTF-8 文本落盘;二进制传 \`encoding:'base64'\`(read 同理,
  想拿二进制回传 \`encoding:'base64'\`);单次写入上限 16MB,超了拆多个文件;
- 符号链接一律不穿透:目标是 symlink、或路径经 symlink 逃出根目录,直接拒。

## 4.11 发起 Agent 新回合(agent 槽)

这个槽让你的 \`main.js\` 把一段文字作为**普通用户消息**交给 Cindy Agent，适合
“用户在插件卡片上点继续，然后 Agent 接着做”的流程。它不是系统提示词，也不会
修改该会话里其它插件或 Agent 的长期规则。

最安全、也是默认的用法，是消费 \`card-action\` 事件里的真实用户点击票：

\`\`\`js
cindy.onHostMessage(async function (msg) {
  if (msg.type !== 'event' || msg.name !== 'card-action') return;

  const result = await cindy.agent.run({
    mode: 'continue', // continue = 继续原会话；fork = 从最新回复分叉；new = 新建会话
    promptTemplate: '用户要求：{{user_message}}\\n插件事件：{{event_json}}\\n请继续处理。',
    userMessage: msg.prompt || '继续',
    event: { actionId: msg.actionId, callId: msg.callId },
    userActionToken: msg.userActionToken,
    // title: '插件创建的新任务' // 仅 mode:'new' 时使用
  });

  if (!result.ok) {
    // result.errorCode / result.message 可用于把失败原因画回卡片
    return;
  }
  // result.sessionId = 实际工作的会话；disposition 说明新建/恢复/排队/分叉
});
\`\`\`

模板规则由主机强制：

- \`promptTemplate\` 必须且只能出现一次 \`{{user_message}}\`；主机把
  \`userMessage\` 填进去。\`{{event_json}}\` 可出现零次或多次，主机统一替换成
  \`event\` 的 JSON。不要自己用字符串拼接绕开模板；
- \`mode:'continue'\` 使用被点卡片所属的原会话；\`fork\` 从原会话最新一条有效
  Agent 回复处分叉后再发送；\`new\` 继承原会话的 Agent、模型和工作目录配置；
- 票据绑定当前插件与卡片所属会话，两分钟有效、只能成功提交一次。runner 失败也
  不退票，避免一次点击被放大成多次收费回合；拿不到 \`userActionToken\` 时不要调用；
- 会话正在工作时不会硬插队，主机会把请求放进该会话的输入队列。最终文字、插件 id、
  插件版本、模板和事件 JSON 会随用户消息一起留存，方便用户知道这轮从哪里来。

只有清单额外声明 \`"agent": { "background": true }\` 时，才可不用当次票据：

\`\`\`js
await cindy.agent.run({
  mode: 'continue',
  trigger: 'background',
  sessionId: rememberedSessionId,
  promptTemplate: '后台任务有新结果：{{user_message}}\\n{{event_json}}',
  userMessage: '请检查并继续',
  event: { jobId: 'job-123', state: 'done' }
});
\`\`\`

后台调用只能使用用户过去点击过你卡片、已与你建立关联的会话；每个插件同时只处理
一条 Agent 请求，后台请求之间至少间隔 10 秒。这个能力可能自动产生模型费用，只在
产品确实需要时申请，不要把 \`sessionId\` 当作任意跨会话控制口。

### 4.11.1 派活取件:让 Agent 替你干活并取回结果(errand)

\`agent.run\` 把回合发进**用户的会话**,结果是给用户看的;派活(errand)相反:
任务在**你的专属 errand 会话**里跑,Agent 的最终回复文字交回**你**手里继续用。
需声明 \`"slots": [..., "agent"]\` + \`"agent": { "errand": true }\`(装入确认高风险单列)。

\`\`\`js
// 提交(默认异步:先拿单号,再轮询取件——Agent 干活是分钟级的):
const r = await cindy.agent.errand({
  task: '阅读工作目录下的 README 并总结要点(200 字以内)',
  // context: { anything: '结构化上下文,主机 JSON 化后附在任务消息尾部' },
  // title: '我的插件 · 代办',   // 仅首次创建对应 errand 会话时用作标题
  // workingDir: repoDir,        // 可选:请求建在某目录(只认用户亲选过的,见下)
  // sessionKey: 'pr-123',       // 可选:分会话钥匙(1–64 位字母/数字/._-)。
  //                             // 不传 = 插件共用一间;同钥匙同间、异钥匙各间,
  //                             // 适合按业务对象各聊各的(如每条 PR 一间,标题
  //                             // 在该间首次创建时用 title 定,正好带上对象编号)
  // mode: 'wait',               // 同步等到完成(30 分钟顶);默认不传 = 异步
  callId: msg.callId,
});
// 受理:{ ok:true, jobId, status:'running', sessionId }
// 轮询取件(建议间隔 ≥5s;做成"提交 + 查询"两个工具让 AI 自己掌握节奏):
const q = await cindy.agent.queryErrand({ jobId: r.jobId });
// 进行中:{ ok:true, jobId, status:'running', sessionId, elapsedSeconds }
// 完成:  { ok:true, jobId, status:'done', sessionId, text, agentKind, model }
// 失败:  { ok:false, errorCode, message }
\`\`\`

主机强制的边界(都不是建议):

- **任务只进普通 user 消息**,绝不进 system prompt;
- errand 会话在**侧边栏可见**,用户可随时旁观、叫停——没有隐身会话;
- 用哪个 agent/模型/思考强度、多大动手权限、在哪个目录干活,全部由**用户**在
  你的插件详情页「AI 代办」卡里配置;缺省跟随用户新建草稿的选择,权限档缺省
  **只读**(不能改任何文件),目录缺省是插件专属文件夹。别假设你能写文件——
  只读档下让 Agent"分析/回答"没问题,"修改"类任务要在文案里引导用户先放开
  权限档;
- 目录有一个受控例外:run 请求可带 \`workingDir\`(绝对路径)**转述**一个目录,
  让 errand 会话建在项目里(Agent 能看到代码)。这不是授权——主机只认用户
  此前在 pick 槽(§4.14)系统选目录窗口里**亲手选过**的目录(主机自己记的
  台账),别的路径一律 \`INVALID_REQUEST\`,此时应引导用户去你的设置页重新
  选一次目录;用户在「AI 代办」卡里配置了目录时,以用户配置优先、本字段忽略;
- 每插件同时 1 单在途、相邻提交至少隔 10 秒;结果超过 64K 字符会截断(尾部带
  标记);完成结果保留 30 分钟,应用重启后查无此单(按可重新提交处理);
  \`sessionKey\` 只是分间,**不放大并发**——不同钥匙的两单同样要排队;
- \`errorCode:'BUSY'\` = 你已有一单在途,或用户恰好正在 errand 会话里说话;
  \`'NO_CANDIDATE'\` 不存在于此——但会话创建/派发失败有 \`'SESSION_UNAVAILABLE'\`,
  超时有 \`'TIMEOUT'\`(任务可能仍在会话里继续,提示用户打开会话查看)。
- 这个能力必然产生模型费用且耗时分钟级:能用快问快答(§4.0.2)解决的,不要派活。

## 4.12 随包 Node 工作进程与 stdio MCP(node 槽)

\`main.js\` 永远还是浏览器沙箱代码。声明 node 槽后，主机额外为**这一段意识**按需
启动一个独立 Node 进程；同一插件的多个会话复用它，不同插件绝不共用进程。通信链固定为：

\`\`\`
Node worker ↔ JSON-RPC stdio ↔ 你的 main.js ↔ Cindy 主机能力
\`\`\`

Node 不能直接拿到 \`cindy\`、Electron IPC 或 Agent 会话。它向主机发反向 JSON-RPC
请求时，主机会固定返回 \`-32601\`；需要 Cindy 能力时，Node 先把数据回给 \`main.js\`，
再由 \`main.js\` 调自己已声明的 cindy / agent / network / fs 等槽，主机照常逐项验权。

### 4.12.1 自定义 Node 服务(JSON-RPC stdio)

这不是“只能做 MCP”。你可以把 worker 当成任意本地 Node 服务，只要用一行一个
JSON-RPC 2.0 对象收发。stdout **只能写协议消息**，日志写 stderr：

\`\`\`js
// node/worker.cjs
const readline = require('node:readline');

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\\n');
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const request = JSON.parse(line);
  if (request.method === 'taptap/connect') {
    const result = await connectTapTap(request.params); // 这里可用完整 Node/CLI 能力
    reply({ jsonrpc: '2.0', id: request.id, result });
    return;
  }
  reply({ jsonrpc: '2.0', id: request.id,
          error: { code: -32601, message: 'Method not found' } });
});
\`\`\`

\`main.js\` 调用：

\`\`\`js
const response = await cindy.node.request({
  method: 'taptap/connect',
  params: { projectId: 'demo' },
  timeoutMs: 30000 // 可选 1000–120000，缺省 30000
});
if (!response.ok) throw new Error(response.message);
const result = response.result;
\`\`\`

#### Node Worker 的持久化凭证绑定

本地 IMAP/SMTP 等协议确实需要 Worker 使用凭证明文时，在
\`node.secretBindings\` 声明凭证键与允许注入的方法。设置页仍只负责收单：

\`\`\`js
// settings.js:输入框里的值立即交给主机 safeStorage,不要进 /kv / 日志 / BroadcastChannel
await fetch('/secrets/mail_code', {
  method: 'PUT',
  body: JSON.stringify({ value: authorizationCode })
});
// GET /secrets 只能看到 { key:'mail_code', saved:true, tail? },永远没有明文
\`\`\`

浏览器 \`main.js\` 发给 Node 的业务参数里不要放凭证：

\`\`\`js
await cindy.node.request({
  method: 'mail/action',
  params: { action: 'search', query: '账单' }
});
\`\`\`

宿主现查清单，只有 method 与目标 entry 同时命中绑定时，才从 safeStorage
读取本插件自己的键，并在发往 Worker 的 JSON-RPC 保留字段中临时注入：

\`\`\`js
// worker 收到的 request；cindy 字段由宿主铸造，main.js 自报同名字段会被忽略
const authorizationCode = request.cindy.secrets.mail_code;
\`\`\`

规则与红线：

- \`secretBindings\` 最多 4 条，每条 \`methods\` 1–16 个；省略 \`entry\`
  只绑定主入口，不能借同名方法把凭证送去其它入口；
- 未保存凭证时宿主在请求进入 Worker 前返回 \`PERMISSION_DENIED\`，设置页可用
  \`GET /secrets\` 的 saved 状态引导用户；
- 宿主不会直接把明文交给 \`main.js\`、Agent 参数或写入宿主日志；但 Worker
  收到明文后可以主动回传、落盘或写日志，浏览器侧代码和 Agent 也可能因此间接
  获得它。安装/更新权限清单会逐条披露此风险，只安装可信来源插件；
- Worker 用完不要缓存、落盘、回传或写日志；每次请求都以
  \`request.cindy.secrets\` 的当次值为准；
- \`node.secretBindings\` 与 \`network.secrets\` / \`network.connections\`
  共用插件内凭证键命名空间，撞名拒装；声明它必须同时提供 \`settingsHtml\`。

长任务(构建/打包这类几分钟量级的活)加 \`maxTotalMs\` 开启**有动静就续期**:
\`timeoutMs\` 变成"沉默窗口"——worker 只要还在输出(stdout 协议消息或 stderr
日志)就不断续期,绝对上限 \`maxTotalMs\`(最长 15 分钟):

\`\`\`js
const built = await cindy.node.request({
  method: 'build/run',
  params: { projectId: 'demo' },
  timeoutMs: 60000,     // 沉默 60 秒判死
  maxTotalMs: 900000    // 就算一直有动静,最多也只等 15 分钟
});
\`\`\`

worker 侧配合:干长活时定期发进度 notification(或往 stderr 打日志)即可;
彻底静默超过 timeoutMs、或总时长到 maxTotalMs,都会收到 TIMEOUT。mcp-stdio
的 \`tools/call\` 同样适用(MCP 进度通知天然就是"动静")。

多进程:在 \`node.entries\` 申报额外入口后,\`cindy.node.request\` 带 \`entry\`
指名调用(缺省 = 主入口 \`node.entry\`);每个入口一个独立进程、独立空闲回收,
协议与生命周期声明全体共用:

\`\`\`js
const built = await cindy.node.request({
  entry: 'node/build.cjs',           // 必须逐字命中 node.entries,否则整单拒
  method: 'build/run',
  params: { projectId: 'demo' }
});
\`\`\`

worker 可以发不带 id 的 notification 报进度，主机会转成 main.js 的
\`node-notification\` 事件；进程启动/停止/崩溃会转成 \`node-status\`(额外入口的
状态事件带 \`entry\` 字段,主入口不带)：

\`\`\`js
// worker
reply({ jsonrpc: '2.0', method: 'progress', params: { percent: 50 } });

// main.js
cindy.onHostMessage((msg) => {
  if (msg.type === 'event' && msg.name === 'node-notification') {
    // msg.method / msg.params
  }
  if (msg.type === 'event' && msg.name === 'node-status') {
    // msg.state = starting / running / stopped / crashed
  }
});
\`\`\`

### 4.12.2 stdio MCP

把 \`protocol\` 改成 \`"mcp-stdio"\`，worker 实现标准的逐行 JSON-RPC MCP server。
Cindy 会统一完成 \`initialize\` + \`notifications/initialized\`，你的 main.js 不要重复初始化，
直接调用标准方法：

\`\`\`js
const listed = await cindy.node.request({ method: 'tools/list', params: {} });
const called = await cindy.node.request({
  method: 'tools/call',
  params: { name: 'build_game', arguments: { projectId: 'demo' } }
});
\`\`\`

MCP server 的 sampling / elicitation / roots 等 server→client 反向请求第一版不开放；需要
这类能力时仍按“结果回 main.js，再由 main.js 申请 Cindy 槽”的链路设计。

### 4.12.3 打包和生命周期红线

- 用户不需要安装 Node、npm、CLI 或 MCP。运行时由 Cindy 随包提供；你必须在制作阶段
  把依赖打成单个 worker 文件或连同静态资源放进目录；**禁止**在安装/首次运行时执行
  \`npm install\`、\`npx\`、\`postinstall\` 或从网络下载可执行代码；
- Forge 会跳过 \`node_modules\`，推荐用 esbuild/rollup 预打包成 \`worker.cjs\`。Node 包
  最多 2048 个文件、解压后 256MB、.cindy 128MB；超限直接拒绝；
- \`on-demand\` 首次 \`cindy.node.request\` 才启动，缺省空闲 120 秒关闭；停用、更新、
  卸载、退出 Cindy 都立即关闭。\`resident\` 会随插件启用一直运行，安装确认里单独显示；
- 每个插件最多 32 条在途请求；单次 params 256KB、单行 stdout 1MB。单次请求缺省
  30 秒、上限 120 秒;长任务用 maxTotalMs 开启"有动静就续期",绝对上限 15 分钟
  (见 §4.12.1)。进程崩溃只影响
  自己，所有在途请求收到结构化失败，下次请求可重新启动；
- **最重要的安全事实**：Node 进程不是浏览器沙箱，它拥有当前登录系统账号能拿到的
  本机权限，能读写文件、联网、起别的进程。安装时先展示权限清单，真正写盘前还会
  由 Cindy 主进程弹出一次系统级强风险确认；
  不需要本机能力的插件不要申请 node 槽。

### 4.12.4 宿主代启子进程(childSpawn)

有些库(如 \`@taptap/maker\`)会在肚子里自己 \`spawn(process.execPath, [脚本, 参数])\`
——在 Cindy 的 worker 里这条路是死路(正式包关 RunAsNode,生出来的不是 Node)。
声明 \`"childSpawn": true\` 后,worker 里多一个全局窄接口,可以请宿主**代启**一个
已申报入口的原样 stdio 子进程:

\`\`\`js
// worker 里(仅普通 worker 模式有;子进程里没有——树深恒为 1)
const child = await globalThis.__CINDY_NODE__.spawnEntry(
  'node/maker.cjs',                 // 必须逐字命中 node.entry / node.entries
  ['__maker-proxy']                 // 启动参数(≤16 条、单条 ≤2048 字符),
);                                  // 子进程看到的 argv 就像被 node 正常启动
child.stdout.on('data', (buf) => { /* 字节原样到手 */ });
child.stdin.write('{"jsonrpc":"2.0",...}\\n');
child.on('exit', (code) => { /* 级联生死:worker 停,孩子必停 */ });
child.kill();
\`\`\`

给第三方库改道的惯用垫片——在 require 它**之前**打补丁:

\`\`\`js
const cp = require('node:child_process');
const realSpawn = cp.spawn;
cp.spawn = (cmd, args, opts) => {
  if (cmd === process.execPath) {
    // 把 [脚本绝对路径, ...其余参数] 映射到申报入口 + 参数
    return wrapAsChildProcess(globalThis.__CINDY_NODE__.spawnEntry('node/maker.cjs', args.slice(1)));
  }
  return realSpawn(cmd, args, opts);
};
const maker = require('@taptap/maker'); // 之后它的自启动全部走了正道
\`\`\`

红线与钳制:

- 只能启动 \`node.entry\` / \`node.entries\` 里**逐字申报过**的 JS——这不是任意
  命令执行,连 node 命令行参数都不存在;
- 每插件同时在世的子进程最多 4 个;子进程不能再生孙进程(接口只在 worker 有);
- stdio 由宿主纯字节中继(base64 帧,不参与 JSON-RPC 协议、不受逐行检查),
  但**只适合文本/协议流**,别拿它传大文件;
- 级联生死:worker 退出/被停/插件停用,子进程一并收掉,不留孤儿。

## 4.13 会话上下文(session-context 槽)

围着用户项目干活的插件(构建/检查/同步类)需要知道"现在是哪个会话、项目在哪个
文件夹"。声明 \`session-context\` 槽后,agent 派活(tool-call)时主机把**宿主铸造**
的上下文注入 \`args.session_context\`:

\`\`\`js
cindy.onHostMessage(async (msg) => {
  if (msg.type !== 'tool-call') return;
  const ctx = msg.args.session_context;
  // ctx = { session_id, workdir, workdir_is_local, workdir_is_read_only }
  if (ctx?.workdir_is_local && !ctx.workdir_is_read_only && ctx.workdir) {
    // 只有本地且非只读时才能把 workdir 交给 Node 侧修改
    await cindy.node.request({ method: 'project/build', params: { dir: ctx.workdir } });
  }
});
\`\`\`

规则与红线:

- 注入只发生在**主机侧**:agent 或任何上游自报的 \`session_context\` 一律被主机
  剥除后重铸——你拿到的字段永远可信,不需要再验;
- \`workdir_is_local\` 是安全核心:会话跑在 SSH 远程工作区(或主机证明不了是本地)
  时为 \`false\`,此时 \`workdir\` 是远端路径,**绝不能**当本机路径读写——同名本机
  目录可能存在,写下去就是事故;
- \`workdir_is_read_only\` 来自宿主对会话 permission / plan 状态的统一裁决;
  为 \`true\` 时只允许检查、列举等只读操作,不得初始化、构建或以其它方式修改 workdir;
- 这只是"位置信息",不是文件访问权:读写仍走 fs 槽 / node 槽各自的守门;
- 未声明本槽的插件,args 里永远没有 \`session_context\` 字段。

## 4.14 目录选择(pick 槽)

需要用户交一个文件夹进来(导入/同步/部署源)时,声明 \`pick\` 槽,经管子请主机
弹**系统级**选文件夹窗口——用户亲手选中即授权,取消则你什么都拿不到:

\`\`\`js
const picked = await cindy.pick({
  mode: 'directory',
  title: '选择要同步的项目父目录',   // 净化后随插件名一起展示(≤80 字)
  deposit: true                       // 需要过户票据(上传用)时带;声明了 node 槽可省
});
if (picked.ok) {
  // picked.name        —— 所选目录名(展示用)
  // picked.path        —— 绝对路径,仅声明了 node 槽的插件有(交给 Node 侧干活)
  // picked.dir_deposit —— 过户票据(同 ghost_call dir 通道;deposit:true 才有)
}
\`\`\`

规则与红线:

- 对话框由主机拼装并带你的插件名,\`title\` 只是用途说明片段,伪装不了主机文案;
- 同一插件两次请求最小间隔 3 秒、全局同时只有一个选择框(超了回 RATE_LIMITED /
  BUSY);用户取消回 CANCELLED——**尊重取消,不要循环重弹**,那是骚扰;
- 未声明 node 槽的插件必须 \`deposit: true\`(没有票据你什么都拿不到,请求会被拒);
  票据收集有上限(500 文件/单文件 50MB/总 256MB),超限会签发失败;
- \`path\` 只发给声明了 node 槽的插件:Node 侧本就有用户级本机权限,给路径不扩权,
  价值是把"用户选了哪个目录"这一事实可信地交过去;
- 用户每次亲选成功,主机自己也会记一笔「亲选目录台账」(每插件最近 8 条)——
  派活(§4.11.1)的 \`workingDir\` 转述只对台账里的目录放行。台账建立在真实
  点选上,你存在 /kv 里的路径不算数。

## 4.15 面板预览(preview 槽)

部署预览、本地 dev server、控制台面板这类"给用户看个网页"的需求,声明 \`preview\`
槽 + \`preview.hosts\` 白名单(见 §2),运行期请主机在右侧栏内置浏览器开标签:

\`\`\`js
const opened = await cindy.preview({
  url: 'https://demo.example.dev/build/123',
  sessionId: ctx?.session_id            // 可选:落到哪个会话的右侧栏;缺省当前会话
});
if (!opened.ok) console.warn(opened.errorCode, opened.message);
\`\`\`

规则与红线:

- URL 必须命中装入时钉死的 \`preview.hosts\` 白名单:只收 https(http 仅限
  localhost / 127.0.0.1 本地开发),不收 URL 内嵌凭证;范围外回 URL_NOT_ALLOWED,
  **改白名单只能发新版本重新过装入确认**;
- 同一插件两次打开最小间隔 5 秒(RATE_LIMITED)——预览是"结果亮相",不是刷屏
  通道;
- 每次打开,宿主都会弹带你身份头的提示("xxx 打开了一个预览页面"),用户永远
  知道页面是谁开的;
- 标签开在用户自己的右侧栏浏览器里,关不关、看不看由用户决定。

## 4.16 捆绑 Agent Skills(skill 槽)

想让插件"自带一份教 Agent 怎么用好自己的说明书"(或任何领域技能),把技能目录
随包携带并声明 \`skill\` 槽 + \`skill.items\` 详单(见 §2)。装入且启用后,主机把
每个技能目录链接进共享技能根 \`~/.agents/skills/<插件id>--<技能name>\`(Windows 用
junction),Claude Code 与 Codex 都能自动发现——不复制字节,插件更新技能跟着更新,
停用/卸载即撤链。

目录形态(每条 item 一个目录,内必须有 SKILL.md):

\`\`\`
my-ghost/
  ghost.json
  main.js
  skills/
    my-skill/
      SKILL.md        ← frontmatter 必须有 name + description
      reference.md    ← 可选:技能附带的其它文件一并随链接可见
\`\`\`

SKILL.md 硬规则(打包与装入双侧强制,任一不满足直接拒):

- frontmatter 的 \`name\` / \`description\` 必须与 \`skill.items\` 声明**逐字一致**
  ——装入确认框展示的是清单声明,Agent 读到的是 SKILL.md,两者必须是同一份事实;
- \`name\`:小写字母/数字加单连字符分段(禁首尾/连续连字符),≤64 字符;
- SKILL.md 单文件 ≤64KB;items 最多 4 条。

正文开头建议写一段**环境守卫**(非强制,但强烈建议):技能挂进的是**共享**技能根,
用户在 Cindy 之外直接跑 Claude Code / Codex 时同样会看到你的技能,而那里没有插件
通道。Agent 读完正文自然会发现调不动 \`ghost_call\`,但很容易转头用 shell 自己实现
一个"看起来像"的替代品——这段守卫拦的就是这个。放在 H1 标题之后的第一段
(Agent 从头读正文):

\`\`\`markdown
> **本技能属于 Cindy 插件 \`<插件 id>\`:动手前先看工具列表,没有名字含 \`ghost_call\`
> 的工具就说明不在 Cindy 中,本技能不可用。** 此时不要执行任何步骤,也不要用 shell
> 或别的工具自己实现一遍——能力在插件的运行时里,替代品做不出等价产出。直接告诉
> 用户「这个技能需要在 Cindy 客户端里使用」,然后停下。
\`\`\`

- 判据只写"名字含 \`ghost_call\`",**不要写某个引擎的工具名全称**:Claude Code 与
  Codex 的 MCP 工具名前缀不同,写死一边会让另一边误判成"不在 Cindy";
- 写在正文里,**不要塞进 frontmatter \`description\`**:description 每个会话都常驻
  上下文,正文只在技能被激活后才读,守卫写正文不花常驻预算;
- 一个插件多条 item 时每份 SKILL.md 各写各的(技能之间互相看不见);
- 技能正文是英文时照译一份,别中英混排。

信任与作用域(如实告知用户,也请作者自重):

- 技能指令由**主 Agent 以用户全部权限执行**,对所有项目、所有会话生效,
  **不受插件沙箱约束**——这是十五个卡槽里信任面最高的能力,装入确认框会把
  每个技能置顶逐条列出;
- 技能跟随插件的**全局**启用状态:仅在某个工作目录停用插件**不会**隐藏技能,
  只有全局停用或卸载才撤链(本期只有全局作用域);
- \`skill.items\` 的字段不参与 locales 本地化(必须与 SKILL.md 逐字一致,而
  SKILL.md 只有一份)。
## 4.17 创建工作区会话(workspace 槽)

需要把某个项目目录变成侧边栏里的会话入口("打开项目"/仓库列表这类场景)时,
声明 \`workspace\` 槽,经管子请主机**确保**该目录下存在一个会话:目录下已有
active 会话直接复用(created:false),没有才创建一个空会话,创建/命中后显示在
侧边栏对应工作区分组里。

面板里由用户点击发起(推荐,用户在系统窗口亲选目录即授权):

\`\`\`js
const ensured = await cindy.workspace({
  kind: 'ensure-session',
  mode: 'pick',                    // 主机弹系统选文件夹窗口
  title: '选择要打开的项目目录',    // 用途说明(≤100 字),也用作新会话标题
  focus: true                      // 可选:创建/命中后跳转聚焦到该会话,缺省只落侧边栏
});
if (ensured.ok) {
  // ensured.sessionId —— 会话 id
  // ensured.created   —— true = 新建;false = 命中已有会话复用
  // ensured.name      —— 目录名(展示用;绝对路径不会给你)
}
\`\`\`

处理 ghost_call 工具调用期间已经拿到目录路径时,可改用 dir 模式,带上本单 callId:

\`\`\`js
// main.js 的 tool-call 处理器里(msg.callId 是主机随单下发的)
const ensured = await cindy.workspace({
  kind: 'ensure-session',
  mode: 'dir',
  dir: '/Users/me/projects/demo',  // 本机绝对路径
  callId: msg.callId               // 主机铸造的上下文凭证,只在本单在途期间有效
});
\`\`\`

规则与红线:

- \`mode:'pick'\` 的授权动作是用户亲手选中,取消回 CANCELLED——**尊重取消,不要
  循环重弹**;绝对路径不回沙箱,你只拿到目录名与会话 id;
- \`mode:'dir'\` 只能在处理 ghost_call 期间用:callId 配对失败回 PERMISSION_DENIED;
  目录在发起会话的工作目录内自动放行,之外弹确认卡由用户决定(拒绝/超时回
  CANCELLED,不要重试,如确有需要先与用户沟通);目录必须真实存在
  (DIR_NOT_FOUND / NOT_DIRECTORY);
- 只支持本机目录,远程(SSH)工作区一律拒;
- 同一插件两次请求最小间隔 3 秒、全局同时只有一个窗口/确认卡在场(RATE_LIMITED /
  BUSY);
- 创建的是**空会话**:不拉起 agent、不发消息、不自动开始任何任务;要让 Agent
  立即干活请配合 agent 槽(§4.11)。

## 4.18 确认弹窗(confirm 槽)

动手之前要用户点头(切分支、覆盖文件、发不可撤回的东西)时,声明 \`confirm\` 槽,
经管子请主机弹一个**和 Cindy 自己一模一样**的确认框,并拿回用户的真实点击:

\`\`\`js
const r = await cindy.confirm({
  body: '把项目目录从 main 切到 fix/xxx 分支?你没提交的改动可能被带走。',  // 必填,≤300 字
  confirmText: '切换',      // 可选,≤12 字;不给就用主机缺省的「确认」
  cancelText: '先不切',     // 可选,同上上限;不给就用主机缺省的「取消」
  danger: true              // 可选,危险动作(删除/覆盖/改用户文件)主按钮变红
});
if (r.ok && r.confirmed) {
  // 用户点了主按钮 → 干活
} else if (r.ok) {
  // 用户点了取消 / 按了 Esc / 点了弹窗外面 → 什么都别做,也别再弹一次
} else {
  // r.errorCode: PERMISSION_DENIED / INVALID_REQUEST / RATE_LIMITED / BUSY /
  //              UNAVAILABLE / INTERNAL —— 这是"没问到",不是"用户拒绝"
}
\`\`\`

规则与红线:

- **\`ok:true\` 只代表问到了,答案看 \`confirmed\`**。把 \`ok\` 当同意是最常见的写错法;
- 弹窗的壳、标题(主机文案「插件「你的名字」请你确认」)与身份头(你的图标+名字)
  **由主机画**,身份取自已装清单而不是你自报;你只供 \`body\` 与按钮字,且会被净化
  (控制字符剥除)+ 卡长度。**伪装不了主机文案、冒充不了别的插件,也点不了自己的
  按钮**——点击链路主机独占;
- 同一插件两次请求最小间隔 3 秒(RATE_LIMITED),**全局同时只有一个确认框**
  (BUSY,不排队)。模态框比提示更打扰人,排队就是骚扰队列;
- 没人应答 90 秒 → 当成**没同意**。同理:没有可挂靠窗口回 UNAVAILABLE。一切
  "问不出来"的情况一律 fail closed,你收不到假的同意;
- **尊重取消**:用户点了取消就别换个说法再弹一次。反复弹会撞上限速,也会让用户
  直接停用你;
- 没有「下次不再提示」,也没有三选一和复选框:确认的价值就在于每次都是真点击,
  给了"永久免问"等于没确认;
- **桌面独占**:本机弹窗不进远程/手机版通道(平台白名单里属永不放行类别)。手机端
  或远程控制端跑到这里会拿到失败分档,你的逻辑要能接住(当"没同意"处理);
- 真正的守门仍在你自己手里:确认只是问一句,**该校验的前置条件(文件在不在、
  工作区干不干净)确认前后都要自己再查一遍**——用户点确认和你真动手之间,
  世界可能已经变了。

## 5. 面板(panel.html/css/js)

- 显示形态由 \`panel.position\` 决定:\`left\`(缺省)= 停靠主聊天窗左侧的常驻
  面板(\`right\` 已退役:右侧是右侧边栏的地盘,旧包声明 right 自动并入 left,
  用户想放右边可自己拖拽换位);\`"tab"\` = **插件页内的独占面板**——由插件页
  自己承载(不进右侧栏页签容器):用户在插件页点你这张卡的「使用」按钮打开,
  同一时刻至多一个,**用户离开插件页即关闭卸载**(面板收束,2026-08-02 定案:
  插件面板不再常驻右侧栏干扰其它会话)。装入时勾选「立即开启并打开面板」会
  在装完后进入插件页并打开你的面板;不勾选则由用户之后自己从插件页点「使用」。
  停用/卸载插件同样立即关闭面板。页签形态没有拖缝宽度语义,声明 \`minWidth\` /
  \`defaultFraction\` 会被拒装。两种形态的面板代码完全一样(同一 panel.html,
  供片/主题/媒体规则不变),只是宿主容器不同;此形态请把界面做成自适应宽度,
  并且**不要假设自己会在后台长期存活**——每次打开都可能是全新加载,状态要
  自己持久化(见 §4.6 的偏好存储);
- 停靠形态的**标题条(标准头)由主机绘制**:标题(\`panel.title\`)+ 一批系统
  按钮(当前:「撑满内容区」、「在独立窗口中打开」——用户可把你的面板抽进
  自己的 OS 窗口,关窗/合并即回停靠原位——以及「最小化为浮动气泡」——用户
  可把面板收成一枚可拖动的圆形气泡悬浮在主窗最上层,点击气泡即回停靠原位,
  气泡位置与最小化状态重启保留;三者面板代码全程零感知;后续新增的系统按钮
  也长在这里)。你的 panel.html 只画标题条以下的部分,**不要自己再画一条
  标题栏**。不想要某颗系统按钮时在身份卡声明
  \`"systemButtons": { "maximize": false, "detach": false, "minimize": false }\`
  逐个关闭(缺省全开;标题条本体关不掉;未知键拒装;\`position:"tab"\` 由插件页
  自绘头,没有这套标准头,声明本字段拒装);
- 与电子脑同源,用 \`BroadcastChannel('<自定名>')\` 通信(电子脑发,面板收);
- 取自己的媒体:\`cindy-ghost://<id>/media/<指纹><后缀>\`(主机查账验归属,别人的图 404);
- 重启回放:\`fetch('cindy-ghost://<id>/gallery')\` 返回本意识作品清单 \`[{src, caption}]\`;
- 唤醒电子脑:\`fetch('cindy-ghost://<id>/wake')\`(幂等,已在跑立即返回,回
  \`{state}\`)。电子脑是按需拉起的,面板刚打开时它多半没在跑、广播没人听;
  面板交互要经电子脑干活(BroadcastChannel 递活再转 cindy-request)时,先
  fetch 一次 /wake 叫醒,再广播请求,并按 reqId 每几百毫秒重发直到收到电子脑
  回执(电子脑侧记得按 reqId 去重)。只能叫醒自己;沉睡/熔断态叫不醒;
- 点开看大图/播放:把 \`<img>\` 或视频缩略(\`<video muted>\` 记得配
  \`style="pointer-events:none"\` 让点击落在链接上)包进
  \`<a href="cindy-ghost://<id>/preview/<指纹><后缀>">\`(即把 /media/ 换成
  /preview/),用户点击时主机按媒体类型弹统一 lightbox:图片(缩放/标注/另存)
  或视频播放器。主机查账验归属;需用户真点击(面板持焦点)才弹,脚本自动跳转
  会被静默忽略,不要用它做任何"主动弹窗"。按此写法的媒体 cell 主机还免费送
  右键菜单(复制文件 / 打开所在目录,与聊天里的媒体右键同款),面板零改动。
- 拖进聊天:面板图片和视频都可被用户拖进聊天输入框落为附件(主机查账验归属;
  图片落图片附件给模型看,视频落文件附件、发送时以文件路径交给 AI 处理)。
  给可拖元素挂 dragstart 把自己的 /media/ 地址塞进 uri-list 即可:
  \`el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/uri-list', src))\`
  (直接拖上面那个 /preview/ 链接也认)。落进的只是附件托盘,发不发由用户决定。
  建议同时 \`e.dataTransfer.setDragImage(imgEl, offsetX, offsetY)\` 用缩略图当拖影
  ——不设的话拖链接的默认拖影是一条 URL 文字,很丑。视频缩略的拖影把首帧画进
  canvas(\`<video>\` 元素直接当拖影常拍成黑块)。
- 主题:直接用主机注入的 CSS 变量并给回退值,如 \`var(--panel-bg, #f7f7f5)\`、
  \`var(--surface, #f7f7f5)\`、\`var(--text-primary, #1a1a1a)\`、
  \`var(--border-default, #e4e4e0)\`;面板/侧边栏背景用 \`--panel-bg\`(已注册,
  alias 到 --surface,与宿主面板同源);
- **明暗档主机已代你声明**:注入块里带了 \`color-scheme: light|dark\`(跟宿主主题
  实时切),所以你不写一行样式,原生控件(滚动条、\`<input>\`/\`<select>\`/复选框、
  日期选择器)也会落在正确的明暗档上。别自己写死 \`color-scheme\`,否则暗色主题下
  这些控件会反档;真要覆盖就跟着主机主题一起换;
- 滚动条统一规范:12px 槽 + 6px 圆角 thumb,滚动时加 \`.is-scrolling\` 显形
  (颜色用 \`var(--msg-scrollbar)\` / \`var(--msg-scrollbar-hover)\`),2 秒无活动移除。

## 6. 沙箱红线(平台结构保证,写了也没用)

- **本节说的是 main.js 浏览器电子脑**:它无文件系统、无 Node API、默认无网络——
  即使另申请 node 槽，Node 也在独立进程里，只能经 §4.12 的 stdio 与 main.js 交换数据，
  不会把 require/process 等能力注入 main.js。想用 AI/出图走 cindy-request 求主机代办,
  想访问自带服务走 network 槽经主机代发(仅限详单白名单域名,见 §4.7),想落盘
  走 fs 槽请主机代写(仅限三档目的地,见 §4.10),沙箱内直连(fetch/XHR/
  WebSocket)与直接读写磁盘永远不存在,声明了槽也一样——槽给的是"请主机
  代办"的资格,不是能力本身;
- 保险库里的凭证明文永不进沙箱:network 槽的 key 由主机保管注入,你的代码
  读不回(主机 Setup 卡直接交保险库；settingsHtml 收单时明文只在录入瞬间路过
  你的页面,经 /secrets 交给主机即焚,之后同样拿不到;状态回查最多附尾 4 位
  指纹,重建不出值);
- 只经手字符串(指纹/地址),拿不到任何磁盘路径;
- 改图只能改**本意识名下**的媒体:自己生成的、用户过户给你的
  (\`args.attachments\`)、以及你寄存进来的(§4.0.1 \`deposit_media\`)。
  别人名下的一律不认(主机查账,越权统一 404/拒绝);
- 崩溃只影响自己的面板(错误接管态),反复崩会被熔断。

## 7. 打包与测试

1. 新插件先调 \`ghost_forge_scaffold\` 生成骨架，或把已有源码放在用户工作目录下的
   一个文件夹里(如 \`my-ghost/\`)；脚手架目标必须是新目录，绝不覆盖已有文件；
2. 调 \`ghost_forge_pack({ dir: '<绝对路径>' })\`——校验 + 打包 + 弹装入确认框;
   产物落在源码目录里(\`<id>-<version>.cindy\`,同版本覆盖,下次打包自动跳过);
3. **告知用户去点弹窗**(装入默认沉睡,提醒用户勾"立即开启"或到主界面侧边栏「插件」中唤醒);
4. 改代码后重新 pack:同 id 会弹"更新 vX → vY",唤醒状态与面板位置自动保留
   (记得 bump ghost.json 的 version);
5. 验证:让用户 \`$<command> <内容>\` 试一单,看聊天图卡/面板是否符合预期。

## 8. 发布签名与审核

\`ghost_forge_pack\` 默认只负责本地制作和试装，生成的是**未签名包**。未签名不等于
一定有问题，用户仍可安装，但界面会明确显示“未验证”。正式对外发布时由商店或发布
流水线在包根加入 \`cindy-signatures.json\`，不要让当前对话里的 Agent 代管正式私钥。

签名使用 Ed25519，分两层：

- **发布者签名**覆盖插件 id、版本、发布者名称/公钥，以及每个文件的路径、大小和
  SHA256。它证明包里的文件和显示身份在签名后没有被改，也证明不同版本由同一把
  发布者私钥签出；只有发布者公钥已进入 Cindy 信任表时，界面才会显示“发布者已验证”；
- **Cindy 审核签名**再覆盖准确版本的文件清单和发布者签名。只有审核公钥属于 Cindy
  信任表且签名有效时，界面才会显示“此版本已审核”。改一行代码或改版本号都必须重新
  发布、重新审核，旧版本的审核不能借给新版本。

钥匙的分工必须守住：

- 私钥像保险柜钥匙，只留在发布者机器的安全存储或受保护的 CI；不能放进插件源码、
  \`.cindy\`、Git、聊天消息，也不要让 Agent 读取、生成或回显正式私钥；
- 公钥像公开印章样本，可以公开并提交给 Cindy 的发布者/审核信任表；客户端只需要
  公钥验签，永远不需要私钥；
- 包里自带但未进入信任表的发布者公钥，只能证明“文件没改、还是同一把钥匙”，不能
  自己证明现实身份。签名文件一旦存在却损坏或对不上文件，客户端会直接拒装，不能
  偷偷降级成未签名包。

界面最终会区分:Cindy 随包官方、此版本已审核、发布者已验证、未验证/无签名。正式
签名和审核应由商店/发布流水线完成；本地 Forge 不替用户生成或保存正式密钥。

### 8.1 发布到官方插件仓的额外门禁

要提交到官方插件仓 \`makecindy/cindy-official-plugins\` 的插件,除本手册的打包/装入
校验外还有仓级 CI 硬门禁,过不了整次发布被拦:

- **四语言 locale 缺一不可**:\`locales\` 必须**恰好**包含 \`zh-CN\` / \`en\` / \`ja\` /
  \`ko\` 四份,且每份都完整覆盖 \`name\` / \`description\` / \`whenToUse\` 与**全部**
  \`tools[].description\`(工具键集合与清单逐一对齐)。注意这比 §2.1 的本地门槛
  (「声明 locales 时英文必须存在、翻译可部分提供」)严格得多;
- **图标**:惯例统一放 \`assets/icon.png\` 并在清单声明 \`icon\` 字段,不要散落在
  包根;
- 其余要求(目录命名、审核流程等)以该仓根部的 \`CONTRIBUTING.md\` 为准,提交前
  在仓内跑一遍 \`node --test .tests/\` 自查。

## 9. 常见拒装原因速查

- \`id\` 不合法(大写/下划线/超长)· 声明了 command 但没有 tools · command 与已装意识撞名
  · **未声明 command**:不拒装,但插件页"使用"按钮禁用,用户无法通过插件页一键启用
    或用 $command 点名;AI 工具调用不受影响(见 §2 说明)
- 声明了 tool 槽但缺 tools(或反之)· panel.html 声明了但 slots 没有 "panel"
- settingsHtml 路径不合法/文件不在包里 · settingsHeight 越界(160–800)或没配 settingsHtml 单独声明
- panel.systemButtons 格式错(不是对象、未知键、值非布尔,或 position:"tab" 时声明——插件页内面板没有标准头)
- keywords(已废弃字段,旧包兼容保留,新意识别写)有单字词 · kind 写了但不是 "chip"(可省略) · schemaVersion 不是 2
- cindy 详单格式错(未知类目/动作、空数组、有详单但 slots 没有 "cindy")
- agent 详单格式错(有详单但 slots 没有 "agent"，或 background / errand 都不是 true；只需点击触发时应省略 agent 字段)
- node 详单格式错(槽/详单不成对、entry 不是包内 CommonJS .js/.cjs、protocol 不在 json-rpc-stdio / mcp-stdio、
  写了 command/args/shell/env、resident 又写 idleTimeoutSeconds)
- id 用了 \`cindy-\` / \`filo-\` / \`xd-\` 前缀(官方保留,正式版用户通道拒装;给自己的意识换个前缀)
- network 详单格式错(hosts 缺失/裸 TLD/IP/带端口/通配不在最左、secret 缺 inject、
  inject.format 没有 {value} 占位、inject.header 用了 Host/Cookie 等协议关键头、
  inject.hosts 不是 hosts 声明条目的子集、有详单但 slots 没有 "network"、
  secret.source 不是 "user"/"login-email"/"oauth"、
  source:"login-email" 还声明了 url 或 exchange、
  声明了 user 凭证但没声明 settingsHtml、遗留 input 字段值不是 "ghost")
- exchange 声明格式错(url 非 https/域名不在 hosts 白名单、bodyFormat 不是恰含一个
  {value}、contentType 不在白名单、tokenPath 不是点分路径、ttlSeconds 越界)
- oauth 声明格式错(source:"oauth" 缺 oauth 详单或反之、与 exchange 同时声明(互斥)、
  authorizeUrl/tokenUrl 非 https 或域名不在 hosts 白名单、scopes 条目含空白/重复、
  extraAuthorizeParams 覆写保留参数(client_id/redirect_uri/state/code_challenge 等)、
  redirectPort 不是 1024–65535 整数、tokenBroker 与 clientSecret 同时声明、
  clientIdAlternatives 没与 clientId + tokenBroker 成套或包含重复/非法 ID、
  非官方前缀 id 声明了 tokenBroker(仅第一方可用)、brokerBounce 没和 tokenBroker +
  redirectPort 成套声明或路径不是 / 开头的站内绝对路径)
- connections 声明格式错(超 2 条、key 撞 secrets 的 key 或声明内重复、label 缺失/超 64 字、
  inject 缺失/format 没有 {value}/header 用了协议关键头、**声明了 inject.hosts**(连接
  凭证恒只注入对应连接自身地址,不接受收窄/扩张)、maxConnections 不是 1–8 整数、
  声明了 connections 但没声明 settingsHtml(没人收地址和 token)、hosts 与 connections
  双双缺席(静态域名与动态连接至少有其一))
`;
