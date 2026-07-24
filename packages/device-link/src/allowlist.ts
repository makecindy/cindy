/**
 * 远程 IPC 隧道的 channel 白名单(默认拒绝制)。
 *
 * 准入判据(逐条核对 apps/desktop 的 maker-ipc/channels.ts 与 local-db ipc 后收录):
 *  1. handler 不依赖 event.sender / 窗口对象;
 *  2. 无本机 UI / shell / 对话框副作用;
 *  3. 语义在「被控端」执行才正确(数据真相在被控端)。
 *
 * 永不放行的类别(列在这里供 review):窗口/UI 类(window-* / page-zoom / find-in-page /
 * maker:open-session-in-new-window)、本机对话框(show-open-directory-dialog)、shell 副作用
 * (shell:* / maker:mivo:open-model-file)、账号与密钥(auth:* / safe-storage / api-key 读写;
 * 唯一例外是 presence-only 探测 maker:api-key:present,只回 boolean、不含密钥材料,见下)、
 * updater / release-notes、被控端全局设置写(maker:compat-mode:set 等 *_SET 设置类——
 * 远程改被控端全局设置越权)、local-db 裸写(sessions:create/update、messages:create——
 * 写库必须经业务 handler,不开裸写)、maker:execute-desktop-command(UI 副作用)、
 * migration / session-import、skillhub 写操作。
 *
 * 双层校验:控制端发送前(快速失败)+ 被控端执行前(权威)。
 * 新增 channel 不进表即天然不可远程调用(代码保证确定性)。
 */
import { SESSION_ACTIVITY_CHANNEL } from './topics.js';

/**
 * 订阅控制帧 channel(控制端 → 被控端,push 驱动):注册 / 注销对某 topic 的变更推送。
 * 走 invoke 帧承载,被控端 dispatch 在通用 dispatch 前拦截(用 server 填的 env.src 作
 * controllerDeviceId,防伪造),不进 ipcMain handler。client-agnostic:mobile/web 用同名 channel。
 */
export const DL_SUBSCRIBE_CHANNEL = 'device-link:subscribe';
export const DL_UNSUBSCRIBE_CHANNEL = 'device-link:unsubscribe';

/**
 * cindy_helper 跨设备历史读取。被控端只接受单 session 的结构化只读查询，
 * 并复用本机 history reader 的过滤、排序与游标语义。
 */
export const DL_HISTORY_MESSAGES_CHANNEL = 'local-db:history:messages';

/**
 * 会话引用消费能力探针。控制端在发送含引用快照的队列消息前必须先调用；
 * 老被控端不在 allowlist 中会返回 CHANNEL_NOT_ALLOWED，控制端据此显式拒绝，
 * 避免消息看似发送成功但 Agent 只收到一条普通深链文本。
 */
export const DL_SESSION_REFERENCE_CAPABILITY_CHANNEL =
  'maker:input:session-reference-capability';

/**
 * 入方向媒体取件 channel(控制端 → 被控端):控制端要查看被控端会话里的媒体
 * (图片/视频/文件/音频,字节在被控端本地缓存)时,发此 invoke 让被控端把原始媒体
 * 解析成本地文件 → 上传 OSS 中转区(明文 + 同账号 key)→ 回 { ossKey, mimeType, size }。
 * 与 subscribe 同样不是 ipcMain handler,被控端 dispatch 在通用 dispatch 前拦截执行
 * (复用 remoteControlEnabled + 撤销黑名单 + allowlist 三道 gate,但绕过 ipcMain 路由)。
 * 列入 allowlist 作契约登记 + 老被控端不识别时回 CHANNEL_NOT_ALLOWED 供控制端探测能力
 * (无入方向媒体支持 → 控制端回退媒体占位)。
 */
export const DL_MEDIA_FETCH_CHANNEL = 'device-link:media:fetch';

/**
 * Legacy 出方向语音转写 channel(控制端 → 被控端):早期方案里手机端录音后先经 server
 * `/api/device-link/media/presign-put` 上传 OSS 中转区,再把 ossKey 交给被控桌面。
 * 被控端下载音频并使用本机 voice-input batch ASR 配置转写,返回文本给手机插入 composer。
 *
 * 当前手机版语音主流程已改为 credential sync + 手机端实时 ASR/refine,此 channel
 * 仅作为协议兼容面保留,不是 ipcMain handler,由 device-link dispatch 拦截执行。
 */
export const DL_VOICE_TRANSCRIBE_CHANNEL = 'device-link:voice:transcribe';

/**
 * 手机端云端语音输入的临时 credential 同步 channel。
 *
 * 这是账号体系补齐前的窄口径例外:只允许同步 voice ASR/refine 所需的 XD Gateway key
 * 与模型配置,由被控端 dispatch 专门拦截,不落通用 ipcMain,也不是 safe-storage/api-key
 * 的通用远程读写能力。长期方案应改为「AI key 绑定用户账号,移动端登录后读自己的 key」。
 */
export const DL_VOICE_CREDENTIAL_SYNC_CHANNEL = 'device-link:voice:credential-sync';

/**
 * 手机端语音词典学习回写 channel。
 *
 * 手机端只负责检测用户是否把一次 voice refine 结果改成了专有名词/术语修正;
 * 词典 advisor 与写入仍在被控桌面执行,避免移动端维护一份会分叉的本地词典。
 */
export const DL_VOICE_DICTIONARY_LEARNING_CHANNEL = 'device-link:voice:dictionary-learning';

/**
 * M3 核心集:远程会话全生命周期(新建/发消息/事件流/审批/中断/运行时切换)+ 基础读模型。
 * M4 将扩展 scheduler / orca worker / rewind / usage 等完整控制面。
 */
const CORE_INVOKE_CHANNELS: readonly string[] = [
  // —— 会话生命周期 ——
  'maker:create-session',
  'maker:close-session',
  'maker:abort-session',
  'maker:send',
  'maker:steer',
  'maker:list-active',
  'maker:any-session-in-turn',
  'maker:session-in-turn',
  // —— 输入队列(input queue 全集,无本机副作用)——
  DL_SESSION_REFERENCE_CAPABILITY_CHANNEL,
  'maker:input:get-projection',
  'maker:input:enqueue',
  'maker:input:compact',
  'maker:input:steer',
  'maker:input:stop',
  'maker:input:resume',
  'maker:input:retry-last-error',
  'maker:input:clear-error',
  'maker:input:remove',
  'maker:input:update-text',
  // 整条内容替换(文本+附件),手机端排队消息复用 composer 编辑;老被控端无 handler →
  // CHANNEL_NOT_ALLOWED,控制端按「仅文本变化降级 update-text / 附件变化提示升级」处理。
  'maker:input:update-content',
  'maker:input:move',
  'maker:input:set-expanded',
  'maker:input:set-interaction-lock',
  'maker:input:set-edit-lock',
  'maker:input:clear-session',
  // device-link:auth error 重试失败/放弃时控制端调此补落被控端 DB;被控端 main 执行无 sender 依赖。
  'maker:persist-turn-error-deferred',
  // —— 交互审批(permission / ask / plan)——
  'maker:resolve-interaction',
  // 打开/重连/刷新会话时拉当前挂起交互快照,重建可操作面板(只读)。
  'maker:get-pending-interactions',
  // —— 运行时切换 ——
  'maker:set-model',
  // 同一会话 Claude Code / Codex 切换采用 pending intent：写入口只登记意图，
  // 只读入口供控制端重连后恢复 main 权威状态；两者都无 event.sender / 本机 UI 副作用。
  'maker:switch-session-agent',
  'maker:get-session-agent-switch-intent',
  'maker:set-effort',
  'maker:set-permission-mode',
  'maker:set-fast-mode',
  // 计划模式一级开关(runtime-only, 持久化经 dispatch persistRemoteSetting 回流)。
  // 老被控端无 handler → CHANNEL_NOT_ALLOWED → 控制端 UI 本就按 capabilities.planMode 缺失隐藏入口。
  'maker:set-plan-mode',
  'maker:set-extra-dirs',
  // 会话「非选中模型」effort/fast 写穿(控制端 → 被控端):控制端纯显示,改非选中行的预设记忆时
  // 通知被控端,被控端调它原来的本地 setter(setSessionModelEffort/Fast)写真实存储。选中模型仍走
  // maker:set-model/effort/fast-mode + sessions:patched,不经此 channel。被控端转发给自身 renderer
  // 执行(无 sender 依赖、无本机副作用)。老被控端无 handler → CHANNEL_NOT_ALLOWED → 控制端吞掉降级。
  'maker:set-session-model-pref',
  // —— 能力查询 ——
  'maker:get-capabilities',
  'maker:list-available-agents',
  // device-link 远程草稿镜像(只读):控制端为被控设备新建项目草稿时,读被控端**当前 New Maker
  // 草稿**在该 vendor 的完整选择(model/effort/fast/permission/source),1:1 seed 控制端草稿。
  // 数据真相在被控端(其 renderer 草稿),无 sender 依赖、无本机副作用 → 准入。老被控端无此 handler
  // → 控制端收 CHANNEL_NOT_ALLOWED → 回退被控端 capabilities 默认。
  'maker:get-new-maker-defaults',
  // device-link 草稿「每个模型 effort/fast」写穿(控制端 → 被控端):控制端在远程项目草稿里改
  // 选中 / 非选中模型的 effort/fast 时通知被控端,被控端调它原来的本地 setter(setEffortForModel /
  // setFastModeForModel)写真实草稿;被控端 newMakerDraft 变更自动经既有 maker:sync-new-maker-draft
  // re-mirror 回 main 并广播。被控端转发给自身 renderer 执行(无 sender 依赖、无本机副作用)。
  // 老被控端无 handler → CHANNEL_NOT_ALLOWED → 控制端吞掉,退回一次性 pull 行为。
  'maker:apply-new-maker-draft-pref',
  // 模型供应商目录(只读):远程会话的模型选择器据此 1:1 镜像被控端的「供应商+模型」结构。
  // 被控端 dispatch 在返回前剥离 routing 等执行字段(见 device-link/dispatch.ts),只回显示用字段。
  'maker:provider:list',
  // Git safety 设置(只读):远程 Codex Rewind 入口必须按被控端是否会创建 safety snapshot
  // 决定显隐。SET/RESET 不放行,控制端不能改被控端全局偏好。
  'maker:git-safety:get',
  // —— 读模型(被控端本地 DB 是数据真相)——
  'local-db:sessions:list',
  'local-db:sessions:get',
  DL_HISTORY_MESSAGES_CHANNEL,
  'local-db:messages:list',
  // 会话内搜索跳转定位(loadAroundMessage):只读,与 messages:list 同安全级。
  'local-db:messages:around',
  // 以 message clientId 定位上下文,供移动端轻量跳转 / fork 来源定位；只读,与 messages:around 同安全级。
  'local-db:messages:around-client-id',
  // 订阅形态会话「本会话价值」历史汇总(assistant agent_meta 估算值求和):只读聚合,
  // 无 sender 依赖、无副作用,与 messages:list 同安全级。控制端底部 $ chip 的历史初值
  // 必须查被控端(查本机是空库恒 0);老被控端无此 channel → CHANNEL_NOT_ALLOWED →
  // 控制端吞错,仅靠已加载消息 + 实时 turn-cost 推送呈现部分值。
  'local-db:messages:estimatedSessionValue',
  'local-db:recent-workdirs:list',
  // 窄口径写:从被控端「最近项目」列表移除一条(专用 handler,path 归一后按主键删,
  // 幂等,不动 sessions / 磁盘)。控制端项目选择器的删除入口与本机语义对等;
  // 老被控端无此 handler → CHANNEL_NOT_ALLOWED → 控制端隐藏/忽略删除能力即可。
  'local-db:recent-workdirs:remove',
  // 窄口径元数据写:仅 status / title / pinnedAt(归档/删除/恢复/重命名/置顶)。专用
  // handler、白名单字段、不是裸 update(update 写任意字段、不放行)。支撑远程删/归档/改名/置顶对等。
  'local-db:sessions:patch-meta',
  // 只读:「疑似中断」(startedAt > endedAt)的 active 会话 id(错误红点数据源)。
  // 与 sessions:list 同安全级。
  'local-db:sessions:interrupted-pending',
  // 窄口径写:中断提示的「继续/忽略」—— 仅写 sessions.last_turn_ended_at = now
  // (专用 handler,单字段幂等,不是裸 update)。远程会话的确认必须落被控端 DB,
  // 否则重开会话提示复活。老被控端无此 handler → CHANNEL_NOT_ALLOWED → 控制端
  // 吞错退化为本视图内存隐藏。
  'local-db:sessions:ack-interrupted',
  // 窄口径写:error-tail-banner 的「关闭/忽略」——仅把 role='error' 行的 content
  // merge dismissed:true(handler 内校验 role,原字段保留,不是裸 updateContent,
  // updateContent 本身不放行)。远程会话的忽略必须落被控端 DB,否则重连/重拉后
  // 红条复活。老被控端无此 handler → CHANNEL_NOT_ALLOWED → 控制端吞错退化为
  // 本视图内存隐藏。
  'local-db:messages:dismiss-error',
  // 消息菜单单条内容删除:在被控端清旧原生上下文并写 context rebuild handoff。
  'maker:message:delete',
  // 订阅控制帧(push 驱动):被控端 dispatch 拦截执行,不落到 ipcMain handler。
  // 列入 allowlist 作契约登记 + 老被控端不识别时回 CHANNEL_NOT_ALLOWED 供控制端探测能力(回退 poll)。
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
  // 入方向媒体取件(被控端 dispatch 拦截执行,不落 ipcMain handler;契约登记 + 能力探测)。
  DL_MEDIA_FETCH_CHANNEL,
  // 出方向语音转写(被控端 dispatch 拦截执行,不落 ipcMain handler;复用被控端 ASR 配置)。
  DL_VOICE_TRANSCRIBE_CHANNEL,
  // 临时 voice credential 同步(被控端 dispatch 拦截执行,不落 ipcMain handler;禁止泛化)。
  DL_VOICE_CREDENTIAL_SYNC_CHANNEL,
  // voice dictionary learning evidence 回写(被控端 dispatch 拦截执行,不落 ipcMain handler)。
  DL_VOICE_DICTIONARY_LEARNING_CHANNEL,
];

/**
 * M4 扩展集:完整控制面。scheduler / orca worker / rewind·fork / usage /
 * memory 读 / 命令与技能列举 / 路径解析。仍恪守准入判据(无 event.sender 依赖、
 * 无本机 UI/shell 副作用、语义在被控端执行才正确)。
 */
const EXTENDED_INVOKE_CHANNELS: readonly string[] = [
  // —— Scheduler(读 + 改 schedule 都在被控端执行才有意义)——
  'maker:schedule:list',
  'maker:schedule:get',
  'maker:schedule:create',
  'maker:schedule:update',
  'maker:schedule:delete',
  'maker:schedule:pause',
  'maker:schedule:resume',
  'maker:schedule:run-now',
  'maker:schedule:list-runs',
  'maker:schedule:list-sidebar-index-runs',
  'maker:schedule:list-cost-summaries',
  'maker:schedule:delete-run',
  'maker:schedule:get-runtime-state',
  'maker:schedule:get-inflight-count',
  'maker:schedule:get-unread-count',
  'maker:schedule:mark-run-read',
  'maker:schedule:mark-all-runs-read',
  'maker:schedule:mark-schedule-runs-read',
  'maker:schedule:list-templates',
  'maker:schedule:create-from-template',
  // script 任务能力选择器的可用性探测:纯只读查询,意识状态在被控端才有意义
  'maker:schedule:script-capability-status',
  // —— 会话未读已读回执(控制端真实展示会话内容后,把被控端的会话未读态清掉)——
  // 准入:会话粒度状态操作(与 mark-run-read 同类),无 event.sender 依赖、无 shell/UI
  // 副作用;语义在被控端执行才正确(灵动岛 / Dock 角标 / 侧栏红绿点的未读真相都在被控端
  // main)。老被控端无此 channel → CHANNEL_NOT_ALLOWED → 控制端吞掉降级(仅本地清点)。
  'notification:clear-session-attention',
  // —— Project automation ——
  'maker:project-automation:reconcile',
  'maker:project-automation:list-consents',
  'maker:project-automation:revoke-consent',
  'maker:project-automation:upsert-schedule',
  'maker:project-automation:remove-schedule',
  // —— Orca 协同(Lead 控多 Worker;在被控端进程内编排)——
  'maker:worker:create',
  'maker:worker:list',
  'maker:worker:switch-focus',
  'maker:worker:idle',
  'maker:worker:acknowledge-done',
  'maker:worker:archive',
  'maker:team:end',
  'maker:session:enable-orca',
  'maker:session:disable-orca',
  'maker:mark-orca-role',
  'maker:collaboration-settings:get',
  'local-db:orca-workflows:get-by-lead',
  'local-db:orca-workflows:get-by-worker-session',
  'local-db:orca-workflows:list-workers-by-lead',
  // —— Rewind / Fork / Title / Context ——
  'maker:rewind:preview',
  'maker:rewind:commit',
  'maker:fork',
  'maker:fork-strip-encrypted',
  'maker:generate-title',
  // 重命名输入框 Magic 按钮:被控端读自己 DB 里的最新对话素材、用自己的 provider 凭证
  // 重生成标题(与 generate-title 同一 oneShot 通道)。老被控端无此 channel →
  // CHANNEL_NOT_ALLOWED → 控制端按生成失败提示。
  'maker:regenerate-title',
  'maker:get-context-usage',
  // —— Goal(目标模式;goal 状态机在被控端 GoalController 执行才有意义)——
  'maker:goal:set',
  'maker:goal:clear',
  'maker:goal:get-status',
  'maker:goal:pause',
  'maker:goal:resume',
  'maker:goal:update',
  // —— Agent 状态 / 用量(只读)——
  'maker:agent:status',
  'maker:agent:binary-version',
  'maker:auth:get-state',
  'maker:usage:today',
  'maker:usage:account',
  // Codex app-server 官方控制面:额度/reset 次数读取 + 经 desktop 账号绑定 offer 的
  // 人工 reset。mutation 不接收 creditId,不能泛化成任意账号/凭证控制入口。
  'maker:usage:codex-rate-limits',
  'maker:usage:codex-rate-limit-reset',
  // 模型单价表(只读,main 侧 LiteLLM /model_group/info 缓存):控制端模型选择器展示被控端
  // 视角的单价(与被控端桌面 tooltip 同源)。无 sender 依赖、无副作用;老被控端无此 channel
  // → CHANNEL_NOT_ALLOWED → 控制端隐藏价格(与桌面「无价不显示」口径一致)。
  'maker:usage:model-pricing',
  // 网关 API key **presence-only** 探测:只回 { present: boolean },不回、也永不扩展为读取
  // 密钥材料 —— 这是「账号与密钥永不放行」大类下的窄口径例外(同 DL_VOICE_CREDENTIAL_SYNC
  // 的例外定位,禁止泛化)。用途:控制端模型选择器判断骨折版(codex/)是否该置灰,判定依据
  // 在被控端(key 存被控端 safeStorage、请求也从被控端发)。老被控端无此 channel →
  // CHANNEL_NOT_ALLOWED → 控制端按 unknown 处理(不置灰)。
  'maker:api-key:present',
  // —— Memory 读(写全局设置不放行)——
  'maker:memory:get',
  'maker:memory:get-settings',
  // —— 命令 / 技能 / at 资源 列举(只读)——
  'maker:list-desktop-commands',
  'maker:list-agent-commands',
  'maker:list-agent-skills',
  'maker:list-customizations',
  'maker:scan-at-resources',
  // —— 插件列表(只读)——
  'maker:plugins:list',
  // —— 路径解析(被控端解析语义正确;新建会话选目录用)——
  'fs:resolve-path',
  'fs:resolve-path-batch',
  // —— 本机目录浏览(「添加远程项目」逐级选被控端项目目录用)——
  // 准入:只读目录枚举 + mkdir -p,**无**文件写/删/exec;且 device-link 已是同账号 +
  // remoteControlEnabled 显式 opt-in,控制端本就能在 workingDir 跑 agent(可执行任意命令),
  // 故列目录/建目录落在既有信任域内,不扩大攻击面。见 apps/desktop/src/main/fsBrowse/ipc.ts。
  'fs:list-dir',
  'fs:stat-path',
  'fs:mkdir-p',
  // —— 远程文件浏览(右侧栏 / doc 模式,读写增删 + 文件名索引 + 非流式搜索)——
  // 单聚合 channel:被控端专用 handler(见 apps/desktop/src/main/file-browser/device-op.ts),
  // 不复用依赖 event.sender 的既有 file-browser handler。准入:
  //  - workdir 参数经 remote-workdir-guard 同款收敛(已知会话 workdir / recents /
  //    真实存在目录),挡伪造路径;路径穿越在 scanner 层拦(assertInsideWorkdir + realpath)。
  //  - device-link 已是同账号 + remoteControlEnabled 显式 opt-in,控制端本就能在
  //    workingDir 跑 agent(任意读写/exec),文件浏览不扩大攻击面(fs:list-dir 同款论证)。
  //  - readFile 结果超帧限前被控端预判回结构化 oversize,不裸炸 FRAME_TOO_LARGE。
  //  - 老被控端无此 channel → CHANNEL_NOT_ALLOWED,控制端渲染"设备版本过旧"占位。
  'file-browser:remote-op',
  // —— 窄口径文本预览(消息附件 / tool 文件引用只读查看)——
  // 不是裸文件读:handler 要求绝对路径,复用系统目录 blocklist,10MB 上限,
  // 并用 reason 明确 oversize / not_found / forbidden。见 bootstrap-electron text-file:read-preview。
  'text-file:read-preview',
  // —— /learn 远程(learn-host 全流程在被控端:证据查它自己的 DB、staging 在它的
  // userData、skill 落它的 ~/.agents/skills;语义在被控端执行才正确)——
  // learn:apply 写被控端 skill 目录的越权论证:提案由被控端 staging 校验 + redaction
  // 双程扫描后生成,且 device-link 已是同账号 + remoteControlEnabled 显式 opt-in,
  // 控制端本就能经 agent 会话在被控端写文件,不扩大攻击面。入参只有 runId / 结构化
  // 请求体,不接受任何客户端路径(staging 路径全部由被控端生成)。
  'learn:start',
  'learn:list-runs',
  'learn:get-proposal-diff',
  'learn:apply',
  'learn:discard',
  'learn:cancel',
  // —— /cmd 远程(远程会话的 shell 命令在被控端 workingDir 执行才是正确语义)——
  // handler 对 cwd 走 remote-workdir-guard 收敛(已知目录集合 / 真实存在目录),
  // 准入论证同 fs:list-dir:同账号 + 显式 opt-in 下控制端本就能驱动 agent 执行任意命令。
  'desktop-cmd:run',
  // —— Worktree(为被控端项目预建独立 git worktree;git/fs 语义在被控端执行才正确——
  // 控制端本机 git 探测被控端路径必然误报"不是 git 仓库")——
  // 准入:detect-cwd / list-branches / suggest-name 是只读 git 探测,无写副作用;
  // create 只在 baseRepo/.cindy-worktrees/<name> 下派生新目录(name 经被控端
  // validateWorktreeName 白名单校验,不接受任意路径),且 baseRepo 在被控端 dispatch
  // 层过 remote-workdir-guard 同款收敛(见 dispatch.ts PATH_GUARDED)。device-link
  // 已是同账号 + remoteControlEnabled 显式 opt-in,控制端本就能在项目目录跑 agent
  // (任意 exec),不扩大攻击面。removal-preview 只读、用于删除前警告；实际删除路径不放行
  // (removeWorktreeForSession 只在被控端状态变更流程内部触发)。老被控端无这些 channel →
  // CHANNEL_NOT_ALLOWED → 控制端保持"worktree 不可用"降级。
  'worktree:detect-cwd',
  'worktree:list-branches',
  'worktree:suggest-name',
  'worktree:create',
  'worktree:removal-preview',
];

/** 远程可调用的 invoke channel 全集(被控端 dispatch 前的权威校验依据) */
export const REMOTE_INVOKE_ALLOWLIST: ReadonlySet<string> = new Set([
  ...CORE_INVOKE_CHANNELS,
  ...EXTENDED_INVOKE_CHANNELS,
]);

/**
 * 被控端 → 控制端的广播转发白名单:本机 broadcastToAllWindows 时,
 * 命中这些 channel 的事件才会经 link 转发给控制端。
 */
export const PUSH_FORWARD_ALLOWLIST: ReadonlySet<string> = new Set([
  // maker-ipc MAKER_PUSH
  'maker:event',
  'maker:status-changed',
  'maker:input:projection',
  'maker:interaction-request',
  'maker:interaction-dismissed',
  'content-moderation:input-blocked',
  'content-moderation:output-blocked',
  // Claude Auto classifier 故障后降级到 ask;payload 带 sessionId,控制端显示同款提示。
  'maker:auto-permission:fallback',
  // 被控端 active-catalog revision 变化：控制端按 deviceId 驱逐并重拉 provider 目录。
  'maker:provider:changed',
  // 注:maker:auth:state-changed 曾在此 —— 但发射点不 tap、控制端也不消费(被控端 agent 鉴权
  // 状态推给控制端语义存疑),是死条目,已移除避免误导。真要转发需先想清控制端如何路由。
  'maker:schedule:event',
  'maker:project-automation:event',
  'maker:orca:worker-changed',
  // goal 状态变化(payload 顶层 sessionId → 路由到 session:<id> topic,打开该会话的控制端可见)
  'maker:goal:status-changed',
  'usage:message-turn-cost',
  // 本轮模型降级标记(payload 顶层 sessionId → 默认路由到 session:<id> topic):
  // 控制端把 agent_meta.modelMismatch 实时 patch 进已打开的远程会话消息流。
  'usage:message-model-mismatch',
  // session 终身累计 cost / token(topics.ts 归入 sessions topic:列表订阅常开,会话
  // 未打开也保持镜像新鲜):被控端 sessionSpendBroadcaster 走裸 UPDATE 落库、不发
  // sessions:patched,控制端远程会话底部 $ chip 依赖这两条把累计值镜像成被控端真相。
  'usage:session-spend-changed',
  'usage:session-tokens-changed',
  // local-db 推送(读模型增量)
  'local-db:sessions:created',
  'local-db:sessions:patched',
  SESSION_ACTIVITY_CHANNEL,
  'local-db:messages:created',
  'local-db:messages:deleted',
  // 被控端 terminal error 落库脏信号:控制端据此把已加载历史的远程会话标脏,下次打开重拉。
  'local-db:session:error-persisted',
  // 被控端「当前 New Maker 草稿」全量变更:被控端草稿 effort/fast/选中 等任意变化时广播,
  // 控制端的远程项目草稿据此实时刷新显示镜像(remoteDraftState)。账号 / 全局级、无 sessionId →
  // topics.ts 的 ACCOUNT_CHANNELS 把它并入 `sessions` topic(控制端按设备订阅 sessions)。
  'maker:new-maker-draft:changed',
  // 被控端会话「非选中模型」effort/fast 变更:被控端本地改 / 应用控制端写后广播,带 sessionId →
  // 默认路由到 session:<id> topic;控制端打开该远程会话时已订阅,据此刷新显示镜像。
  'maker:session-model-pref:changed',
  // /learn run 状态机流转:payload = { type:'state-changed', run }(账号级,不绑单会话)→
  // topics.ts 的 ACCOUNT_CHANNELS 并入 `sessions` topic,随设备列表订阅到达(状态卡 / 审查
  // 面板可能在触发会话与蒸馏会话两处打开,按 run 内的 sessionId 路由会漏一边)。
  'learn:event',
]);

/**
 * 逐 channel 的 invoke 隧道超时覆盖(ms)。
 *
 * client 默认 requestTimeoutMs(30s)对「被控端自身持有同量级执行预算」的 channel
 * 会产生对撞:desktop-cmd:run 在被控端有 30s 命令超时 + 5s SIGKILL 宽限,隧道 30s
 * 必然先放弃 —— 命令在被控端继续跑完但输出被丢弃,控制端永远看不到 timedOut:true
 * 的正确语义。此表给这类 channel「执行预算 + 回程余量」的覆盖值。
 * client-agnostic:mobile/web 控制端应使用同一映射(与 allowlist 同为协议契约)。
 */
export const INVOKE_TIMEOUT_OVERRIDES_MS: Readonly<Record<string, number>> = {
  // 被控端 CMD_TIMEOUT_MS(30s)+ CMD_KILL_GRACE_MS(5s)+ 5s 回程余量
  'desktop-cmd:run': 40_000,
  // 被控端 worktree:create 含 git worktree add(--no-checkout)+ 白名单文件选择性
  // checkout + .claude/.sivi 拷贝;大仓库 / 慢盘上可能超默认 30s,给足执行预算 + 回程余量。
  'worktree:create': 60_000,
};

/**
 * allowlist 指纹:link-accept 回给控制端,用于探测两端版本差异
 * (控制端据此提示「对方版本不一致」而不是静默 CHANNEL_NOT_ALLOWED)。
 * FNV-1a over 排序后的 channel 列表,稳定且无依赖。
 */
export function computeAllowlistHash(): string {
  const sorted = [...REMOTE_INVOKE_ALLOWLIST].sort().join('\n');
  let hash = 0x811c9dc5;
  for (let i = 0; i < sorted.length; i++) {
    hash ^= sorted.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
