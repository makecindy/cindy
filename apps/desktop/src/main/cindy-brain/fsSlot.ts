/**
 * fsSlot.ts — fs 槽代写文件(2026-07-14,与 Lizi 定案)。
 * ---------------------------------------------------------------------------
 * 意识没有文件系统(沙箱红线不破),想落盘只能经管子请主机代写:
 *
 *   电子脑 cindy.send({type:'fs-request', op, root, path?, content?, …})
 *     → 资格审(声明了 'fs' 卡槽?)
 *     → 按 root 三档守门:
 *       'data'    私有数据目录 userData/ghost-fs/<ghostId>——自己的储物柜,
 *                 免确认;全 op(write/read/list/delete);配额封顶;卸载回收。
 *       'workdir' 当前会话工作目录——仅 write;必须带 callId(主机凭
 *                 cardService 反查 session,不信意识自报);**跟随会话
 *                 permission 模式**(映射表见 workdirWriteVerdict:免批模式
 *                 直写、逐条模式弹 fs_write 确认卡、plan 拒);远程工作区
 *                 (remoteHostId 非空)明确拒——路径在远端机器,本地代写
 *                 写不到(规则 26,首期不支持不静默坏)。
 *       'save'    主 agent 过户的 save 票据目录——仅 write;复用
 *                 saveDeposit 票据库的 TTL/次数/字节预算与文件名消毒去重
 *                 (与 fetch as:'file' 下载落盘同一本账)。
 *     → 主机代写/代读,只回结构化 GhostPipeFsResult(永不 reject)。
 *
 * 路径纪律:相对路径沿用 isSafeGhostRelativePath(无 `.`/`..`、段首不许点
 * ——写不了 .git / .env 等隐藏路径是刻意的),外加 Windows 保留设备名拒收
 * (NUL.txt 会静默写进空设备,规则 15);落盘前 realpath 收敛校验最深已存在
 * 祖先,symlink 指到根外一律拒,目标本身是 symlink 也拒(不穿透写)。
 *
 * 权限对齐哲学:意识写 workdir 的"吵闹程度"必须和主 agent 自己 Edit 文件
 * 完全一致——agent 免批的模式意识也免批,agent 逐条批的模式意识也逐条批。
 * claude / codex / pi 共用 sessions.permission_mode 这一列(codex 的 approval/
 * sandbox 由它映射派生,pi bridge 每次 tool_call 现读自己的运行时权限文件),
 * 所以一张映射表覆盖三种 agent(规则 9:映射写死在代码,不靠 prompt 判断)。
 *
 * 依赖注入(规则 14):fs 之外的能力(意识清单/票据库/session 快照/确认桥)
 * 全部经 deps,单测拿 tmpdir 直测零 Electron。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  GHOST_FS_DATA_MAX_FILES,
  GHOST_FS_DATA_MAX_TOTAL_BYTES,
  GHOST_FS_LIST_MAX_ENTRIES,
  GHOST_FS_OPS,
  GHOST_FS_PATH_MAX_CHARS,
  GHOST_FS_READ_MAX_BYTES,
  GHOST_FS_ROOTS,
  GHOST_FS_WRITE_MAX_BYTES,
  isSafeGhostRelativePath,
  type GhostFsListEntry,
  type GhostFsOp,
  type GhostFsRoot,
  type GhostPipeFsResult,
  type InstalledGhost,
} from '../../shared/ghost.js';
import type { GhostGrantConfirmDecision, GhostGrantConfirmPayload } from './ghostGrantConfirmBridge.js';

/** 会话快照:fs 槽 workdir 档守门要看的全部字段。 */
export interface FsSessionSnapshot {
  workingDir: string | null;
  permissionMode: string;
  planModeEnabled: boolean;
  /** 非空 = SSH 远程工作区会话(workdir 在远端机器,本地代写必拒)。 */
  remoteHostId: string | null;
}

export interface FsSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 私有数据目录根(生产 = userData/ghost-fs;意识各占 <root>/<ghostId>)。 */
  dataRootDir(): string;
  /** callId → 归属反查(生产 = cardService.callInfoOf;不信意识自报)。 */
  callInfo(callId: string): { ghostId: string; sessionId: string | null } | null;
  /** sessionId → 会话快照(生产查 localDb sessions 行;查无返回 null)。 */
  getSessionSnapshot(sessionId: string): Promise<FsSessionSnapshot | null>;
  /**
   * workdir 写确认卡(生产 = GhostGrantConfirmBridge.request;桥未就绪时
   * 调用方注入的实现应直接回拒绝,不抛)。
   */
  requestWriteConfirm(
    sessionId: string,
    payload: GhostGrantConfirmPayload,
  ): Promise<GhostGrantConfirmDecision>;
  /** save 票据写入(生产 = SaveDepositVault.write;无效票据统一 null)。 */
  writeSaveDeposit(
    ghostId: string,
    token: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<{ fileName: string } | null>;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** workdir 写入的三档裁决。 */
export type FsWorkdirVerdict = 'allow' | 'confirm' | 'deny';

/**
 * 会话 permission 模式 → workdir 写入裁决(claude / codex 共用,见文件头)。
 * - acceptEdits / bypassPermissions / auto:文件编辑免批 → 意识直写;
 * - ask / default:agent 编辑要逐条批 → 意识写也弹确认卡;
 * - plan(历史遗留值)与 planModeEnabled:只读规划期 → 拒;
 * - 未知模式(未来新增):保守走确认,不静默放行。
 */
export function workdirWriteVerdict(permissionMode: string, planModeEnabled: boolean): FsWorkdirVerdict {
  if (planModeEnabled) return 'deny';
  switch (permissionMode) {
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'auto':
      return 'allow';
    case 'ask':
    case 'default':
      return 'confirm';
    case 'plan':
      return 'deny';
    default:
      return 'confirm';
  }
}

/** Windows 保留设备名(带扩展名同样命中;与 dirDeposit 同口径,规则 15)。 */
const WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** 相对路径最大段数:掐死"深目录链撑爆用量扫描"的攻击向量(配额保险丝的源头闸)。 */
const FS_PATH_MAX_SEGMENTS = 16;

/**
 * fs 相对路径校验:isSafeGhostRelativePath 之上再拒 Windows 保留设备名
 * (每段都查——目录名撞上保留名同样出事)、尾点段(Windows 落盘静默剥尾点,
 * 回执名与真身不一致,规则 15)、段数与总长上限。返回 null = 合法,否则人话原因。
 */
export function validateFsRelPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'path 必填(相对路径,如 "reports/result.json")';
  if (p.length > GHOST_FS_PATH_MAX_CHARS) return `path 超长(上限 ${GHOST_FS_PATH_MAX_CHARS} 字符)`;
  if (!isSafeGhostRelativePath(p)) {
    return 'path 必须是安全相对路径:正斜杠分段、无 "."/".."、每段以字母/数字/下划线开头(写不了隐藏文件是刻意限制)';
  }
  const segments = p.split('/');
  if (segments.length > FS_PATH_MAX_SEGMENTS) {
    return `path 层级过深(上限 ${FS_PATH_MAX_SEGMENTS} 段)`;
  }
  for (const seg of segments) {
    if (WINDOWS_RESERVED_BASENAME_RE.test(seg)) {
      return `path 含 Windows 保留设备名段:${seg}`;
    }
    if (seg.endsWith('.')) {
      return `path 段不允许以点结尾(Windows 会静默剥掉尾点):${seg}`;
    }
  }
  return null;
}

/** 大小写折叠(Windows 路径不区分大小写,含入串比较前先折)。 */
function foldCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** target 是否落在 base 目录内(含 base 自身;两参都应是绝对路径)。 */
function isInsideDir(base: string, target: string): boolean {
  const b = foldCase(path.resolve(base));
  const t = foldCase(path.resolve(target));
  return t === b || t.startsWith(b + path.sep);
}

/**
 * symlink 逃逸校验:找 target 最深的已存在祖先,realpath 后必须仍在
 * realBase 内(base 内的 symlink 目录指向外面 → 组合路径逃出根,必须拦)。
 */
async function deepestExistingAncestorInside(realBase: string, target: string): Promise<boolean> {
  let probe = target;
  for (;;) {
    const parent = path.dirname(probe);
    try {
      const real = await fs.promises.realpath(parent);
      return isInsideDir(realBase, real);
    } catch {
      if (parent === probe) return false; // 到根还不存在(理论不可达)
      probe = parent;
    }
  }
}

/** 解码写入内容;失败/超限返回人话原因。 */
function decodeContent(
  content: unknown,
  encoding: unknown,
): { bytes: Buffer } | { error: string } {
  if (typeof content !== 'string') return { error: 'write 需要 content(字符串)' };
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
    return { error: 'encoding 只支持 "utf8" / "base64"' };
  }
  const overLimit = `内容超限(上限 ${GHOST_FS_WRITE_MAX_BYTES} 字节);请拆分成多个文件`;
  let bytes: Buffer;
  if (encoding === 'base64') {
    // 先按编码长度粗闸再解码:超大字符串不值得先分配一份 Buffer 再拒。
    if (content.length > (GHOST_FS_WRITE_MAX_BYTES * 4) / 3 + 8) return { error: overLimit };
    if (!/^[A-Za-z0-9+/=\r\n]*$/.test(content)) return { error: 'content 不是合法 base64' };
    bytes = Buffer.from(content, 'base64');
  } else {
    // UTF-8 编码字节数恒 ≥ UTF-16 码元数,长度先超即字节必超。
    if (content.length > GHOST_FS_WRITE_MAX_BYTES) return { error: overLimit };
    bytes = Buffer.from(content, 'utf8');
  }
  if (bytes.byteLength > GHOST_FS_WRITE_MAX_BYTES) return { error: overLimit };
  return { bytes };
}

/**
 * 私有目录用量(递归;walker 带条数保险丝,防病态深树卡 event loop)。
 * 保险丝触发 = **失败关闭**(tripped:true,调用方必须拒写):部分统计会低估
 * 用量,失败开放等于配额闸可被"写深链再删文件留目录残骸"绕过(review P1)。
 */
async function dirUsage(root: string): Promise<{ files: number; bytes: number; tripped: boolean }> {
  let files = 0;
  let bytes = 0;
  const stack = [root];
  const FUSE = GHOST_FS_DATA_MAX_FILES * 4;
  let visited = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > FUSE) return { files, bytes, tripped: true };
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) {
        files += 1;
        try {
          bytes += (await fs.promises.stat(full)).size;
        } catch {
          /* 竞态删除,跳过 */
        }
      }
    }
  }
  return { files, bytes, tripped: false };
}

const fail = (message: string): GhostPipeFsResult => ({ ok: false, message });

export class GhostFsSlot {
  /**
   * workdir 写确认的会话级记忆:同 (session, ghost, 目标父目录) 批一次后
   * 本会话免弹(与 mcp-integrations/ghost.ts 的 dirGrantMemory 同哲学:
   * 纯内存、进程生命周期内,不落盘)。
   */
  private readonly workdirGrants = new Set<string>();

  constructor(private readonly deps: FsSlotDeps) {}

  /** 处理一条 fs-request(ghost-pipe:send 的 invoke 返回值即本结果)。 */
  async handleFsRequest(ghostId: string, payload: unknown): Promise<GhostPipeFsResult> {
    try {
      return await this.dispatch(ghostId, payload);
    } catch (err) {
      // 兜底:任何未预期异常都收敛成结构化失败,不给沙箱一个 rejected promise。
      this.deps.log?.warn('ghost fs-request unexpected failure', {
        ghostId,
        error: err instanceof Error ? err.message : String(err),
      });
      return fail('写文件失败(主机内部错误)');
    }
  }

  private async dispatch(ghostId: string, payload: unknown): Promise<GhostPipeFsResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost) return fail('意识未装入');
    if (!ghost.manifest.slots.includes('fs')) {
      return fail('未声明 "fs" 卡槽——想写文件先在 ghost.json 的 slots 里声明 "fs"(装入确认时会向用户如实展示)');
    }
    const req = (payload ?? {}) as Record<string, unknown>;
    const op = req.op as GhostFsOp;
    const root = req.root as GhostFsRoot;
    if (!GHOST_FS_OPS.includes(op)) return fail(`op 必须是 ${GHOST_FS_OPS.join(' / ')}`);
    if (!GHOST_FS_ROOTS.includes(root)) return fail(`root 必须是 ${GHOST_FS_ROOTS.join(' / ')}`);

    if (root === 'data') return this.handleData(ghostId, op, req);
    if (op !== 'write') return fail(`root:"${root}" 只支持 op:"write"(read/list/delete 仅限私有目录 root:"data")`);
    if (root === 'save') return this.handleSaveWrite(ghostId, req);
    return this.handleWorkdirWrite(ghostId, ghost, req);
  }

  /* ── root:'data' 私有数据目录 ─────────────────────────────────────── */

  private async handleData(
    ghostId: string,
    op: GhostFsOp,
    req: Record<string, unknown>,
  ): Promise<GhostPipeFsResult> {
    const base = path.join(this.deps.dataRootDir(), ghostId);

    if (op === 'list') {
      const sub = req.path === undefined ? '' : String(req.path);
      if (sub !== '') {
        const reason = validateFsRelPath(sub);
        if (reason) return fail(reason);
      }
      const listRoot = sub === '' ? base : path.join(base, ...sub.split('/'));
      if (!isInsideDir(base, listRoot)) return fail('path 越界');
      const entries: GhostFsListEntry[] = [];
      let truncated = false;
      const stack = [listRoot];
      while (stack.length > 0 && !truncated) {
        const dir = stack.pop()!;
        let dirents: fs.Dirent[];
        try {
          dirents = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
          continue; // 目录不存在 = 空清单(储物柜还没放过东西,不算错)
        }
        for (const entry of dirents) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
            continue;
          }
          if (!entry.isFile()) continue;
          if (entries.length >= GHOST_FS_LIST_MAX_ENTRIES) {
            truncated = true;
            break;
          }
          try {
            const stat = await fs.promises.stat(full);
            entries.push({
              path: path.relative(base, full).split(path.sep).join('/'),
              bytes: stat.size,
              mtime: Math.round(stat.mtimeMs),
            });
          } catch {
            /* 竞态删除,跳过 */
          }
        }
      }
      return { ok: true, op: 'list', entries, ...(truncated ? { truncated: true } : {}) };
    }

    const reason = validateFsRelPath(req.path);
    if (reason) return fail(reason);
    const relPath = req.path as string;
    const target = path.join(base, ...relPath.split('/'));
    if (!isInsideDir(base, target)) return fail('path 越界');

    // read/delete 的祖先 symlink 校验与 write 对齐(中间目录被植入指向根外
    // 的 symlink 时,经它读/删同样是逃逸);根目录还不存在按"文件不存在"处理。
    if (op === 'read' || op === 'delete') {
      let realBase: string;
      try {
        realBase = await fs.promises.realpath(base);
      } catch {
        if (op === 'delete') return { ok: true, op: 'delete', path: relPath, existed: false };
        return fail(`文件不存在:${relPath}`);
      }
      if (!(await deepestExistingAncestorInside(realBase, target))) return fail('path 越界');
    }

    if (op === 'read') {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.lstat(target);
      } catch {
        return fail(`文件不存在:${relPath}`);
      }
      if (!stat.isFile()) return fail(`不是文件:${relPath}`);
      if (stat.size > GHOST_FS_READ_MAX_BYTES) {
        return fail(`文件超读取上限(${stat.size} 字节 > ${GHOST_FS_READ_MAX_BYTES});请分文件存`);
      }
      const encoding = req.encoding === 'base64' ? 'base64' : 'utf8';
      const buf = await fs.promises.readFile(target);
      return { ok: true, op: 'read', path: relPath, content: buf.toString(encoding), encoding, bytes: buf.byteLength };
    }

    if (op === 'delete') {
      try {
        const stat = await fs.promises.lstat(target);
        if (!stat.isFile()) return fail(`不是文件,不可删除:${relPath}`);
        await fs.promises.unlink(target);
      } catch {
        return { ok: true, op: 'delete', path: relPath, existed: false }; // 幂等
      }
      // 空目录剪枝(向上 rmdir 到 base 为止,遇非空即停):不剪的话目录残骸
      // 永久计入用量扫描的保险丝,"清理后再写"会变成无法执行的建议(review)。
      let dir = path.dirname(target);
      while (isInsideDir(base, dir) && foldCase(dir) !== foldCase(path.resolve(base))) {
        try {
          await fs.promises.rmdir(dir);
        } catch {
          break; // 非空/被占用,到此为止
        }
        dir = path.dirname(dir);
      }
      return { ok: true, op: 'delete', path: relPath, existed: true };
    }

    // op === 'write'
    const decoded = decodeContent(req.content, req.encoding);
    if ('error' in decoded) return fail(decoded.error);
    await fs.promises.mkdir(base, { recursive: true });
    const realBase = await fs.promises.realpath(base);
    if (!(await deepestExistingAncestorInside(realBase, target))) return fail('path 越界');
    try {
      const st = await fs.promises.lstat(target);
      if (st.isSymbolicLink()) return fail('目标是符号链接,拒绝穿透写入');
      if (st.isDirectory()) return fail(`目标是目录:${relPath}`);
    } catch {
      /* 不存在 = 新建,正常 */
    }
    // 配额:总量按"写入后"口径判(覆盖写扣除旧文件体积)。保险丝触发时
    // 拒写(失败关闭)——欠计数的 usage 不能当放行依据。
    const usage = await dirUsage(realBase);
    if (usage.tripped) {
      return fail('私有目录结构过大,无法核算配额;请清理旧文件/目录后再写');
    }
    let existingSize = 0;
    let isNewFile = true;
    try {
      const st = await fs.promises.stat(target);
      existingSize = st.size;
      isNewFile = false;
    } catch {
      /* 新文件 */
    }
    if (isNewFile && usage.files + 1 > GHOST_FS_DATA_MAX_FILES) {
      return fail(`私有目录文件数已达上限(${GHOST_FS_DATA_MAX_FILES});请删除旧文件后再写`);
    }
    if (usage.bytes - existingSize + decoded.bytes.byteLength > GHOST_FS_DATA_MAX_TOTAL_BYTES) {
      return fail(`私有目录容量已达上限(${GHOST_FS_DATA_MAX_TOTAL_BYTES} 字节);请删除旧文件后再写`);
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, decoded.bytes);
    this.deps.log?.info('ghost fs write (data)', { ghostId, relPath, bytes: decoded.bytes.byteLength });
    return { ok: true, op: 'write', path: relPath, bytes: decoded.bytes.byteLength };
  }

  /* ── root:'save' 票据目录(主 agent 过户)─────────────────────────── */

  private async handleSaveWrite(ghostId: string, req: Record<string, unknown>): Promise<GhostPipeFsResult> {
    const token = req.token;
    if (typeof token !== 'string' || token.length === 0) {
      return fail('root:"save" 需要 token(来自 ghost_call 顶层 save_dir 过户注入的 args.save_deposit.token)');
    }
    const reason = validateFsRelPath(req.path);
    if (reason) return fail(reason);
    const decoded = decodeContent(req.content, req.encoding);
    if ('error' in decoded) return fail(decoded.error);
    // 票据目录不展开子目录:只取 basename 语义,消毒/去重由票据库统一做
    //(与 as:'file' 下载同一口径)。
    const fileName = (req.path as string).split('/').pop()!;
    const written = await this.deps.writeSaveDeposit(ghostId, token, fileName, decoded.bytes);
    if (!written) return fail('save 票据无效或预算已用尽(过期/次数/字节;请主 agent 重新过户 save_dir)');
    this.deps.log?.info('ghost fs write (save)', { ghostId, fileName: written.fileName, bytes: decoded.bytes.byteLength });
    return { ok: true, op: 'write', path: written.fileName, bytes: decoded.bytes.byteLength };
  }

  /* ── root:'workdir' 会话工作目录(跟随会话 permission)──────────────── */

  private async handleWorkdirWrite(
    ghostId: string,
    ghost: InstalledGhost,
    req: Record<string, unknown>,
  ): Promise<GhostPipeFsResult> {
    const callId = req.callId;
    if (typeof callId !== 'string' || callId.length === 0) {
      return fail('root:"workdir" 需要 callId(tool-call 下发的归因号;工作目录写入必须发生在派单调用链内)');
    }
    const info = this.deps.callInfo(callId);
    if (!info || info.ghostId !== ghostId) return fail('callId 无效或不属于本意识');
    if (!info.sessionId) return fail('本次调用无会话上下文,无法定位工作目录');
    const session = await this.deps.getSessionSnapshot(info.sessionId);
    if (!session) return fail('会话不存在,无法定位工作目录');
    if (session.remoteHostId) {
      return fail('当前会话是 SSH 远程工作区,工作目录在远端机器,意识写文件暂不支持(请改用 root:"data" 私有目录)');
    }
    if (!session.workingDir || !path.isAbsolute(session.workingDir)) {
      return fail('当前会话没有本地工作目录');
    }
    const reason = validateFsRelPath(req.path);
    if (reason) return fail(reason);
    const relPath = req.path as string;
    const decoded = decodeContent(req.content, req.encoding);
    if ('error' in decoded) return fail(decoded.error);

    let realWorkdir: string;
    try {
      realWorkdir = await fs.promises.realpath(session.workingDir);
    } catch {
      return fail('工作目录不存在');
    }
    const target = path.join(realWorkdir, ...relPath.split('/'));
    if (!isInsideDir(realWorkdir, target)) return fail('path 越界');
    if (!(await deepestExistingAncestorInside(realWorkdir, target))) return fail('path 越界');
    try {
      const st = await fs.promises.lstat(target);
      if (st.isSymbolicLink()) return fail('目标是符号链接,拒绝穿透写入');
      if (st.isDirectory()) return fail(`目标是目录:${relPath}`);
    } catch {
      /* 不存在 = 新建 */
    }

    const verdict = workdirWriteVerdict(session.permissionMode, session.planModeEnabled);
    if (verdict === 'deny') {
      return fail('当前会话处于计划/只读模式,不允许写工作目录');
    }
    if (verdict === 'confirm') {
      const parentDir = path.dirname(target);
      const memoryKey = `${info.sessionId} ${ghostId} ${foldCase(parentDir)}`;
      if (!this.workdirGrants.has(memoryKey)) {
        const decision = await this.deps.requestWriteConfirm(info.sessionId, {
          ghostId,
          ghostName: ghost.manifest.name || ghostId,
          lane: 'fs_write',
          items: [{ name: path.basename(target), absPath: target, size: decoded.bytes.byteLength }],
        });
        if (!decision.confirmed) {
          this.deps.log?.info('ghost fs write (workdir) denied', { ghostId, relPath, reason: decision.reason });
          // 按拒绝原因区分话术:超时/通道未就绪不是"用户点了拒绝",别冤枉用户。
          if (decision.reason === 'timeout') return fail('工作目录写入确认超时,用户未响应');
          if (decision.reason === 'cancelled') return fail('用户拒绝了本次工作目录写入');
          return fail('确认通道未就绪或会话已关闭,本次工作目录写入未执行');
        }
        this.workdirGrants.add(memoryKey);
      }
    }

    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, decoded.bytes);
    this.deps.log?.info('ghost fs write (workdir)', {
      ghostId,
      sessionId: info.sessionId,
      relPath,
      bytes: decoded.bytes.byteLength,
      verdict,
    });
    return { ok: true, op: 'write', path: relPath, bytes: decoded.bytes.byteLength };
  }

  /** 会话关闭时清掉该会话的确认记忆(防 Set 无界增长)。 */
  cleanupForSession(sessionId: string): void {
    const prefix = `${sessionId} `;
    for (const key of Array.from(this.workdirGrants)) {
      if (key.startsWith(prefix)) this.workdirGrants.delete(key);
    }
  }
}
