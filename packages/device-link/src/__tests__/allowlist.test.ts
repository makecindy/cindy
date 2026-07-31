/**
 * allowlist 单测:守住「默认拒绝」语义 + 关键 channel 准入 / 拒绝边界。
 * 这是远程控制的安全闸门,回归必须显式。
 */
import { describe, it, expect } from 'vitest';
import {
  REMOTE_INVOKE_ALLOWLIST,
  PUSH_FORWARD_ALLOWLIST,
  INVOKE_TIMEOUT_OVERRIDES_MS,
  computeAllowlistHash,
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
  DL_MEDIA_FETCH_CHANNEL,
  DL_VOICE_TRANSCRIBE_CHANNEL,
  DL_VOICE_CREDENTIAL_SYNC_CHANNEL,
  DL_VOICE_DICTIONARY_LEARNING_CHANNEL,
  DL_HISTORY_MESSAGES_CHANNEL,
} from '../allowlist.js';
import { SESSION_ACTIVITY_CHANNEL } from '../topics.js';

describe('REMOTE_INVOKE_ALLOWLIST', () => {
  it('放行核心会话链路', () => {
    for (const ch of [
      'maker:create-session',
      'maker:send',
      'maker:abort-session',
      'maker:resolve-interaction',
      'maker:get-pending-interactions',
      'maker:input:compact',
      'maker:set-model',
      'maker:switch-session-agent',
      'maker:get-session-agent-switch-intent',
      'local-db:sessions:list',
      DL_HISTORY_MESSAGES_CHANNEL,
      'local-db:messages:list',
      'local-db:messages:around',
      'local-db:messages:around-client-id',
      'maker:message:delete',
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('放行订阅价值历史汇总只读聚合(远程会话底部 $ chip 的历史初值查被控端)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('local-db:messages:estimatedSessionValue')).toBe(true);
  });

  it('放行 per-session turn 态只读查询(控制端 stall 看门狗核实被控端用)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:session-in-turn')).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:any-session-in-turn')).toBe(true);
  });

  it('放行会话未读已读回执(控制端看完会话,清被控端灵动岛 / 角标 / 侧栏未读)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('notification:clear-session-attention')).toBe(true);
    // mark 方向不放行:未读的产生真相只在被控端 main,远程不得凭空标未读。
    expect(REMOTE_INVOKE_ALLOWLIST.has('notification:mark-session-attention')).toBe(false);
  });

  it('放行 M4 完整控制面(scheduler / orca / rewind / 只读 usage)', () => {
    for (const ch of [
      'maker:schedule:create',
      'maker:schedule:get-runtime-state',
      'maker:worker:create',
      'maker:session:enable-orca',
      'maker:rewind:commit',
      'maker:fork',
      'maker:usage:today',
      'maker:memory:get',
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('放行 workflow 逐 agent 进度树只读(记录文件真相在被控端 HOME,控制端本机读必落空)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:get-workflow-progress')).toBe(true);
  });

  it('放行会话后台任务快照只读(任务真身在被控端,后台任务面板挂载水合用)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:session-background-tasks:list')).toBe(true);
  });

  it('放行会话级完整对等补充(fork-strip / context-usage / 窄口径 patch-meta / Magic 重命名)', () => {
    for (const ch of [
      'maker:fork-strip-encrypted',
      'maker:get-context-usage',
      'local-db:sessions:patch-meta',
      'maker:generate-title',
      'maker:regenerate-title',
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('放行 device-link 远程草稿镜像只读读(控制端 seed 被控端当前 New Maker 草稿)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:get-new-maker-defaults')).toBe(true);
  });

  it('放行 device-link 模型列表 effort/fast 写穿(草稿 + 会话非选中,控制端→被控端)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:apply-new-maker-draft-pref')).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:set-session-model-pref')).toBe(true);
  });

  it('放行模型单价表只读(控制端模型选择器展示被控端视角单价)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:usage:model-pricing')).toBe(true);
  });

  it('放行 Codex 官方额度读取与 desktop 绑定的人工 reset offer', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:usage:codex-rate-limits')).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:usage:codex-rate-limit-reset')).toBe(true);
  });

  it('放行 Git safety 只读查询(远程 Codex Rewind 按被控端 snapshot 设置 gate)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:git-safety:get')).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:git-safety:set')).toBe(false);
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:git-safety:reset')).toBe(false);
  });

  it('放行网关 API key presence-only 探测(只回 boolean,不回密钥材料)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('maker:api-key:present')).toBe(true);
    // 真正的密钥读写仍绝不放行(下方「绝不放行」与不变式守卫共同看住)。
    expect(REMOTE_INVOKE_ALLOWLIST.has('api-key:save')).toBe(false);
    expect(REMOTE_INVOKE_ALLOWLIST.has('api-key:get')).toBe(false);
  });

  it('放行本机目录浏览(「添加远程项目」逐级选被控端项目目录:只读枚举 + mkdir -p)', () => {
    for (const ch of ['fs:list-dir', 'fs:stat-path', 'fs:mkdir-p']) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('放行窄口径文本文件预览(只读 + 大小上限 + forbidden/oversize reason)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('text-file:read-preview')).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has('read-file-for-attachment')).toBe(false);
    // 同理:read-file-bytes 回整个文件的原始字节(PDF 预览用),调用方永远是被控端
    // 本机 renderer,远程控制端不需要、也不得拿到这条通道。
    expect(REMOTE_INVOKE_ALLOWLIST.has('read-file-bytes')).toBe(false);
  });

  it('放行 /goal 远程(goal-host 在被控端,per-session 业务写)', () => {
    for (const ch of [
      'maker:goal:set',
      'maker:goal:clear',
      'maker:goal:get-status',
      'maker:goal:pause',
      'maker:goal:resume',
      'maker:goal:update',
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('放行 /learn 远程(learn-host 全流程在被控端,skill 落被控端)', () => {
    for (const ch of [
      'learn:start',
      'learn:list-runs',
      'learn:get-proposal-diff',
      'learn:apply',
      'learn:discard',
      'learn:cancel',
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('放行 /cmd 远程(被控端 workingDir 执行,cwd 过 remote-workdir-guard)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('desktop-cmd:run')).toBe(true);
  });

  it('放行远程 worktree(git 探测 / 分支 / 建议名 / 删除预检只读 + create)', () => {
    for (const ch of [
      'worktree:detect-cwd',
      'worktree:list-branches',
      'worktree:suggest-name',
      'worktree:create',
      'worktree:removal-preview',
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
    // 实际删除与 reveal 不放行:删除只在被控端状态变更流程内部触发,
    // reveal 是本机 shell 副作用(shell.showItemInFolder)。
    expect(REMOTE_INVOKE_ALLOWLIST.has('worktree:reveal')).toBe(false);
    expect(REMOTE_INVOKE_ALLOWLIST.has('worktree:get-for-session')).toBe(false);
    expect(REMOTE_INVOKE_ALLOWLIST.has('worktree:list-all')).toBe(false);
  });

  it('放行订阅控制帧(push 驱动:subscribe / unsubscribe)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('device-link:subscribe')).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has('device-link:unsubscribe')).toBe(true);
    // 常量与字面量一致(契约稳定)
    expect(DL_SUBSCRIBE_CHANNEL).toBe('device-link:subscribe');
    expect(DL_UNSUBSCRIBE_CHANNEL).toBe('device-link:unsubscribe');
  });

  it('放行入方向媒体取件帧(被控端 dispatch 拦截执行;契约 + 能力探测)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('device-link:media:fetch')).toBe(true);
    expect(DL_MEDIA_FETCH_CHANNEL).toBe('device-link:media:fetch');
  });

  it('放行手机语音转写帧(手机上传 OSS,被控端用本机 ASR 配置转写)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('device-link:voice:transcribe')).toBe(true);
    expect(DL_VOICE_TRANSCRIBE_CHANNEL).toBe('device-link:voice:transcribe');
  });

  it('放行手机语音 credential 临时同步帧(仅 voice ASR/refine 专用,非通用 key 读写)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('device-link:voice:credential-sync')).toBe(true);
    expect(DL_VOICE_CREDENTIAL_SYNC_CHANNEL).toBe('device-link:voice:credential-sync');
  });

  it('放行手机语音词典学习 evidence 回写帧(词典仍写在被控桌面)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has('device-link:voice:dictionary-learning')).toBe(true);
    expect(DL_VOICE_DICTIONARY_LEARNING_CHANNEL).toBe('device-link:voice:dictionary-learning');
  });

  it('绝不放行:本机副作用 / 全局设置写 / 账号密钥 / 裸写库 / 窗口 UI', () => {
    for (const ch of [
      'shell:open-path',
      'maker:compat-mode:set',
      'maker:lsp-mode:set',
      'maker:memory:set',
      'maker:codex-auth-mode:set',
      'auth:trigger-login',
      'maker:auth:trigger-login',
      'maker:auth:logout',
      'api-key:save',
      'local-db:sessions:create',
      'local-db:sessions:update',
      'local-db:messages:create',
      'maker:execute-desktop-command',
      'maker:open-session-in-new-window',
      'show-open-directory-dialog',
      'window-minimize',
      'page-zoom:in',
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(false);
    }
  });

  it('不变式守卫:全表扫描,任何命中危险模式的 channel 都不得入表(挡未来误加)', () => {
    // 把「永不放行」的类别从 prose 注释固化成可执行不变式:未来若有人往 allowlist 里
    // 误加 auth:* / shell:* / 裸写库 / 全局设置写 / 本机 UI 副作用等,这条直接红。
    // 模式刻意避开合法项:maker:set-model(per-session 运行时切换)不以 `:set` 结尾,
    // maker:schedule:create(业务 handler)无 `local-db:` 前缀。
    const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
      { re: /^auth:/, why: '顶层账号鉴权' },
      { re: /^shell:/, why: 'shell 副作用' },
      { re: /^(window[-:]|page-zoom|find-in-page)/, why: '窗口 / UI' },
      { re: /api-key|safe-storage/, why: '密钥 / 安全存储' },
      { re: /^local-db:.*:(create|update|delete)$/, why: 'local-db 裸写' },
      // maker:goal:set 是 per-session 业务写(入参带 sessionId、goal-host 按会话管理),
      // 不属「全局设置写」;显式豁免,其余任何 :set 结尾 channel 仍然拦。
      { re: /^(?!maker:goal:set$).*:set$/, why: '全局设置写' },
      { re: /execute-desktop-command|open-session-in-new-window|show-open-directory-dialog/, why: '本机 UI 副作用' },
      { re: /updater|release-notes|session-import|migration/, why: 'updater / 导入 / 迁移' },
    ];
    // 显式豁免:
    //  - `maker:goal:set` 是 per-session 域动作(入参带 sessionId,只影响单个任务的
    //    目标状态机),与 compat-mode:set / memory:set 这类全局设置写不同类,同类的
    //    maker:set-permission-mode 本就放行;仅命名撞上 `:set$` 模式。
    //  - `maker:api-key:present` 是 presence-only 探测:只回 { present: boolean },
    //    不回、也永不扩展为读取密钥材料(handler 见 desktop authHandlers.ts)。密钥类
    //    通用读写(api-key:save/get、safe-storage)仍被本模式看住,禁止再加同前缀通道。
    const FORBIDDEN_EXEMPT = new Set(['maker:goal:set', 'maker:api-key:present']);
    for (const ch of REMOTE_INVOKE_ALLOWLIST) {
      if (FORBIDDEN_EXEMPT.has(ch)) continue;
      for (const { re, why } of FORBIDDEN) {
        expect(re.test(ch), `${ch} 命中禁止模式(${why}),不得进 REMOTE_INVOKE_ALLOWLIST`).toBe(false);
      }
    }
  });
});

describe('PUSH_FORWARD_ALLOWLIST', () => {
  it('转发事件流 / 交互 / 读模型增量', () => {
    for (const ch of [
      'maker:event',
      'maker:status-changed',
      'maker:interaction-request',
      'maker:interaction-dismissed',
      'maker:auto-permission:fallback',
      'maker:provider:changed',
      'maker:schedule:event',
      'maker:orca:worker-changed',
      'usage:message-turn-cost',
      'usage:session-spend-changed',
      'usage:session-tokens-changed',
      'local-db:messages:created',
      'local-db:messages:deleted',
      'local-db:session:error-persisted',
      SESSION_ACTIVITY_CHANNEL,
    ]) {
      expect(PUSH_FORWARD_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('转发 device-link 模型列表变更(草稿全量 + 会话非选中)', () => {
    expect(PUSH_FORWARD_ALLOWLIST.has('maker:new-maker-draft:changed')).toBe(true);
    expect(PUSH_FORWARD_ALLOWLIST.has('maker:session-model-pref:changed')).toBe(true);
  });

  it('转发 /goal 状态变化与 /learn run 状态机流转', () => {
    expect(PUSH_FORWARD_ALLOWLIST.has('maker:goal:status-changed')).toBe(true);
    expect(PUSH_FORWARD_ALLOWLIST.has('learn:event')).toBe(true);
  });

  it('不转发任意未列 channel(防意外泄露本机 UI 事件)', () => {
    expect(PUSH_FORWARD_ALLOWLIST.has('maker:desktop-command-triggered')).toBe(false);
    // 死条目已移除:发射点不 tap、控制端不消费,放白名单只会误导。
    expect(PUSH_FORWARD_ALLOWLIST.has('maker:auth:state-changed')).toBe(false);
  });
});

describe('INVOKE_TIMEOUT_OVERRIDES_MS', () => {
  it('desktop-cmd:run 隧道超时必须大于被控端执行预算(30s CMD + 5s kill 宽限)', () => {
    // 对撞回归:隧道默认 30s == 被控端命令超时 30s → 慢命令结果被丢弃且看不到 timedOut 语义。
    expect(INVOKE_TIMEOUT_OVERRIDES_MS['desktop-cmd:run']).toBeGreaterThan(35_000);
  });

  it('覆盖表内的 channel 必须都在 REMOTE_INVOKE_ALLOWLIST(不给白名单外通道配超时)', () => {
    for (const ch of Object.keys(INVOKE_TIMEOUT_OVERRIDES_MS)) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch), `${ch} 不在 allowlist`).toBe(true);
    }
  });

  it('worktree:create 隧道超时必须大于默认 30s(git worktree add + 选择性 checkout 预算)', () => {
    expect(INVOKE_TIMEOUT_OVERRIDES_MS['worktree:create']).toBeGreaterThan(30_000);
  });
});

describe('computeAllowlistHash', () => {
  it('稳定且确定(同一 allowlist 多次计算一致)', () => {
    expect(computeAllowlistHash()).toBe(computeAllowlistHash());
    expect(computeAllowlistHash()).toMatch(/^[0-9a-f]{8}$/);
  });
});
