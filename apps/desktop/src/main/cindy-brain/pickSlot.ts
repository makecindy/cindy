/**
 * pickSlot.ts — 目录选择槽(pick,2026-07-23)。
 * ---------------------------------------------------------------------------
 * 插件经管子上行 `{type:'pick-request', mode:'directory', title?, deposit?}`,
 * 请主机弹**系统级**选文件夹窗口。安全模型(与浏览器文件选择同一哲学):
 *
 * - 资格审:已装、启用、声明 pick 槽;
 * - 授权动作 = 用户在系统对话框里**亲手选中**。取消即拒,插件拿不到任何
 *   路径信息;对话框标题/正文由主机拼装并带插件名(用户永远知道谁在要);
 *   title 只是净化后的用途说明片段,伪装不了主机文案;
 * - 骚扰钳制:同一插件两次请求最小间隔 GHOST_PICK_MIN_INTERVAL_MS(按尝试
 *   记账,spam 顺延窗口),全局同时只允许一个选择框在场(BUSY)——恶意
 *   循环刷不起系统弹窗;
 * - 结果分档:
 *   · dir_deposit 票据(deposit:true;同 ghost_call dir 通道,主机代办上传
 *     凭票取件,绝对路径与字节不进沙箱);
 *   · 绝对路径只给声明了 node 槽的插件——Node 侧本就有当前系统用户级本机
 *     权限,给路径不构成扩权,价值在于把"用户选了哪个目录"这一事实**可信**
 *     地交过去;未声明 node 槽的插件必须请求票据,否则拒单。
 *
 * 纯逻辑 + 依赖注入(规则 14):Electron dialog / 票据库在 cindy-brain/index.ts
 * 组装时注入,单测喂假 deps 直测。
 */

import path from 'node:path';

import {
  GHOST_PICK_MIN_INTERVAL_MS,
  GHOST_PICK_TITLE_MAX_CHARS,
  type DirDepositReceiptShape,
  type GhostPipePickResult,
  type InstalledGhost,
} from '../../shared/ghost.js';
import { sanitizeGhostNoticeText } from './notifySlot.js';

export interface PickSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /**
   * 弹系统级选文件夹窗口;返回所选绝对路径,取消返回 null。
   * 找不到可挂靠的 Cindy 窗口时应 reject(失败关闭,不弹无主对话框)。
   */
  showDirectoryDialog(params: { ghostName: string; purpose: string | null }): Promise<string | null>;
  /** 签发目录过户票据(dirDeposit.deposit,userGranted 语义 = 用户已亲手选中)。 */
  depositDir(
    ghostId: string,
    dirAbs: string,
  ): { ok: true; receipt: DirDepositReceiptShape } | { ok: false; message: string };
  /**
   * 亲选目录进台账(pickGrantsStore):errand 等能力据此对账"插件转述的
   * 目录确实是用户亲手选过的"。只在成功交付(非取消)时调用。
   */
  recordPickedDir?(ghostId: string, dirAbs: string): void;
  now?(): number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

function fail(
  errorCode: Extract<GhostPipePickResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipePickResult {
  return { ok: false, errorCode, message };
}

/** 目录选择槽:资格审 → 限速/单发 → 系统对话框 → 分档发结果。 */
export class GhostPickSlot {
  /** 意识 id → 上次尝试时刻(按尝试记账;体量 = 已装意识数,无需清理)。 */
  private readonly lastAttemptAt = new Map<string, number>();
  /** 全局在场对话框标记(系统弹窗一次一个,不排队——排队就是骚扰队列)。 */
  private dialogInFlight = false;

  constructor(private readonly deps: PickSlotDeps) {}

  async handleRequest(ghostId: string, payload: unknown): Promise<GhostPipePickResult> {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.slots.includes('pick')) {
      return fail('PERMISSION_DENIED', '插件未申请目录选择权限(pick 槽),或当前未启用');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return fail('INVALID_REQUEST', 'pick-request 载荷必须是对象');
    }
    const request = payload as Record<string, unknown>;
    if (request.mode !== 'directory') {
      return fail('INVALID_REQUEST', 'mode 目前只支持 "directory"');
    }
    if (request.title !== undefined && typeof request.title !== 'string') {
      return fail('INVALID_REQUEST', 'title 必须是字符串');
    }
    if (request.deposit !== undefined && typeof request.deposit !== 'boolean') {
      return fail('INVALID_REQUEST', 'deposit 必须是布尔值');
    }
    const wantDeposit = request.deposit === true;
    const hasNode = ghost.manifest.slots.includes('node');
    if (!hasNode && !wantDeposit) {
      return fail(
        'INVALID_REQUEST',
        '未声明 node 槽的插件必须带 deposit:true(选完只有过户票据可发,不给绝对路径)',
      );
    }

    // 骚扰钳制:限速按尝试记账(spam 顺延窗口),再看全局在场标记。
    const now = this.deps.now?.() ?? Date.now();
    const last = this.lastAttemptAt.get(ghostId);
    this.lastAttemptAt.set(ghostId, now);
    if (last !== undefined && now - last < GHOST_PICK_MIN_INTERVAL_MS) {
      return fail('RATE_LIMITED', '目录选择请求太频繁,稍后再试');
    }
    if (this.dialogInFlight) {
      return fail('BUSY', '已有一个选择窗口在等用户操作');
    }

    const purposeRaw =
      typeof request.title === 'string' ? sanitizeGhostNoticeText(request.title) : '';
    const purpose = purposeRaw ? purposeRaw.slice(0, GHOST_PICK_TITLE_MAX_CHARS) : null;

    this.dialogInFlight = true;
    let picked: string | null;
    try {
      picked = await this.deps.showDirectoryDialog({
        ghostName: ghost.manifest.name,
        purpose,
      });
    } catch (error) {
      this.deps.log?.warn('ghost pick dialog failed', {
        ghostId,
        err: error instanceof Error ? error.message : String(error),
      });
      return fail('INTERNAL', '选择窗口无法打开');
    } finally {
      this.dialogInFlight = false;
    }
    if (picked === null) {
      return fail('CANCELLED', '用户取消了选择');
    }
    // 用户已亲手选中:先记台账再分档发结果(票据签发失败也不该丢掉这次
    // 授权事实——用户确实选了)。
    this.deps.recordPickedDir?.(ghostId, picked);

    const result: Extract<GhostPipePickResult, { ok: true }> = {
      ok: true,
      name: path.basename(picked),
    };
    if (wantDeposit) {
      const deposited = this.deps.depositDir(ghostId, picked);
      if (!deposited.ok) {
        // 用户已亲选但票据签不出(如超过收集上限):如实报错,不发半成品。
        return fail('INTERNAL', `目录过户票据签发失败:${deposited.message}`);
      }
      result.dir_deposit = deposited.receipt;
    }
    if (hasNode) {
      result.path = picked;
    }
    this.deps.log?.info('ghost pick granted', {
      ghostId,
      withDeposit: wantDeposit,
      withPath: hasNode,
    });
    return result;
  }
}
