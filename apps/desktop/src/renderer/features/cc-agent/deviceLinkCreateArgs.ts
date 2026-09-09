/**
 * deviceLinkCreateArgs —— 组装 device-link 远程建会话(maker:create-session 隧道)的参数。
 * ---------------------------------------------------------------------------
 * 抽成纯函数是为了把「归属一致」这条行为锁进单测,而不是只靠 grep 接线:
 *   控制端在远程项目目录下建会话时,必须把 workspaceKind 传成 **'project'** —— 被控端据此
 *   把会话挂到该项目目录下;若误传 'dialogue' / standalone,控制端在项目里、被控端却独立
 *   在项目外(历史上真实出过的「两端归属不一致」bug)。
 *
 *   2026-07(#807):远程草稿**不再必带项目目录** —— 「在对端设备上开一个不绑项目的对话」是
 *   合法意图(每台设备都有自己的一批对话)。此时 workingDir 缺省、workspaceKind 传 'dialogue',
 *   由被控端按 standalone dialogue 自行分配运行目录,与本机侧
 *   `workspaceKind: workingDir ? 'project' : 'dialogue'` 完全同口径。
 *   归属一致的约束反而更硬了:两个字段现在由同一个 workingDir 派生 —— 有目录必是 'project',
 *   无目录必是 'dialogue',不可能再错配。
 *
 * agentKind 归一到 maker-core 形态('cc' → 'claude-code');其余字段原样透传。
 */

import { effectiveSourceIdForModel, type ProviderView } from '@cindy/model-providers';

import type { Session, WorkspaceKind } from '@/lib/ccAgent.types';
import type { AgentKind } from '@/hooks/useAgentCapabilities';
import type { Effort, PermissionMode } from '@/lib/userPreferences.types';

export interface DeviceLinkCreateParams {
  /** 草稿 vendor 形态:'cc' | 'codex' | 'pi'(persistedAgentKind)。 */
  agentKind: 'cc' | 'codex' | 'pi';
  /**
   * 被控端上的项目目录。缺省 / 空白 = 在该设备上建**不绑项目的 standalone dialogue**,
   * workspaceKind 随之派生为 'dialogue',运行目录由被控端分配。
   */
  workingDir?: string;
  /**
   * 预生成的 session id(可选)。远程 worktree 流程用:控制端先经隧道调被控端
   * worktree:create(以该 id 登记 worktreeStore 绑定),再以同一 id 建会话——两步共用
   * 一个 id,被控端 close-session 时才能按绑定回收 worktree。非 worktree 流程不传,
   * 由被控端自行生成。
   */
  id?: string;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  fastMode: boolean;
  /**
   * 附加只读引用目录(草稿期用户选的)。控制端选的是**本机路径**(extraDirs picker 走本机
   * 原生目录对话框),随 create 透传到被控端后,被控端 create 落地在 bootstrapSession 里按
   * 与 set-extra-dirs 同款的 validateExtraDirs(对被控端 workingDir + 本机 FS)校验,只保留
   * 通过的子集 —— 与远程 set-extra-dirs 的既有行为完全一致(控制端路径在被控端常被拒)。
   */
  extraDirs?: string[];
  writableDirs?: string[];
  /**
   * 草稿选定的来源(**被控端**供应商 id;null / 省略 = 跟随被控端默认路由)。被控端 create 时
   * 落 `sessions.provider_id`,使新远程会话首个请求即按所选来源路由(与会话内切来源对称)。
   */
  providerId?: string | null;
}

export interface DeviceLinkCreateArgs {
  agentKind: 'claude-code' | 'codex' | 'pi';
  /** 仅远程 worktree 流程出现(与 worktree:create 登记的绑定同 id)。 */
  id?: string;
  /** 仅项目会话出现;dialogue 不带此字段(被控端自行分配运行目录)。 */
  workingDir?: string;
  /** 由 workingDir 派生 —— 有目录 'project',无目录 'dialogue'。归属一致的关键。 */
  workspaceKind: WorkspaceKind;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  fastMode: boolean;
  /** 仅当草稿有非空 extraDirs 时出现;被控端 bootstrapSession 再校验(单一真相源)。 */
  extraDirs?: string[];
  writableDirs?: string[];
  /** 仅当草稿显式选了非空来源时出现(null/空 = 跟随默认路由 → 不放进 args,provider_id 留 NULL)。 */
  providerId?: string;
}

export function buildDeviceLinkCreateArgs(p: DeviceLinkCreateParams): DeviceLinkCreateArgs {
  // 空白目录一律当「没选项目」处理(与本机 selectedWorkingDir 的 trim() || undefined 同口径),
  // 免得 '  ' 这种脏值在被控端被当成一个真实路径去校验。
  const dir = p.workingDir?.trim();
  return {
    agentKind: p.agentKind === 'cc' ? 'claude-code' : p.agentKind,
    // 预生成 id 仅在远程 worktree 流程出现;不传时不放进 args,被控端自行生成。
    ...(p.id ? { id: p.id } : {}),
    // 有目录 → 项目会话;无目录 → standalone dialogue,不带 workingDir,由被控端分配运行目录。
    ...(dir ? { workingDir: dir } : {}),
    workspaceKind: dir ? 'project' : 'dialogue',
    model: p.model,
    effort: p.effort,
    permissionMode: p.permissionMode,
    fastMode: p.fastMode,
    // 空 / 缺省不放进 args:payload 干净,且被控端 bootstrapSession 也只在非空时才校验。
    ...(p.extraDirs && p.extraDirs.length > 0 ? { extraDirs: p.extraDirs } : {}),
    ...(p.writableDirs && p.writableDirs.length > 0 ? { writableDirs: p.writableDirs } : {}),
    // providerId 同理:仅非空显式来源才放进 args;null/空 → 不带 → 被控端 provider_id 留 NULL(默认路由)。
    ...(p.providerId ? { providerId: p.providerId } : {}),
  };
}

/**
 * 一次远程建会话要提交的「候选值」。两个来源:
 *   · 普通发送 —— ChatInput 回传的实时值(用户界面上此刻看到的那一组);
 *   · 新建目标 —— 组件级派生值(弹窗独立于 ChatInput,拿不到回传)。
 * 两者形状相同,于是能过同一道校准。
 */
export interface DeviceLinkSubmissionCandidate {
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  fastMode: boolean;
  /** 用户显式选中的被控端来源;null / 省略 = 跟随被控端默认路由。 */
  providerId?: string | null;
}

export interface DeviceLinkSubmissionParams {
  agentKind: 'cc' | 'codex' | 'pi';
  workingDir?: string;
  id?: string;
  extraDirs?: string[];
  writableDirs?: string[];
  candidate: DeviceLinkSubmissionCandidate;
  /** **被控端**供应商目录(useDeviceProviders 经隧道拉到的那一份)。 */
  deviceProviders: ProviderView[];
  capabilityAgentKind: AgentKind;
}

/**
 * 远程建会话参数的**唯一入口**:校准候选值 → 组装 args。
 *
 * 为什么必须只有一个入口(#807 review 第 25 轮的结构性教训):在此之前「发送」与「新建目标」
 * 各自推导这组值 —— 发送用 ChatInput 回传的实时值,新建目标用组件级派生值 —— 最后才汇进同一个
 * buildDeviceLinkCreateArgs。于是任何一条校准规则只要漏加在一边,就会长出一个**只在其中一条路径
 * 上复现**的缺陷:那一轮的 providerId 正是如此,普通发送没事(ChatInput 内部会用 effectiveSourceId
 * 重算、失效即回落),新建目标却把一个未认证的来源直接写进被控端 sessions.provider_id,新目标起不来。
 * 同一个模具还压出过「新建目标不支持 device-only 草稿」(第 11 轮)与另外两处对称性缺口。
 *
 * 所以两条路径现在都只提供**候选值**,校准与组装都发生在这里 —— 规则改一次,两条路径同时受益,
 * 想只改一边都做不到。
 *
 * 为什么发送路径也要在这里再校准一次(它以前靠 ChatInput 内部重算):那等于把正确性寄托在**另一个
 * 组件的实现细节**上。ChatInput 今天恰好会重算,不代表它有义务永远重算;而这里离 `maker:create-session`
 * 只有一步,是「提交什么就校准什么」最后也最可靠的位置。重复校准无副作用:仍有效的来源原样返回。
 *
 * 用 effectiveSourceIdForModel 而不是 actualSourceIdForModel —— 后者的注释明确要求「新路由选择
 * (新会话 / 切模型 / worker / schedule)一律用前者」,而建会话与建目标都是新路由选择。失效时落到
 * 被控端对该模型的原生默认来源(也正是 ChatInput 高亮给用户看的那一个),比一律置 null 更贴合所见即所得。
 */
export function resolveDeviceLinkSubmission(p: DeviceLinkSubmissionParams): DeviceLinkCreateArgs {
  const providerId = effectiveSourceIdForModel(
    p.deviceProviders,
    p.candidate.providerId ?? null,
    p.candidate.model,
    p.capabilityAgentKind,
  );
  return buildDeviceLinkCreateArgs({
    agentKind: p.agentKind,
    id: p.id,
    workingDir: p.workingDir,
    model: p.candidate.model,
    effort: p.candidate.effort,
    permissionMode: p.candidate.permissionMode,
    fastMode: p.candidate.fastMode,
    extraDirs: p.extraDirs,
    writableDirs: p.writableDirs,
    providerId,
  });
}

export interface ProvisionalRemoteSessionParams {
  /** 被控端 create 响应里的会话 id。 */
  sessionId: string;
  /**
   * 被控端**真正分配**的运行目录(create 响应的 `workDir`)。纯对话由对端分配,控制端猜不到,
   * 所以只能取响应值 —— 而 SessionView 的 delayed-create 交接又硬要求 workingDir 非空。
   */
  workDir: string;
  /** 刚提交给被控端的那份 args:model / effort / permission / workspaceKind 等都以它为准。 */
  args: DeviceLinkCreateArgs;
  /** 当前时刻 ISO 串。由调用方注入,便于单测固定时间。 */
  nowIso: string;
}

/**
 * 远程会话的**临时行**:create 成功、权威快照(sessions:list 回流)还没到时先塞进镜像。
 *
 * 为什么必须有:origin 钉子只让「这条会话属于哪台设备」立刻可判定,但首条消息的交接另有门槛 ——
 * CCAgentSessionView 的 delayed-create effect 要求 `session` 非空**且** `session.workingDir`
 * 非空才会 consumePending。镜像里的会话行只有权威快照能带来,所以回流失败时那条消息就一直不发;
 * 而 `gave-up` 里的永久错误(老被控端没把 `local-db:sessions:list` 放进 allowlist、
 * REMOTE_DISABLED)意味着这一轮**永远**不会有快照,首条消息就永久躺着不发,草稿又已经清掉。
 *
 * 为什么不算编造:workDir 取 create 响应(对端真正分配的);model / effort / permissionMode /
 * workspaceKind / extraDirs / providerId 就是我们刚提交给它的值;title / 计数 / 时间戳是新会话的
 * 确定初值(被控端 create 出来的标题也正是 'New Maker')。权威快照到达后 setDeviceSessions 整片
 * 替换该设备分片,一切以对端为准。
 *
 * userId 是唯一取不到的字段(那是被控端库里的行主键关联),留空串:镜像消费方(侧边栏分组 /
 * SessionView / 传输层)都不读它,权威快照也会立刻覆盖。
 */
export function buildProvisionalRemoteSession(p: ProvisionalRemoteSessionParams): Session {
  return {
    id: p.sessionId,
    userId: '',
    // 被控端 create 的默认标题就是这个;auto-title 随后会按需覆盖(两端同一判据)。
    title: 'New Maker',
    workingDir: p.workDir,
    workspaceKind: p.args.workspaceKind,
    model: p.args.model,
    effort: p.args.effort,
    permissionMode: p.args.permissionMode,
    providerId: p.args.providerId ?? null,
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: p.args.fastMode,
    clearedAt: null,
    pinnedAt: null,
    // 用户此刻正在发第一条消息 —— 与本机路径建完会话就写 userSendAt 同口径,
    // 侧边栏按这条时间轴排序,新会话该立刻浮到顶部。
    userSendAt: p.nowIso,
    status: 'active',
    // Session.agentKind 是本机形态('cc' | 'codex' | 'pi'),args 里是 maker-core 形态,这里转回来。
    agentKind: p.args.agentKind === 'claude-code' ? 'cc' : p.args.agentKind,
    extraDirs: p.args.extraDirs ?? [],
    writableDirs: p.args.writableDirs ?? [],
    createdAt: p.nowIso,
    updatedAt: p.nowIso,
  };
}
