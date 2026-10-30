/**
 * forge.ts — 意识锻造(agent 帮用户做意识的主机真身,2026-07-11 Lizi 定案)。
 *
 * 两件事,全部纯 Node(零 Electron 依赖,单测直喂目录,规则 14):
 * - FORGE_GUIDE:兼容导出内置 cindy-plugin-creator Skill 的编写手册,
 *   ghost_forge_guide 与 Skill 读取同一份随主机发布的文档;
 * - packGhostDir:源码目录 → 校验(与装入同一套 validateGhostManifest)→
 *   打包 .cindy 到源码目录自身(id-version.cindy,同名覆盖;shouldSkip 跳过
 *   *.cindy 防套娃),并同时返回内存里的 `buf`。作者副本给人拿走;安装链路
 *   必须用 `buf` 直写 Host staging,不能从源码目录回读。打包与发布编排由
 *   调用方(mcp-integrations 接线)处理,本文件不碰 UI。
 *
 * 安全边界:agent 能写意识源码(它本来就有文件工具),但打包与装入都必须过
 * 同一套清单/真实包校验；首装与权限变多的更新还要用户在任务里确认(ghostInstallConsent.ts)。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';

import JSZip from 'jszip';

import {
  authorDeclaredNamespaceReason,
  PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES,
  PLUGIN_MEMBER_UPLOAD_MAX_UNCOMPRESSED_BYTES,
  PLUGIN_MEMBER_UPLOAD_MAX_ZIP_ENTRIES,
} from '@cindy/plugin-protocol';

import {
  GHOST_ICON_MAX_BYTES,
  GHOST_INSTALL_MANIFEST_MAX_BYTES,
  GHOST_MANUAL_ENTRY_FILE,
  GHOST_MANUAL_MD_MAX_BYTES,
  GHOST_MANIFEST_FILE,
  GHOST_SKILL_MD_MAX_BYTES,
  isValidNewGhostId,
  validateGhostManifest,
  type GhostManifest,
} from '../../shared/ghost.js';
import {
  GHOST_MANIFEST_MAX_BYTES,
  readBoundedFileNoFollow,
  readBoundedFileNoFollowWithStat,
} from '../utils/readBoundedFile.js';
import {
  decodeGhostManualMarkdown,
  ghostManualLogicalPathForEntry,
} from './ghostManualValidation.js';
import { validateGhostLocaleResourcesInDirectory } from './ghostLocaleFiles.js';
import { GHOST_SIGNATURE_FILE } from './ghostSignature.js';
import {
  ARCHIVE_REGULAR_0644,
  unixRegularFilePermissionsForArchive,
} from './ghostZipPermissions.js';
import { isPathInsideDir } from './dirDeposit.js';
import { brokerRedirectPortDeclarationIssue } from './ghostBrokerRedirectPort.js';
import { checkSkillMdConsistency } from './skillSlot.js';

/**
 * `fs.promises.realpath` 没有 native 变体,promisify 一次(scaffold/pack 的受管根
 * 与 workdir 门都靠它拿到规范路径再比对)。
 */
const realpathNative = promisify(fs.realpath.native);

/**
 * 解析已存在祖先的真身、保留尚不存在的尾段,让受管根在首次落盘前就可比对。
 */
async function resolveThroughExistingAncestor(inputPath: string): Promise<string> {
  let cursor = path.resolve(inputPath);
  const tail: string[] = [];
  while (true) {
    try {
      const real = await realpathNative(cursor);
      return path.join(real, ...tail);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(inputPath);
      tail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * 逐段确认一个已存在目录路径没有 symlink / junction 祖先。
 *
 * 不能用 `realpath(path) === path` 判断：Windows 的 8.3 短路径会被 realpath
 * 展开成长路径，二者文本不同但每一段仍都是普通目录。逐段 lstat 才能既放行
 * 这种合法别名，又继续拒绝真正的 reparse-point 祖先。
 */
async function pathHasLinkSegment(inputPath: string): Promise<boolean> {
  const resolved = path.resolve(inputPath);
  const root = path.parse(resolved).root;
  let current = root;
  const relative = path.relative(root, resolved);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.promises.lstat(current);
    if (!stat.isSymbolicLink()) continue;
    // macOS exposes os.tmpdir() under `/var` while realpath resolves it to
    // `/private/var`. This system alias is safe; links created below the temp
    // root remain rejected by the ordinary segment check.
    const tempRoot = path.resolve(os.tmpdir());
    const targetRel = path.relative(tempRoot, resolved);
    if (targetRel.startsWith(`..${path.sep}`) || path.isAbsolute(targetRel)) return true;
    try {
      const realSegment = await realpathNative(current);
      const realTempRoot = await realpathNative(tempRoot);
      const tempRel = path.relative(realSegment, realTempRoot);
      if (
        tempRel === '' ||
        tempRel.startsWith(`..${path.sep}`) ||
        path.isAbsolute(tempRel) ||
        !(await fs.promises.stat(current)).isDirectory()
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * 与 GhostManager 装入侧同一量级的上限(打包侧提前拦,fail fast)。
 *
 * node 档三个上限**直接引用协议常量**,不再手抄数字:同一份 `.cindy` 之后会被
 * plugin-server 的成员发布链路按这三个值权威校验(`docs/plugin-server.md`
 * 「企业成员上传」),打包侧放行、发布侧拒收是最难排查的一类不一致。basic 档
 * 是 Forge 自己的产品判断(小包更快更稳),与发布上限无关,保持本地常量。
 *
 * ZIP 条目口径:协议与服务端数的是**所有 ZIP entry**,Forge 数的是**文件**。
 * 两者相等的前提是包里不含自动补出的目录 entry —— 见下面 `createFolders: false`。
 */
const MAX_BASIC_FILES = 256;
const MAX_NODE_FILES = PLUGIN_MEMBER_UPLOAD_MAX_ZIP_ENTRIES;
const MAX_BASIC_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_NODE_TOTAL_BYTES = PLUGIN_MEMBER_UPLOAD_MAX_UNCOMPRESSED_BYTES;
const MAX_BASIC_CINDY_BYTES = 8 * 1024 * 1024;
const MAX_NODE_CINDY_BYTES = PLUGIN_MEMBER_UPLOAD_MAX_ARCHIVE_BYTES;

/**
 * JSZip 默认 `createFolders: true`,会为 `a/b/c.txt` 自动补出 `a/` 与 `a/b/`
 * 两个目录 entry。Forge 只数文件,plugin-server 数所有 entry,于是「2 个文件」
 * 在服务端是「4 个 entry」——带目录层级的包逼近上限时会被发布侧拒掉,而打包侧
 * 看不出任何问题。
 *
 * 关掉它让两侧口径按构造相等,而不是让 Forge 去模仿 JSZip 的补目录算法。
 * 装入侧不依赖目录 entry:`GhostManager` 解包时对 `entry.dir` 一律 `mkdir` 后
 * `continue`,而写文件那条分支本来就会 `mkdir(path.dirname(dest))`,目录照样建得出来。
 * 空目录两种设置下都不进包(Forge 只收集普通文件),所以也不存在丢空目录的问题。
 */
const ZIP_FILE_OPTIONS = { createFolders: false } as const;
const FORGE_AI_ICON_PATH = 'assets/icon.png';

/** 打包时跳过的目录/文件(源码目录里的开发残留,不属于意识本体)。 */
function shouldSkip(name: string): boolean {
  if (name.startsWith('.')) return true; // .git / .DS_Store / .disabled 等
  if (name.toLowerCase() === 'node_modules') return true;
  if (name.toLowerCase().endsWith('.cindy')) return true; // 上次打包产物,防套娃
  return false;
}

export type ForgePackResult =
  | { ok: true; cindyPath: string; manifest: GhostManifest; buf: Buffer }
  | {
      ok: false;
      errorCode:
        | 'DIR_NOT_FOUND'
        | 'MANIFEST_INVALID'
        | 'ENTRY_MISSING'
        | 'TOO_LARGE'
        | 'INTERNAL'
        // Forge 打包出口的会话 workdir 门 + 受管根禁区(C-4 + #7)。
        | 'SOURCE_OUTSIDE_WORKDIR'
        | 'SOURCE_IS_INSTALLED_PLUGIN'
        | 'PERMISSION_DENIED';
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
      errorCode: 'INVALID_INPUT' | 'TARGET_EXISTS' | 'PERMISSION_DENIED' | 'INTERNAL';
      message: string;
    };

interface ForgeScaffoldInput {
  dir: string;
  template: ForgeScaffoldTemplate;
  id: string;
  name: string;
  description?: string;
  minCindyVersion: string;
}

/**
 * scaffold 落盘能力(C-4):实际写盘委托给隔离的稳定父目录写入器(main 侧
 * forgeScaffoldCapability/worker),forge.ts 只做校验与内容生成,不直接碰盘。
 */
export interface ForgeScaffoldWriteRequest {
  parentDir: string;
  targetName: string;
  expectedParent: {
    realPath: string;
    dev: bigint;
    ino: bigint;
  };
  files: Array<{ path: string; base64: string }>;
}

export type ForgeScaffoldWriteResult =
  { ok: true } | { ok: false; errorCode: 'TARGET_EXISTS' | 'INTERNAL' | 'PERMISSION_DENIED'; message: string };

export type ForgeScaffoldWriter = (
  request: ForgeScaffoldWriteRequest,
) => Promise<ForgeScaffoldWriteResult>;

const FORGE_OUTSIDE_GRANT_STALE_MESSAGE =
  'Task or Plan permissions changed; retry with the current scope.';

type ForgeOutsideGrantOptions = {
  allowOutsideWorkdir?: boolean;
  authorizedDir?: string;
  isCurrent?: () => boolean;
};

function staleForgeGrant(
  options?: ForgeOutsideGrantOptions,
): { ok: false; errorCode: 'PERMISSION_DENIED'; message: string } | null {
  // Live authority also guards in-workdir writes after async preparation.
  if (!options?.isCurrent && (!options?.allowOutsideWorkdir || !options.authorizedDir)) return null;
  if (options.isCurrent?.() === true) return null;
  return { ok: false, errorCode: 'PERMISSION_DENIED', message: FORGE_OUTSIDE_GRANT_STALE_MESSAGE };
}

/** 生成插件清单；先走正式校验，再允许任何文件落盘。 */
function scaffoldManifest(input: ForgeScaffoldInput): Record<string, unknown> {
  const common = {
    schemaVersion: 3,
    minCindyVersion: input.minCindyVersion,
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
      card: {},
      agent: {},
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
  options?: {
    sessionWorkdir?: string | null;
    forbiddenRootDirs?: readonly string[];
    writeScaffold?: ForgeScaffoldWriter;
    allowOutsideWorkdir?: boolean;
    authorizedDir?: string;
    isCurrent?: () => boolean;
  },
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
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: '没有会话工作目录,无法确定骨架输出位置',
    };
  }
  // 字面 startsWith 不设防软链:工作目录里若有 out -> /tmp/out 之类的软链祖先,
  // 字面在内、实际在外。两边都按 realpath 对账——目标还不存在,就取「已存在的最深
  // 祖先」的真身再拼回剩余段(与打包侧受管根解析共用 resolveThroughExistingAncestor)。
  let realWorkdir: string;
  try {
    realWorkdir = await realpathNative(path.resolve(workdir));
  } catch {
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: '会话工作目录不存在,无法确定骨架输出位置',
    };
  }
  const staleGrant = staleForgeGrant(options);
  if (staleGrant) return staleGrant;
  let realTarget: string;
  try {
    realTarget = await resolveThroughExistingAncestor(resolved);
  } catch (err) {
    return {
      ok: false,
      errorCode: 'INTERNAL',
      message: err instanceof Error ? err.message : String(err),
    };
  }
  if (
    !realTarget.startsWith(`${realWorkdir}${path.sep}`)
    && realTarget !== realWorkdir
  ) {
    if (
      !options?.allowOutsideWorkdir
      || !options.authorizedDir
      || !isPathInsideDir(options.authorizedDir, realTarget)
      || !isPathInsideDir(realTarget, options.authorizedDir)
    ) {
      return { ok: false, errorCode: 'INVALID_INPUT', message: 'dir 必须在当前会话工作目录内' };
    }
  }
  for (const forbiddenRoot of options?.forbiddenRootDirs ?? []) {
    let resolvedForbiddenRoot: string;
    try {
      resolvedForbiddenRoot = await resolveThroughExistingAncestor(forbiddenRoot);
    } catch (err) {
      return {
        ok: false,
        errorCode: 'INTERNAL',
        message: err instanceof Error ? err.message : String(err),
      };
    }
    // 与打包侧同形的双向判定:骨架目标既不能落进受管根(已装插件 / 状态根 / seed 根),
    // 也不能是它们的祖先。祖先方向此处是纵深防御(该目录必已存在,最终 rename 会
    // TARGET_EXISTS 拒掉),但判定不散落、两半都覆盖,才不会靠读者去推断下游语义。
    if (
      isPathInsideDir(resolvedForbiddenRoot, realTarget) ||
      isPathInsideDir(realTarget, resolvedForbiddenRoot)
    ) {
      return {
        ok: false,
        errorCode: 'INVALID_INPUT',
        message:
          'dir 不能落在已安装插件目录或 Host 管理的状态目录内,也不能是它们的上级目录;请在工作目录里换一个独立的作者目录',
      };
    }
  }
  const targetDir = options?.allowOutsideWorkdir && options.authorizedDir
    ? path.resolve(options.authorizedDir)
    : path.resolve(input.dir);
  const files = scaffoldFiles(input);
  const manifestRaw = files[GHOST_MANIFEST_FILE];
  if (typeof manifestRaw !== 'string') {
    return { ok: false, errorCode: 'INTERNAL', message: 'scaffold manifest 必须是 JSON 字符串' };
  }
  let scaffoldManifest: unknown;
  try {
    scaffoldManifest = JSON.parse(manifestRaw);
  } catch {
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: '插件信息不合格:ghost.json 不是合法 JSON',
    };
  }
  const reservedScaffoldNamespace = authorDeclaredNamespaceReason(scaffoldManifest);
  if (reservedScaffoldNamespace) {
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: `插件信息不合格:${reservedScaffoldNamespace}`,
    };
  }
  const validation = validateGhostManifest(scaffoldManifest);
  if (!validation.ok) {
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: `插件信息不合格:${validation.reason}`,
    };
  }
  if (!isValidNewGhostId(validation.manifest.id)) {
    return {
      ok: false,
      errorCode: 'INVALID_INPUT',
      message: '新建插件 id 必须以小写字母开头，只能包含小写字母、数字和连字符，最长 32 个字符',
    };
  }
  const brokerPortIssue = brokerRedirectPortDeclarationIssue(validation.manifest);
  if (brokerPortIssue) {
    return { ok: false, errorCode: 'INVALID_INPUT', message: `插件信息不合格:${brokerPortIssue}` };
  }

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
  let parentStat: fs.BigIntStats;
  let parentRealPath: string;
  try {
    parentStat = await fs.promises.lstat(parentDir, { bigint: true });
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
      return {
        ok: false,
        errorCode: 'INVALID_INPUT',
        message: options?.allowOutsideWorkdir
          ? 'dir 的父目录必须是已存在的普通目录'
          : 'dir 的父目录必须是工作目录内已存在的普通目录',
      };
    }
    parentRealPath = await realpathNative(parentDir);
    const parentHasLinkAncestor = await pathHasLinkSegment(parentDir);
    const parentOutsideWorkdir = !isPathInsideDir(realWorkdir, parentRealPath);
    if (parentHasLinkAncestor || (parentOutsideWorkdir && !options?.allowOutsideWorkdir)) {
      return {
        ok: false,
        errorCode: 'INVALID_INPUT',
        message: parentHasLinkAncestor
          ? 'dir 的父目录必须是没有链接祖先的普通目录'
          : 'dir 的父目录必须是工作目录内已存在且没有链接祖先的普通目录',
      };
    }
  } catch (err) {
    if (hasFsErrorCode(err, 'ENOENT')) {
      return {
        ok: false,
        errorCode: 'INVALID_INPUT',
        message: options?.allowOutsideWorkdir
          ? 'dir 的父目录必须先创建'
          : 'dir 的父目录必须先创建，并且必须位于当前工作目录内',
      };
    }
    return {
      ok: false,
      errorCode: 'INTERNAL',
      message: err instanceof Error ? err.message : String(err),
    };
  }

  // 实际落盘委托给隔离的稳定父目录写入器(C-4):forge.ts 只生成内容,不直接写盘。
  if (!options?.writeScaffold) {
    return {
      ok: false,
      errorCode: 'INTERNAL',
      message: 'Forge scaffold stable-directory capability is unavailable',
    };
  }
  const staleBeforeWrite = staleForgeGrant(options);
  if (staleBeforeWrite) return staleBeforeWrite;
  const writeResult = await options.writeScaffold({
    parentDir,
    targetName: path.basename(targetDir),
    expectedParent: { realPath: parentRealPath, dev: parentStat.dev, ino: parentStat.ino },
    files: Object.entries(files).map(([rel, content]) => ({
      path: rel,
      base64: (typeof content === 'string' ? Buffer.from(content, 'utf8') : content).toString(
        'base64',
      ),
    })),
  });
  if (!writeResult.ok) {
    return { ok: false, errorCode: writeResult.errorCode, message: writeResult.message };
  }
  return {
    ok: true,
    dir: targetDir,
    template,
    files: Object.keys(files).sort(),
    nextSteps: [
      '按需要修改 ghost.json、main.js 和 worker 源码。',
      '调用 ghost_forge_pack 校验并生成 .cindy；打包本身不会安装插件。',
      'Node 模板不允许在安装或首次运行时执行 npm install、npx 或 postinstall。',
    ],
  };
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
  options?: { iconPng?: Buffer },
): Promise<
  // manifestRaw = 校验前的原始清单对象。作者期严格校验(见 firstGhostAuthoringIssue)
  // 需要它来看见「作者写了但被校验器按未登记字段忽略掉」的内容——校验后的
  // manifest 里那些字段已经不见了,只看它无从判断。
  | { ok: true; buf: Buffer; manifest: GhostManifest; manifestRaw: Record<string, unknown> }
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
    // 声明),返回的 manifest 与包里那份就会分叉——安装侧校验的是旧清单，
    // 装进去的却是改过的包。快照写入让"校验的 = 返回的 = 包里的"三者恒等。
    // 与市场发现/安装层同一把闸(单句柄限量读,拒符号链接):打包输入目录是
    // 用户可写的活目录,按路径无界 readFile 会跟随链接读到目录外、或被超大
    // 文件耗尽内存。快照字节也必须出自这把闸,不能再按路径重读。
    let manifestRaw: unknown;
    let manifestBytes: Buffer;
    let manifestUnixPermissions: number;
    try {
      const read = await readBoundedFileNoFollowWithStat(
        path.join(realDir, GHOST_MANIFEST_FILE),
        GHOST_MANIFEST_MAX_BYTES,
        { containWithin: realDir },
      );
      if (read === null) {
        return {
          ok: false,
          errorCode: 'MANIFEST_INVALID',
          message: `${GHOST_MANIFEST_FILE} 不是普通文件或超过 ${GHOST_MANIFEST_MAX_BYTES} 字节上限`,
        };
      }
      manifestBytes = read.bytes;
      manifestUnixPermissions = unixRegularFilePermissionsForArchive(read.stat.mode);
      manifestRaw = JSON.parse(manifestBytes.toString('utf-8'));
    } catch (err) {
      return {
        ok: false,
        errorCode: 'MANIFEST_INVALID',
        message: `${GHOST_MANIFEST_FILE} 缺失或不是合法 JSON:${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const iconPng = options?.iconPng;
    if (iconPng !== undefined) {
      if (iconPng.byteLength === 0 || iconPng.byteLength > GHOST_ICON_MAX_BYTES) {
        return {
          ok: false,
          errorCode: 'TOO_LARGE',
          message: `AI 图标体积必须在 1–${GHOST_ICON_MAX_BYTES} 字节之间`,
        };
      }
      // 无效清单先交给正式 validator，避免 overlay 把 null/数组等输入改造成
      // 另一种形状、掩盖原始 MANIFEST_INVALID。只有普通对象才写入快照。
      if (typeof manifestRaw === 'object' && manifestRaw !== null && !Array.isArray(manifestRaw)) {
        // icon_source 是打包期 overlay：源码仍保留 scaffold 占位图，只有用户
        // 确认生成成功的这一包替换图标。清单快照也同步指向固定安全路径。
        manifestRaw = { ...manifestRaw, icon: FORGE_AI_ICON_PATH };
        // 采用紧凑 JSON，避免仅为 overlay 重排空白就把清单推过安装侧上限。
        manifestBytes = Buffer.from(`${JSON.stringify(manifestRaw)}\n`, 'utf-8');
      }
    }
    const reservedNamespace = authorDeclaredNamespaceReason(manifestRaw);
    if (reservedNamespace) {
      return { ok: false, errorCode: 'MANIFEST_INVALID', message: `清单不合格:${reservedNamespace}` };
    }
    const v = validateGhostManifest(manifestRaw);
    if (!v.ok) {
      return { ok: false, errorCode: 'MANIFEST_INVALID', message: `清单不合格:${v.reason}` };
    }
    const brokerPortIssue = brokerRedirectPortDeclarationIssue(v.manifest);
    if (brokerPortIssue) {
      return { ok: false, errorCode: 'MANIFEST_INVALID', message: `清单不合格:${brokerPortIssue}` };
    }
    if (manifestBytes.byteLength > GHOST_INSTALL_MANIFEST_MAX_BYTES) {
      return {
        ok: false,
        errorCode: 'MANIFEST_INVALID',
        message: `${GHOST_MANIFEST_FILE} 合成后超过安装器 ${GHOST_INSTALL_MANIFEST_MAX_BYTES} 字节上限`,
      };
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
    if (manifest.node?.entry) {
      mustExist.push(manifest.node.entry, ...(manifest.node.entries ?? []));
    }
    if (manifest.panel?.html) mustExist.push(manifest.panel.html);
    if (manifest.mainView?.html) mustExist.push(manifest.mainView.html);
    if (manifest.taskView?.html) mustExist.push(manifest.taskView.html);
    if (manifest.settingsHtml) mustExist.push(manifest.settingsHtml);
    for (const item of manifest.skill?.items ?? []) mustExist.push(`${item.dir}/SKILL.md`);
    if (iconPng === undefined && manifest.icon) mustExist.push(manifest.icon);
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

    // 3.5) skill 能力:SKILL.md frontmatter 与清单声明必须逐字一致。与装入侧
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

    // 3.6) manual:每个声明单元必须以 MANUAL.md 为入口，目录内只允许普通
    // Markdown 文件；逐文件限量、严格 UTF-8，并拒绝并发截短与二进制内容。
    // 缓存本次校验过的字节，生成 zip 时直接使用同一份快照，避免“预检一份、
    // 入包时又读到另一份”的竞态。嵌套单元共享缓存，同一物理文件只校验一次。
    const manualFileSnapshots = new Map<string, { bytes: Buffer; unixPermissions: number }>();
    for (const item of manifest.manual?.items ?? []) {
      const unitRoot = path.join(dir, ...item.dir.split('/'));
      const validateManualDir = async (
        currentDir: string,
        relativeDir: string,
        preloadedEntries?: fs.Dirent[],
      ): Promise<Exclude<ForgePackResult, { ok: true }> | null> => {
        let entries: fs.Dirent[];
        if (preloadedEntries) {
          entries = preloadedEntries;
        } else {
          try {
            entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
          } catch {
            return {
              ok: false,
              errorCode: 'ENTRY_MISSING',
              message: `读取手册目录失败:${item.dir}${relativeDir ? `/${relativeDir}` : ''}`,
            };
          }
        }
        for (const entry of entries) {
          if (shouldSkip(entry.name)) continue;
          const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
          const logicalPath = `${item.dir}/${relativePath}`;
          const absolutePath = path.join(currentDir, entry.name);
          if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
            return {
              ok: false,
              errorCode: 'MANIFEST_INVALID',
              message: `manual 单元只允许普通 Markdown 文件:${logicalPath}`,
            };
          }
          if (entry.isDirectory()) {
            if (ghostManualLogicalPathForEntry(item.name, relativePath, 'directory') === null) {
              return {
                ok: false,
                errorCode: 'MANIFEST_INVALID',
                message: `manual 目录无法形成合法 ghost_manual 路径:${logicalPath}`,
              };
            }
            const nestedError = await validateManualDir(absolutePath, relativePath);
            if (nestedError) return nestedError;
            continue;
          }
          if (ghostManualLogicalPathForEntry(item.name, relativePath, 'file') === null) {
            return {
              ok: false,
              errorCode: 'MANIFEST_INVALID',
              message: `manual 文件无法形成合法 ghost_manual Markdown 路径:${logicalPath}`,
            };
          }
          if (manualFileSnapshots.has(logicalPath)) continue;
          let read;
          try {
            read = await readBoundedFileNoFollowWithStat(absolutePath, GHOST_MANUAL_MD_MAX_BYTES, {
              containWithin: realDir,
              verifyContentStability: true,
            });
          } catch {
            return {
              ok: false,
              errorCode: 'MANIFEST_INVALID',
              message: `读取 manual 文件失败:${logicalPath}`,
            };
          }
          if (read === null) {
            return {
              ok: false,
              errorCode: 'MANIFEST_INVALID',
              message: `${logicalPath} 不是普通文件或超过 ${GHOST_MANUAL_MD_MAX_BYTES} 字节上限`,
            };
          }
          const decoded = decodeGhostManualMarkdown(read.bytes);
          if (!decoded.ok) {
            return {
              ok: false,
              errorCode: 'MANIFEST_INVALID',
              message: `manual 文件不合格(${logicalPath}):${decoded.reason}`,
            };
          }
          manualFileSnapshots.set(logicalPath, {
            bytes: read.bytes,
            unixPermissions: unixRegularFilePermissionsForArchive(read.stat.mode),
          });
        }
        return null;
      };
      let rootEntries: fs.Dirent[];
      try {
        rootEntries = await fs.promises.readdir(unitRoot, { withFileTypes: true });
      } catch {
        return {
          ok: false,
          errorCode: 'ENTRY_MISSING',
          message: `读取手册目录失败:${item.dir}`,
        };
      }
      const manualEntry = rootEntries.find((entry) => entry.name === GHOST_MANUAL_ENTRY_FILE);
      if (!manualEntry?.isFile() || manualEntry.isSymbolicLink()) {
        return {
          ok: false,
          errorCode: 'ENTRY_MISSING',
          message: `清单声明的文件不存在:${item.dir}/${GHOST_MANUAL_ENTRY_FILE}`,
        };
      }
      const manualError = await validateManualDir(unitRoot, '', rootEntries);
      if (manualError) return manualError;
    }

    // 4) 收集文件(递归,跳过开发残留),数量/体积设限。
    // 分类一律走 lstat(不信 readdir Dirent 的类型位——libuv 对 junction 的类型位
    // 跨平台不稳),按我们分支的加固语义处理:
    //  - 目录:进递归前按 realpath 复核仍在规范源码根内。目录可能在"分类"与
    //    "递归"之间被换成指向根外/受管根的 junction(TOCTOU);realpath 越界即拒
    //    (SOURCE_OUTSIDE_WORKDIR),避免把根外字节递归卷进 .cindy。
    //  - 符号链接:清单声明的入口是链接 → ENTRY_MISSING(装入侧会缺入口 404,
    //    打包期就拦);非声明的链接 → 跳过,不穿透、不把目标字节打进包。
    //  - 普通文件:收集(字节读取仍在下面按 realDir containWithin 现读)。
    const files: Array<{ rel: string; abs: string }> = [];
    let totalBytes = 0;
    const maxFiles = manifest.node ? MAX_NODE_FILES : MAX_BASIC_FILES;
    const maxTotalBytes = manifest.node ? MAX_NODE_TOTAL_BYTES : MAX_BASIC_TOTAL_BYTES;
    const seenPackPaths = new Set<string>();
    const requiredPackPaths = new Set(mustExist.map((entry) => entry.toLowerCase()));
    const walk = async (
      cur: string,
      relBase: string,
    ): Promise<Exclude<ForgePackResult, { ok: true }> | null> => {
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
        let st: fs.Stats;
        try {
          st = await fs.promises.lstat(abs);
        } catch {
          // 分类时条目已消失(并发删除):声明入口 → ENTRY_MISSING,其它跳过。
          if (requiredPackPaths.has(foldedRel)) {
            return {
              ok: false,
              errorCode: 'ENTRY_MISSING',
              message: `清单声明的文件不存在:${rel}`,
            };
          }
          continue;
        }
        if (st.isSymbolicLink()) {
          if (requiredPackPaths.has(foldedRel)) {
            return {
              ok: false,
              errorCode: 'ENTRY_MISSING',
              message: `清单声明的文件是链接,不可打包:${rel}`,
            };
          }
          continue;
        }
        if (st.isDirectory()) {
          // 进递归前按 realpath 复核:分类与递归之间目录可能被换成指向根外的
          // junction。realpath 越出规范源码根即拒,不把根外字节卷进包。
          let realCur: string;
          try {
            realCur = await realpathNative(abs);
          } catch {
            continue;
          }
          if (!isPathInsideDir(realDir, realCur)) {
            return {
              ok: false,
              errorCode: 'SOURCE_OUTSIDE_WORKDIR',
              message: `源码子目录在打包期被替换为指向根外的链接:${rel}`,
            };
          }
          const bad = await walk(abs, rel);
          if (bad) return bad;
        } else if (st.isFile()) {
          files.push({ rel, abs });
          // 体积预算用 stat(而非 lstat.size):这是"walk 期预估"值,真正的
          // 权威边界在下面 zip 步按剩余预算 containWithin 现读时强制(文件可能在
          // walk 与读取之间被并发撑大)。分类归 lstat,预算归 stat,各司其职。
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
        } else if (requiredPackPaths.has(foldedRel)) {
          // 声明入口是块/字符设备、FIFO 等非常规条目 → 视为缺失。
          return {
            ok: false,
            errorCode: 'ENTRY_MISSING',
            message: `清单声明的文件不是普通文件:${rel}`,
          };
        }
      }
      return null;
    };
    const tooLarge = await walk(dir, '');
    if (tooLarge) return tooLarge;
    const collectedPackPaths = new Set(files.map((file) => file.rel));
    const omittedRequiredPath = mustExist.find(
      (requiredPath) => !collectedPackPaths.has(requiredPath),
    );
    if (omittedRequiredPath) {
      return {
        ok: false,
        errorCode: 'ENTRY_MISSING',
        message: `清单声明的文件未进入打包内容:${omittedRequiredPath}`,
      };
    }
    if (manifest.manual !== undefined) {
      const isWithinManualUnit = (rel: string): boolean =>
        manifest.manual!.items.some((item) => rel.startsWith(`${item.dir}/`));
      const packedManualPaths = new Set(
        files.filter((file) => isWithinManualUnit(file.rel)).map((file) => file.rel),
      );
      const changedManualPath =
        [...packedManualPaths].find((rel) => !manualFileSnapshots.has(rel)) ??
        [...manualFileSnapshots.keys()].find((rel) => !packedManualPaths.has(rel));
      if (changedManualPath !== undefined) {
        return {
          ok: false,
          errorCode: 'MANIFEST_INVALID',
          message: `manual 目录在打包期间发生变化:${changedManualPath}`,
        };
      }
    }
    // AI icon overlay changes both the manifest snapshot and the icon bytes. A
    // source tree carrying a publisher/reviewer signature cannot be modified
    // here without re-signing, so let the host fall back to the original icon
    // package instead of producing a package that installation must reject.
    const signatureEntry = files.find((file) => file.rel === GHOST_SIGNATURE_FILE);
    if (iconPng !== undefined && signatureEntry) {
      return {
        ok: false,
        errorCode: 'MANIFEST_INVALID',
        message:
          '已签名插件不能使用 AI 图标覆盖；请保留原图标，或先修改源码图标再由正式发布流水线重新签名',
      };
    }
    const foldedAiIconPath = FORGE_AI_ICON_PATH.toLowerCase();
    const iconSourceEntry = files.find((file) => file.rel.toLowerCase() === foldedAiIconPath);
    const iconPathOccupiedByDirectory = [...seenPackPaths].some(
      (rel) => rel === foldedAiIconPath || rel.startsWith(`${foldedAiIconPath}/`),
    );
    if (iconPng !== undefined && iconPathOccupiedByDirectory && !iconSourceEntry) {
      return {
        ok: false,
        errorCode: 'MANIFEST_INVALID',
        message: `AI 图标目标路径已被源码目录占用:${FORGE_AI_ICON_PATH}`,
      };
    }
    if (iconPng !== undefined && iconSourceEntry && iconSourceEntry.rel !== FORGE_AI_ICON_PATH) {
      return {
        ok: false,
        errorCode: 'MANIFEST_INVALID',
        message: `AI 图标目标路径与源码中的大小写冲突:${iconSourceEntry.rel}`,
      };
    }
    if (iconPng !== undefined && !iconSourceEntry && files.length + 1 > maxFiles) {
      return { ok: false, errorCode: 'TOO_LARGE', message: `文件过多(上限 ${maxFiles} 个)` };
    }

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
      let unixPermissions: number;
      if (f.rel === GHOST_MANIFEST_FILE) {
        content = manifestBytes;
        unixPermissions = manifestUnixPermissions;
      } else if (iconPng !== undefined && f.rel === FORGE_AI_ICON_PATH) {
        content = iconPng;
        unixPermissions = ARCHIVE_REGULAR_0644;
      } else if (manualFileSnapshots.has(f.rel)) {
        const snapshot = manualFileSnapshots.get(f.rel)!;
        content = snapshot.bytes;
        unixPermissions = snapshot.unixPermissions;
      } else {
        let read: Awaited<ReturnType<typeof readBoundedFileNoFollowWithStat>>;
        try {
          read = await readBoundedFileNoFollowWithStat(f.abs, maxTotalBytes - packedBytes, {
            containWithin: realDir,
          });
        } catch {
          read = null;
        }
        if (read === null) {
          return {
            ok: false,
            errorCode: 'TOO_LARGE',
            message: `文件在打包期间被并发改动或超出剩余体积预算:${f.rel}`,
          };
        }
        content = read.bytes;
        unixPermissions = unixRegularFilePermissionsForArchive(read.stat.mode);
      }
      packedBytes += content.byteLength;
      if (packedBytes > maxTotalBytes) {
        return {
          ok: false,
          errorCode: 'TOO_LARGE',
          message: `总体积超上限(${maxTotalBytes} 字节)`,
        };
      }
      zip.file(f.rel, content, { ...ZIP_FILE_OPTIONS, unixPermissions });
    }
    if (iconPng !== undefined && !iconSourceEntry) {
      packedBytes += iconPng.byteLength;
      if (packedBytes > maxTotalBytes) {
        return {
          ok: false,
          errorCode: 'TOO_LARGE',
          message: `总体积超上限(${maxTotalBytes} 字节)`,
        };
      }
      zip.file(FORGE_AI_ICON_PATH, iconPng, {
        ...ZIP_FILE_OPTIONS,
        unixPermissions: ARCHIVE_REGULAR_0644,
      });
    }
    const buf = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      platform: 'UNIX',
    });
    const maxCindyBytes = manifest.node ? MAX_NODE_CINDY_BYTES : MAX_BASIC_CINDY_BYTES;
    if (buf.byteLength > maxCindyBytes) {
      return {
        ok: false,
        errorCode: 'TOO_LARGE',
        message: `压缩包体积超上限(${maxCindyBytes} 字节)`,
      };
    }
    return {
      ok: true,
      buf,
      manifest,
      manifestRaw: (manifestRaw ?? {}) as Record<string, unknown>,
    };
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
export async function packGhostDir(
  dir: string,
  options?: {
    sessionWorkdir?: string | null;
    forbiddenRootDirs?: readonly string[];
    iconPng?: Buffer;
    /**
     * Host already authorized this source via the session permission path
     * (Full Access / auto-review / user confirm). Forbidden managed roots
     * still apply. `authorizedDir` is the granted canonical identity and is
     * required whenever `allowOutsideWorkdir` is true.
     */
    allowOutsideWorkdir?: boolean;
    authorizedDir?: string;
    /**
     * Host grant generation captured at authorize time. Required whenever
     * `allowOutsideWorkdir` is used with `authorizedDir`; rechecked after the
     * long pack and immediately before the `.cindy` write.
     */
    isCurrent?: () => boolean;
  },
): Promise<ForgePackResult> {
  // Forge 打包出口专属安全门(C-4 + #7):source 默认必须在会话 workdir 内;Host 已按
  // 当前会话权限放行后可带 allowOutsideWorkdir。受管根(已装插件 / 批准状态根 /
  // seed 根)始终双向拒绝。算出的 realSourceDir 作为 buildGhostPackage 的
  // expectedRealDir 上游锚点——正是它要求"由上游校验后传入"的那份。
  const workdir = options?.sessionWorkdir;
  if (!workdir) {
    return {
      ok: false,
      errorCode: 'SOURCE_OUTSIDE_WORKDIR',
      message: 'Forge pack requires an active session workdir',
    };
  }
  let realWorkdir: string;
  try {
    realWorkdir = await realpathNative(path.resolve(workdir));
  } catch {
    return {
      ok: false,
      errorCode: 'SOURCE_OUTSIDE_WORKDIR',
      message: 'The current session workdir does not exist',
    };
  }
  const staleGrant = staleForgeGrant(options);
  if (staleGrant) return staleGrant;
  let realSourceDir: string;
  try {
    realSourceDir = await realpathNative(dir);
  } catch {
    return { ok: false, errorCode: 'DIR_NOT_FOUND', message: `目录不存在:${dir}` };
  }
  if (!isPathInsideDir(realWorkdir, realSourceDir)) {
    if (
      !options?.allowOutsideWorkdir
      || !options.authorizedDir
      || !isPathInsideDir(options.authorizedDir, realSourceDir)
      || !isPathInsideDir(realSourceDir, options.authorizedDir)
    ) {
      return {
        ok: false,
        errorCode: 'SOURCE_OUTSIDE_WORKDIR',
        message: 'Forge source must be inside the current session workdir',
      };
    }
  }
  for (const forbiddenRoot of options?.forbiddenRootDirs ?? []) {
    const resolvedForbiddenRoot = await resolveThroughExistingAncestor(forbiddenRoot);
    // 双向:源目录落在受管根内要拒(拿已安装插件当源码),源目录是受管根祖先也要拒
    //(递归打包会走进 cindy-brain / ghost-install-state / seed 根,把已装字节、批准
    // receipt、技能快照打进 .cindy)。
    if (
      isPathInsideDir(resolvedForbiddenRoot, realSourceDir) ||
      isPathInsideDir(realSourceDir, resolvedForbiddenRoot)
    ) {
      return {
        ok: false,
        errorCode: 'SOURCE_IS_INSTALLED_PLUGIN',
        message:
          'Forge source must not be an installed Plugin or a Host-managed state directory; copy the source into the current session workdir first',
      };
    }
  }
  const built = await buildGhostPackage(
    dir,
    realSourceDir,
    options ? { iconPng: options.iconPng } : undefined,
  );
  if (!built.ok) return built;
  const authoringIssue = firstGhostAuthoringIssue(built.manifestRaw);
  if (authoringIssue) {
    return { ok: false, errorCode: 'MANIFEST_INVALID', message: authoringIssue };
  }
  // 产物跟源码住一起(2026-07 Lizi 定案:拿取直观);文件收集在写盘之前完成
  // + shouldSkip 跳过 *.cindy,自身产物不会进包;同名覆盖。
  // 落地到**规范源码目录**(realpath 产物)而非可能是符号链接/别名的入参 `dir`:
  // 产物必须写进真实目录,别名只是通往它的一条路径。
  const cindyPath = path.join(
    realSourceDir,
    `${built.manifest.id}-${built.manifest.version}.cindy`,
  );
  const staleBeforeWrite = staleForgeGrant(options);
  if (staleBeforeWrite) return staleBeforeWrite;
  try {
    await fs.promises.writeFile(cindyPath, built.buf);
  } catch (err) {
    return {
      ok: false,
      errorCode: 'INTERNAL',
      message: `写入打包产物失败:${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // 作者目录里的副本只给人手动拿走。安装链路必须用内存里的 `buf` 直写
  // staging，绝不能从 cindyPath 回读——agent 能在确认前替换那份文件。
  return { ok: true, cindyPath, manifest: built.manifest, buf: built.buf };
}

/**
 * **作者期严格校验**(只在 packGhostDir 这条打包出口上跑,不进任何安装路径)。
 *
 * 未读角标由顶层 `badge: true` 声明。真正会静默失败的是另一种:
 * 作者(或 agent)照着**早期示例**写成顶层 `notify: { badge: ... }` —— 那个字段
 * 从来没被登记过,校验器一律忽略,于是包打出来了、装进去了、运行期每次发 badge
 * 都被拒,作者却以为自己声明过(codex review)。
 *
 * 这里在打包期把它变成一条可行动的报错。放在 packGhostDir 而不是共用校验器或
 * packGhostDirToFile:后两者会作用到**已在用户机器上**的清单与自定义市场安装管道,
 * 给它们加新拒绝面就会踩存量红线;而作者正在打包的这一份没有存量问题。
 */
function firstGhostAuthoringIssue(raw: Record<string, unknown>): string | null {
  const notifyRaw = raw.notify;
  if (
    notifyRaw !== null &&
    typeof notifyRaw === 'object' &&
    !Array.isArray(notifyRaw) &&
    'badge' in (notifyRaw as Record<string, unknown>)
  ) {
    return '未读角标已改为独立能力:请把 notify.badge 删掉,改成顶层 "badge": true(并同时声明 panel)';
  }
  return null;
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
  return { ok: true, cindyPath: destPath, manifest: built.manifest, buf: built.buf };
}

// Keep the existing tool/test export while the built-in Skill owns the documentation.
export { FORGE_GUIDE } from './forgeGuide.js';
