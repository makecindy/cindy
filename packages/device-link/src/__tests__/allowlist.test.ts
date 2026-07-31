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
  DL_TELEGRAM_STATUS_CHANNEL,
  DL_TELEGRAM_SET_ONLINE_CHANNEL,
} from '../allowlist.js';
import { SESSION_ACTIVITY_CHANNEL } from '../topics.js';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

describe('REMOTE_INVOKE_ALLOWLIST', () => {
  it('放行核心会话链路', () => {
    for (const ch of [
      IPC_CHANNELS.MAKER_INVOKE.CREATE_SESSION,
      IPC_CHANNELS.MAKER_INVOKE.SEND,
      IPC_CHANNELS.MAKER_INVOKE.ABORT_SESSION,
      IPC_CHANNELS.MAKER_INVOKE.RESOLVE_INTERACTION,
      IPC_CHANNELS.MAKER_INVOKE.GET_PENDING_INTERACTIONS,
      IPC_CHANNELS.MAKER_INVOKE.INPUT_COMPACT,
      IPC_CHANNELS.MAKER_INVOKE.SET_MODEL,
      IPC_CHANNELS.MAKER_INVOKE.SWITCH_SESSION_AGENT,
      IPC_CHANNELS.MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT,
      IPC_CHANNELS.LOCAL_DB.SESSIONS_LIST,
      IPC_CHANNELS.LOCAL_DB.CONVERSATIONS_SEARCH,
      DL_HISTORY_MESSAGES_CHANNEL,
      IPC_CHANNELS.LOCAL_DB.MESSAGES_LIST,
      IPC_CHANNELS.LOCAL_DB.MESSAGES_AROUND,
      IPC_CHANNELS.LOCAL_DB.MESSAGES_AROUND_CLIENT_ID,
      IPC_CHANNELS.MAKER_INVOKE.DELETE_MESSAGE,
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('允许远程会话读取被控端 Git / GitHub 上下文', () => {
    for (const ch of [
      'git-context:get-for-session',
      'git-context:pr-refs:list',
      'git-context:pr-status',
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('放行订阅价值历史汇总只读聚合(远程会话底部 $ chip 的历史初值查被控端)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.LOCAL_DB.MESSAGES_ESTIMATED_SESSION_VALUE)).toBe(true);
  });

  it('放行 per-session turn 态只读查询(控制端 stall 看门狗核实被控端用)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.SESSION_IN_TURN)).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.ANY_SESSION_IN_TURN)).toBe(true);
  });

  it('放行会话未读已读回执(控制端看完会话,清被控端灵动岛 / 角标 / 侧栏未读)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.NOTIFICATION.CLEAR_SESSION_ATTENTION)).toBe(true);
    // mark 方向不放行:未读的产生真相只在被控端 main,远程不得凭空标未读。
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.NOTIFICATION.MARK_SESSION_ATTENTION)).toBe(false);
  });

  it('放行 M4 完整控制面(scheduler / orca / rewind / 只读 usage)', () => {
    for (const ch of [
      IPC_CHANNELS.MAKER_INVOKE.SCHEDULE_CREATE,
      IPC_CHANNELS.MAKER_INVOKE.SCHEDULE_GET_RUNTIME_STATE,
      IPC_CHANNELS.MAKER_INVOKE.WORKER_CREATE,
      IPC_CHANNELS.MAKER_INVOKE.SESSION_ENABLE_ORCA,
      IPC_CHANNELS.MAKER_INVOKE.REWIND_COMMIT,
      IPC_CHANNELS.MAKER_INVOKE.FORK,
      IPC_CHANNELS.MAKER_INVOKE.USAGE_TODAY,
      IPC_CHANNELS.MAKER_INVOKE.MEMORY_GET,
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
    expect(REMOTE_INVOKE_ALLOWLIST.has('local-db:orca-workflows:list-workers-by-leads')).toBe(false);
  });

  it('放行 workflow 逐 agent 进度树只读(记录文件真相在被控端 HOME,控制端本机读必落空)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.GET_WORKFLOW_PROGRESS)).toBe(true);
  });

  it('放行会话后台任务快照只读(任务真身在被控端,后台任务面板挂载水合用)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.LIST_SESSION_BACKGROUND_TASKS)).toBe(true);
  });

  it('放行会话级完整对等补充(fork-strip / context-usage / 窄口径 patch-meta / Magic 重命名)', () => {
    for (const ch of [
      IPC_CHANNELS.MAKER_INVOKE.FORK_STRIP_ENCRYPTED,
      IPC_CHANNELS.MAKER_INVOKE.GET_CONTEXT_USAGE,
      IPC_CHANNELS.LOCAL_DB.SESSIONS_PATCH_META,
      IPC_CHANNELS.MAKER_INVOKE.GENERATE_TITLE,
      IPC_CHANNELS.MAKER_INVOKE.REGENERATE_TITLE,
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('放行 device-link 远程草稿镜像只读读(控制端 seed 被控端当前 New Maker 草稿)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.GET_NEW_MAKER_DEFAULTS)).toBe(true);
  });

  it('放行 device-link 模型列表 effort/fast 写穿(草稿 + 会话非选中,控制端→被控端)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.APPLY_NEW_MAKER_DRAFT_PREF)).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.SET_SESSION_MODEL_PREF)).toBe(true);
  });

  it('放行模型单价表只读(控制端模型选择器展示被控端视角单价)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.USAGE_MODEL_PRICING)).toBe(true);
  });

  it('放行 Codex 官方额度读取与 desktop 绑定的人工 reset offer', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.USAGE_CODEX_RATE_LIMITS)).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.USAGE_CODEX_RATE_LIMIT_RESET)).toBe(true);
  });

  it('放行 Git safety 只读查询(远程 Codex Rewind 按被控端 snapshot 设置 gate)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.GIT_SAFETY_GET)).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.GIT_SAFETY_SET)).toBe(false);
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.GIT_SAFETY_RESET)).toBe(false);
  });

  it('放行网关 API key presence-only 探测(只回 boolean,不回密钥材料)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.MAKER_INVOKE.API_KEY_PRESENT)).toBe(true);
    // 真正的密钥读写仍绝不放行(下方「绝不放行」与不变式守卫共同看住)。
    expect(REMOTE_INVOKE_ALLOWLIST.has('api-key:save')).toBe(false);
    expect(REMOTE_INVOKE_ALLOWLIST.has('api-key:get')).toBe(false);
  });

  it('放行本机目录浏览(「添加远程项目」逐级选被控端项目目录:只读枚举 + mkdir -p)', () => {
    for (const ch of [IPC_CHANNELS.FS.LIST_DIR, IPC_CHANNELS.FS.STAT_PATH, IPC_CHANNELS.FS.MKDIR_P]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('放行窄口径文本文件预览(只读 + 大小上限 + forbidden/oversize reason)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.TEXT_FILE.READ_PREVIEW)).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.READ_FILE_FOR_ATTACHMENT.READ_FILE_FOR_ATTACHMENT)).toBe(false);
    // 同理:read-file-bytes 回整个文件的原始字节(PDF 预览用),调用方永远是被控端
    // 本机 renderer,远程控制端不需要、也不得拿到这条通道。
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.READ_FILE_BYTES.READ_FILE_BYTES)).toBe(false);
  });

  it('放行 /goal 远程(goal-host 在被控端,per-session 业务写)', () => {
    for (const ch of [
      IPC_CHANNELS.MAKER_INVOKE.GOAL_SET,
      IPC_CHANNELS.MAKER_INVOKE.GOAL_CLEAR,
      IPC_CHANNELS.MAKER_INVOKE.GOAL_GET_STATUS,
      IPC_CHANNELS.MAKER_INVOKE.GOAL_PAUSE,
      IPC_CHANNELS.MAKER_INVOKE.GOAL_RESUME,
      IPC_CHANNELS.MAKER_INVOKE.GOAL_UPDATE,
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('放行 /learn 远程(learn-host 全流程在被控端,skill 落被控端)', () => {
    for (const ch of [
      IPC_CHANNELS.LEARN.START,
      IPC_CHANNELS.LEARN.LIST_RUNS,
      IPC_CHANNELS.LEARN.GET_PROPOSAL_DIFF,
      IPC_CHANNELS.LEARN.APPLY,
      IPC_CHANNELS.LEARN.DISCARD,
      IPC_CHANNELS.LEARN.CANCEL,
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('放行 /cmd 远程(被控端 workingDir 执行,cwd 过 remote-workdir-guard)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.DESKTOP_CMD.RUN)).toBe(true);
  });

  it('放行远程 worktree(git 探测 / 分支 / 建议名 / 删除预检 + create / 窄补偿回收)', () => {
    for (const ch of [
      IPC_CHANNELS.WORKTREE.DETECT_CWD,
      IPC_CHANNELS.WORKTREE.LIST_BRANCHES,
      IPC_CHANNELS.WORKTREE.SUGGEST_NAME,
      IPC_CHANNELS.WORKTREE.CREATE,
      IPC_CHANNELS.WORKTREE.DISCARD_PRECREATED,
      IPC_CHANNELS.WORKTREE.REMOVAL_PREVIEW,
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(true);
    }
    // 通用删除与 reveal 不放行:discard-precreated 只接受 sessionId + 已登记的
    // 精确 path,或 create 前已持久化且与被控端元数据匹配的 recoveryKey,并由
    // 被控端复核 ownership/dirty/live refs;其余删除仍只在被控端状态变更流程
    // 内部触发。reveal 是本机 shell 副作用(shell.showItemInFolder)。
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.WORKTREE.REVEAL)).toBe(false);
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.WORKTREE.GET_FOR_SESSION)).toBe(false);
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.WORKTREE.LIST_ALL)).toBe(false);
    expect(REMOTE_INVOKE_ALLOWLIST.has('worktree:remove')).toBe(false);
  });

  it('放行订阅控制帧(push 驱动:subscribe / unsubscribe)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.DEVICE_LINK.SUBSCRIBE)).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.DEVICE_LINK.UNSUBSCRIBE)).toBe(true);
    // 常量与字面量一致(契约稳定)
    expect(DL_SUBSCRIBE_CHANNEL).toBe(IPC_CHANNELS.DEVICE_LINK.SUBSCRIBE);
    expect(DL_UNSUBSCRIBE_CHANNEL).toBe(IPC_CHANNELS.DEVICE_LINK.UNSUBSCRIBE);
  });

  it('放行入方向媒体取件帧(被控端 dispatch 拦截执行;契约 + 能力探测)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.DEVICE_LINK.MEDIA_FETCH)).toBe(true);
    expect(DL_MEDIA_FETCH_CHANNEL).toBe(IPC_CHANNELS.DEVICE_LINK.MEDIA_FETCH);
  });

  it('放行手机语音转写帧(手机上传 OSS,被控端用本机 ASR 配置转写)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.DEVICE_LINK.VOICE_TRANSCRIBE)).toBe(true);
    expect(DL_VOICE_TRANSCRIBE_CHANNEL).toBe(IPC_CHANNELS.DEVICE_LINK.VOICE_TRANSCRIBE);
  });

  it('放行手机语音 credential 临时同步帧(仅 voice ASR/refine 专用,非通用 key 读写)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.DEVICE_LINK.VOICE_CREDENTIAL_SYNC)).toBe(true);
    expect(DL_VOICE_CREDENTIAL_SYNC_CHANNEL).toBe(IPC_CHANNELS.DEVICE_LINK.VOICE_CREDENTIAL_SYNC);
  });

  it('放行手机语音词典学习 evidence 回写帧(词典仍写在被控桌面)', () => {
    expect(REMOTE_INVOKE_ALLOWLIST.has(IPC_CHANNELS.DEVICE_LINK.VOICE_DICTIONARY_LEARNING)).toBe(true);
    expect(DL_VOICE_DICTIONARY_LEARNING_CHANNEL).toBe(IPC_CHANNELS.DEVICE_LINK.VOICE_DICTIONARY_LEARNING);
  });

  it('放行个人 Telegram bot 的跨设备上下线(窄口径例外),但本地那条 IPC 仍绝不放行', () => {
    // 放行的是两条 device-link 专用通道:被控端 dispatch 拦截执行, 只切轮询。
    expect(REMOTE_INVOKE_ALLOWLIST.has(DL_TELEGRAM_STATUS_CHANNEL)).toBe(true);
    expect(REMOTE_INVOKE_ALLOWLIST.has(DL_TELEGRAM_SET_ONLINE_CHANNEL)).toBe(true);
    // 本地 IM IPC 一律不得入表:它们在 im/host.ts 统一挂了
    // assertTrustedAppRendererEvent(只认真实 sender), 是有意拦住 IM 凭证/配置面的
    // 闸门。未来若有人图省事把 telegramBot:* 加进来, 这条直接红 —— 尤其
    // disconnect / set-config 会清凭证或换 token, 远程绝不该碰。
    for (const ch of [
      'telegramBot:set-online',
      'telegramBot:disconnect',
      'telegramBot:set-config',
      'telegramBot:get-status',
      'discordBot:set-config',
      'feishuBot:set-config',
    ]) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch)).toBe(false);
    }
  });

  it('绝不放行:本机副作用 / 全局设置写 / 账号密钥 / 裸写库 / 窗口 UI', () => {
    for (const ch of [
      IPC_CHANNELS.SHELL.OPEN_PATH,
      'maker:compat-mode:set',
      IPC_CHANNELS.MAKER_INVOKE.LSP_MODE_SET,
      IPC_CHANNELS.MAKER_INVOKE.MEMORY_SET,
      'maker:codex-auth-mode:set',
      'auth:trigger-login',
      IPC_CHANNELS.MAKER_INVOKE.AUTH_TRIGGER_LOGIN,
      IPC_CHANNELS.MAKER_INVOKE.AUTH_LOGOUT,
      'api-key:save',
      IPC_CHANNELS.LOCAL_DB.SESSIONS_CREATE,
      IPC_CHANNELS.LOCAL_DB.SESSIONS_UPDATE,
      IPC_CHANNELS.LOCAL_DB.MESSAGES_CREATE,
      IPC_CHANNELS.MAKER_INVOKE.EXECUTE_DESKTOP_COMMAND,
      IPC_CHANNELS.MAKER_INVOKE.OPEN_SESSION_IN_NEW_WINDOW,
      IPC_CHANNELS.SHOW_OPEN_DIRECTORY_DIALOG.SHOW_OPEN_DIRECTORY_DIALOG,
      IPC_CHANNELS.WINDOW_MINIMIZE.WINDOW_MINIMIZE,
      IPC_CHANNELS.PAGE_ZOOM.IN,
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
    const FORBIDDEN_EXEMPT = new Set<string>([
      IPC_CHANNELS.MAKER_INVOKE.GOAL_SET,
      IPC_CHANNELS.MAKER_INVOKE.API_KEY_PRESENT,
    ]);
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
      IPC_CHANNELS.MAKER_PUSH.EVENT,
      IPC_CHANNELS.MAKER_PUSH.STATUS_CHANGED,
      IPC_CHANNELS.MAKER_PUSH.INTERACTION_REQUEST,
      IPC_CHANNELS.MAKER_PUSH.INTERACTION_DISMISSED,
      IPC_CHANNELS.MAKER_PUSH.AUTO_PERMISSION_FALLBACK,
      IPC_CHANNELS.MAKER_PUSH.PROVIDER_CHANGED,
      IPC_CHANNELS.MAKER_PUSH.SCHEDULE_EVENT,
      IPC_CHANNELS.MAKER_PUSH.ORCA_WORKER_CHANGED,
      IPC_CHANNELS.USAGE.MESSAGE_TURN_COST,
      IPC_CHANNELS.USAGE.SESSION_SPEND_CHANGED,
      IPC_CHANNELS.USAGE.SESSION_TOKENS_CHANGED,
      IPC_CHANNELS.LOCAL_DB.MESSAGES_CREATED,
      IPC_CHANNELS.LOCAL_DB.MESSAGES_DELETED,
      IPC_CHANNELS.LOCAL_DB.SESSION_ERROR_PERSISTED,
      SESSION_ACTIVITY_CHANNEL,
    ]) {
      expect(PUSH_FORWARD_ALLOWLIST.has(ch)).toBe(true);
    }
  });

  it('转发 device-link 模型列表变更(草稿全量 + 会话非选中)', () => {
    expect(PUSH_FORWARD_ALLOWLIST.has(IPC_CHANNELS.MAKER_PUSH.NEW_MAKER_DRAFT_CHANGED)).toBe(true);
    expect(PUSH_FORWARD_ALLOWLIST.has(IPC_CHANNELS.MAKER_PUSH.SESSION_MODEL_PREF_CHANGED)).toBe(true);
  });

  it('转发 /goal 状态变化与 /learn run 状态机流转', () => {
    expect(PUSH_FORWARD_ALLOWLIST.has(IPC_CHANNELS.MAKER_PUSH.GOAL_STATUS_CHANGED)).toBe(true);
    expect(PUSH_FORWARD_ALLOWLIST.has(IPC_CHANNELS.LEARN.EVENT)).toBe(true);
  });

  it('不转发任意未列 channel(防意外泄露本机 UI 事件)', () => {
    expect(PUSH_FORWARD_ALLOWLIST.has(IPC_CHANNELS.MAKER_PUSH.DESKTOP_COMMAND_TRIGGERED)).toBe(false);
    // 死条目已移除:发射点不 tap、控制端不消费,放白名单只会误导。
    expect(PUSH_FORWARD_ALLOWLIST.has(IPC_CHANNELS.MAKER_PUSH.AUTH_STATE_CHANGED)).toBe(false);
  });
});

describe('INVOKE_TIMEOUT_OVERRIDES_MS', () => {
  it('desktop-cmd:run 隧道超时必须大于被控端执行预算(30s CMD + 5s kill 宽限)', () => {
    // 对撞回归:隧道默认 30s == 被控端命令超时 30s → 慢命令结果被丢弃且看不到 timedOut 语义。
    expect(INVOKE_TIMEOUT_OVERRIDES_MS[IPC_CHANNELS.DESKTOP_CMD.RUN]).toBeGreaterThan(35_000);
  });

  it('覆盖表内的 channel 必须都在 REMOTE_INVOKE_ALLOWLIST(不给白名单外通道配超时)', () => {
    for (const ch of Object.keys(INVOKE_TIMEOUT_OVERRIDES_MS)) {
      expect(REMOTE_INVOKE_ALLOWLIST.has(ch), `${ch} 不在 allowlist`).toBe(true);
    }
  });

  it('worktree:create 隧道超时必须大于默认 30s(git worktree add + 选择性 checkout 预算)', () => {
    expect(INVOKE_TIMEOUT_OVERRIDES_MS[IPC_CHANNELS.WORKTREE.CREATE]).toBeGreaterThan(30_000);
  });

  it('worktree:discard-precreated 可等待同 session 创建锁且不沿用默认 30s', () => {
    expect(INVOKE_TIMEOUT_OVERRIDES_MS['worktree:discard-precreated']).toBeGreaterThan(30_000);
  });
});

describe('computeAllowlistHash', () => {
  it('稳定且确定(同一 allowlist 多次计算一致)', () => {
    expect(computeAllowlistHash()).toBe(computeAllowlistHash());
    expect(computeAllowlistHash()).toMatch(/^[0-9a-f]{8}$/);
  });
});
