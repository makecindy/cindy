/**
 * remoteProjectsStore —— 控制端「远程项目」内存层(device-link 跨设备远程控制)。
 * ---------------------------------------------------------------------------
 * 设计目标:把被控设备的会话作为**额外项目**融入本地侧边栏,长得跟本机项目一样,
 * 只在标题旁多一个设备 icon。
 *
 * 关键原则(被控端 = 单一真相源,控制端 = 纯镜像):
 *  - **控制端零权威状态**:远端会话只活在这里的内存里,永不写本地 SQLite(被控端
 *    DB 才是数据真相)。断链 / 设备下线时保留最近一次快照并标成 disconnected,
 *    让 All Sessions 稳定;明确撤销 / 关闭控制 / 删除才移除。**不做任何乐观预测 / 本地覆盖**——
 *    视图 = f(bootstrap snapshot + 被控端 push 流):
 *      · snapshot(`setDeviceSessions`):listing tier 订阅后拉一次有界列表 / reconnect 重拉。
 *      · anti-entropy(`mergeDeviceSessions`):周期满窗口列表先更新命中行并保留窗口外会话，
 *        再由 refresh 层有界补查缺席 id 的终态；未满窗口则可直接安全替换。
 *      · 增量(`applyPatch`):收到被控端 `local-db:sessions:patched` push 时就地幂等合并;
 *        status=deleted/archived → 移出分片;落到未知 session → 丢弃(后续 snapshot 带最终态)。
 *      · 新建(`requestRemoteReseed`):`sessions:created` push 无 row 数据 → 触发该设备重拉。
 *    唯一例外是**投影层**的标题预览(`setPendingTitlePreview`):它不写分片、只在权威
 *    标题仍是系统占位(默认名 / fork 占位 / 本端登记过的合成占位)时顶替显示,被控端
 *    写下真正的标题一到就自动让位。分片数据仍是纯镜像。
 *  - **复用本地渲染管线**:每条 session 注入 `deviceLinkDeviceId/Name/ConnectionStatus`
 *    后喂给 `groupSessions`。
 *  - **origin 注册表**:`sessionId → deviceId`(`getSessionDeviceId`),供传输层 / SessionView 用。
 *  - **冷启动首屏借冷缓存**(`hydrateFromCache`):列表快照落在 main 的 userData
 *    (`main/device-link/mirrorCacheStore.ts`),冷启动时先画上次看到的行,免得侧边栏
 *    等一次 bootstrap 往返才出现远程项目。这不动摇「零权威状态」:种入的分片一律标
 *    **disconnected**(缓存不是 live 设备)、只在该设备还没有分片时种入,bootstrap 的
 *    `setDeviceSessions` 一到就整片替换;设备已不合格时由既有
 *    `resolveIneligibleRemoteProjectAction`(它的 `hasCachedShard` 判据)收敛为
 *    disconnect / remove。缓存永不参与写路径。
 *
 * 模块级 vanilla store + useSyncExternalStore;`getMergedRemoteSessions()` 返回缓存引用,
 * 仅在分片真正变化时才换新数组(满足 getSnapshot 引用稳定性,否则无限重渲染)。
 */

import { useSyncExternalStore } from 'react';
import { DEFAULT_DRAFT_SESSION_TITLE } from '@cindy/maker-shared/session-title';
import type { DeviceLinkConnectionStatus, Session } from '@/lib/ccAgent.types';
import { clearCachedMessages } from './mirrorCacheClient';

/** 单台被控设备的内存分片。 */
interface DeviceShard {
  deviceId: string;
  deviceName: string;
  connectionStatus: DeviceLinkConnectionStatus;
  /** 已打 device-link origin 标记的远端会话(可直接进 groupSessions)。 */
  sessions: Session[];
}

const shards = new Map<string, DeviceShard>();
const subs = new Set<() => void>();
/**
 * 正在读取任务快照的设备。它与 shard 是否存在独立：重连或手动重试时可以
 * 一边保留旧快照、一边明确告知用户「正在重新读取」。
 */
let bootstrapLoadingDeviceIds: ReadonlySet<string> = new Set();
/**
 * 最新一轮 bootstrap 以永久错误或重试耗尽告终的设备。这不是「权威空列表」；
 * 即使还保留旧 shard，UI 也必须标明读取失败。下一轮 bootstrap 开始时转 loading，
 * 成功 snapshot 才回到 ready。
 *
 * 两个集合都用不可变 Set 快照，保证 useSyncExternalStore 在内容不变时引用稳定。
 */
let bootstrapFailedDeviceIds: ReadonlySet<string> = new Set();
/**
 * 设备改名通知订阅(deviceId → 新名)。设备名走 REST PATCH(Device.name,不进 sessions 表),
 * 服务端不广播 presence;listing tier 把设备名缓存在自己的 eligible 表,改名时同步通知接入器
 * 对齐缓存名,避免下一轮拉取用旧名回填。这与「会话真相」无关,是设备元数据的即时性补丁。
 */
const renameSubs = new Set<(deviceId: string, name: string) => void>();

/**
 * snapshot epoch(per-device):防「旧 snapshot 覆盖新 snapshot」。listing tier 发起一次
 * 全量拉取前 `nextSnapshotEpoch(deviceId)`,await 回来后只有 `isLatestSnapshotEpoch` 仍成立
 * 才 setDeviceSessions —— 两次重拉乱序 resolve 时,旧的那次结果被丢弃。
 *
 * **单调不复用(ABA 防护)**:每设备 epoch 只增不减、失效时**自增**而非 delete/clear-to-0。
 * 若移除/断连时把 epoch 删掉(归零),下次 bootstrap 又从 1 开始 —— 断连前在途的 epoch=1 响应会与
 * reconnect 后新一轮的 epoch=1 撞值,旧响应通过 isLatestSnapshotEpoch 盖回新 snapshot(ABA)。
 * 故 mark disconnected / remove / clear 都用自增(条目保留,仅随 distinct 设备数增长,可忽略)。
 */
const snapshotEpoch = new Map<string, number>();

/**
 * 重拉实现注入点:listing tier(useDeviceLinkRemoteProjects)挂载时注册一个「(防抖)重拉该
 * 设备会话列表」的实现,卸载时清。`requestRemoteReseed` 供 push 消费侧(makerChatStore 的
 * sessions:created 路由、applyPatch 的 unarchive 兜底)调用,不直接依赖 hook。
 */
let reseedImpl: ((deviceId: string) => void) | null = null;
/**
 * 首次 sessions bootstrap 的显式重试实现。与普通 reseed 分开：普通 reseed 只做一次
 * merge snapshot；用户点击「重新读取任务」必须重新 subscribe，并让失败设备重新进入
 * bootstrap loading，完整语义由 listing tier 的 subscribeAndBootstrap 承担。
 */
let bootstrapRetryImpl: ((deviceId: string) => void) | null = null;

/** 扁平合并快照(缓存引用,变化时才换新)。 */
let mergedSnapshot: Session[] = [];
/** sessionId → deviceId 注册表(随分片变化重建)。 */
const sessionDeviceIndex = new Map<string, string>();
/**
 * 「归属已确定、但快照还没到」的 origin 钉子:sessionId → deviceId。
 *
 * 远程新建会话时,被控端 `maker:create-session` 一返回 id,那条会话就**确实存在**了;但把它带
 * 进镜像的 `sessions:list` 回流可能失败(链路刚断 / 对端 DB 未就绪 / 被更新的一次 refresh 取代)。
 * 那个窗口里 sessionDeviceIndex 没有这条,`getSessionDeviceId` 返回 undefined —— 传输层据此把
 * 一个**远程**会话的操作发给本机 maker:首条消息、setGoal、流订阅全落错边(#807 review P1)。
 *
 * 所以创建成功后立刻把这个已确定的事实钉进来,recompute 时先铺钉子、再让分片派生值覆盖
 * (分片更完整,且与钉子不可能冲突)。钉子只影响 origin 判定,不伪造会话行 —— 会话进列表仍等
 * 权威快照。
 *
 * 不主动清理(含 clear / removeDevice):与 stickySessionOrigin 同一论证 —— 归属是单向的
 * (会话不会从远程变回本机,本机会话永远不会进这张表),单次 app 运行内新建会话数量有限。
 * 设备真被解除配对后,钉子只会让操作走隧道并明确报错,而不是静默落到本机执行 —— 后者严重得多。
 */
const pinnedOrigins = new Map<string, string>();

const EMPTY: Session[] = [];

/** 单台被控设备在「机器切换栏」里的摘要(deviceId + 友好名 + 会话数)。 */
export interface RemoteDeviceSummary {
  deviceId: string;
  deviceName: string;
  sessionCount: number;
  /** true = 当前在线可控;false = 仅保留最近一次会话快照,用于断线时稳定侧边栏。 */
  connected: boolean;
}

/** 设备列表快照(缓存引用,内容不变时不换引用 → 满足 useSyncExternalStore getSnapshot 引用稳定性)。 */
let deviceListSnapshot: RemoteDeviceSummary[] = [];
const EMPTY_DEVICES: RemoteDeviceSummary[] = [];

/** 设备列表结构相等(顺序敏感):用于 deviceListSnapshot 引用稳定性判定。 */
function sameDeviceList(a: RemoteDeviceSummary[], b: RemoteDeviceSummary[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].deviceId !== b[i].deviceId ||
      a[i].deviceName !== b[i].deviceName ||
      a[i].sessionCount !== b[i].sessionCount ||
      a[i].connected !== b[i].connected
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 被控端建会话时的默认标题;权威标题仍等于它 = 还没起过名。
 *
 * 复用跨端共享常量:这串要与**被控端**(可能是另一个版本的客户端)写进 DB 的默认值
 * 逐字一致,不能本地化、也不能与 main 侧各写一份。
 */
const DEFAULT_REMOTE_SESSION_TITLE = DEFAULT_DRAFT_SESSION_TITLE;
/**
 * fork 会话的占位标题前缀("[Fork] …" / "[Fork·已剥离] …",非 i18n 串)。
 * 与被控端 `localDb/ipc/sessions.ts` 的 FORK_PLACEHOLDER_TITLE_PREFIX 同源;两边
 * 同样要求带 parentSessionId,免得用户手动改名成 "[Fork] ..." 的普通会话被误判。
 */
const FORK_PLACEHOLDER_TITLE_PREFIX = '[Fork';

/**
 * 已落地成权威标题的**系统合成占位**(sessionId → 标题串)。
 *
 * 纯附件的首条消息会让被控端把标题写成文件名 /「图片」这类合成占位。用户随后打下
 * 第一句话时被控端会改名,控制端本该同样即时预览 —— 但那时权威标题已经不是
 * "New Maker",只看默认占位的话预览会被一律拒掉,即时性恰好在这条恢复路径上缺席
 * (review P1)。这里记住"这串是系统合成的占位",让它和默认标题同等看待。
 *
 * **归属来自登记时的 isUserText,不靠字符串相等推断**:被控端对合成占位不调标题
 * 模型,写下的就是占位;而用户文字的占位可能因模型无结果而**就地定稿**,那是一个
 * 终态标题,绝不能记成系统占位 —— 否则之后每条消息的预览都能盖着它不放,而权威
 * 侧再也不会发新 patch 来纠正(review P1)。
 */
const landedSystemTitles = new Map<string, string>();

/**
 * 已登记但尚未被权威标题确认的**合成**预览(sessionId 集合)。
 *
 * 只有它里面的会话,其权威标题被**逐字确认**时才记成系统占位。
 *
 * 为什么坚持逐字、不肯认「下一个非默认标题」:那样会把恰好在这个窗口里到达的
 * **用户手动改名**也当成合成占位登记进来,之后预览就能长期顶掉用户自己起的名字,
 * 而被控端正确地拒绝给手动命名的会话改名、不会有 patch 来纠正(review P1)。
 * user rename wins 优先于预览的即时性。
 *
 * 代价(已知且刻意接受):两端 UI 语言不同、且首条消息拿不到任何文件名(粘贴截图
 * 之类只能回落到「图片」/「文件」这类 i18n 串)时,两端算出的占位不逐字相等,归属
 * 登记不上 —— 表现为那条会话的后续首句话没有即时预览,仍会经隧道往返正常改名。
 * 少一次即时性,好过顶掉用户的名字。文件名 / mention 名 / 被引用会话标题都不是
 * i18n 串,两端必然一致,常见路径不受影响。
 */
const synthesizedPreviewSessions = new Set<string>();

/**
 * 「发送瞬间的标题预览」——控制端本地叠加层,**不写进分片**。
 *
 * 远程会话的权威标题由被控端写、经 `sessions:patched` 回流,中间隔一次隧道往返,
 * 这段时间侧边栏会停在 "New Maker"。控制端在发送瞬间就能用同一套推导算出与被控端
 * 一致的占位串,先在**投影层**顶上,让改名即时可见。
 *
 * 为什么这不破坏「分片 = 纯镜像、不做乐观覆盖」原则:
 *  - 分片里的 session 行一个字节都没被改写,预览只作用于 recompute 的投影;
 *  - 仅在权威标题仍是**系统占位**时生效 —— 被控端写下真正的标题(智能标题或用户
 *    改名)一旦到达就自动让位并回收条目,不需要显式失效逻辑;snapshot /
 *    anti-entropy 重建同理。
 *
 * 边界:消息若最终没送达,被控端不会起名,预览会一直顶着(展示的是用户自己刚发的
 * 内容,不误导);重启后预览不存在,回落到权威标题。
 */
const pendingTitlePreview = new Map<string, string>();

/** 该标题是否仍属"系统占位"(可被预览顶替)。 */
function isSystemOwnedTitle(session: Pick<Session, 'id' | 'title' | 'parentSessionId'>): boolean {
  if (session.title === DEFAULT_REMOTE_SESSION_TITLE) return true;
  if (session.parentSessionId && session.title.startsWith(FORK_PLACEHOLDER_TITLE_PREFIX))
    return true;
  return landedSystemTitles.get(session.id) === session.title;
}

/** 会话彻底离场(删除 / 归档 / 设备移除 / 整体清空)时回收叠加层三张表。 */
function dropTitleOverlay(sessionId: string): void {
  pendingTitlePreview.delete(sessionId);
  landedSystemTitles.delete(sessionId);
  synthesizedPreviewSessions.delete(sessionId);
}

/** 应用标题预览:权威标题不再是系统占位时让位并回收。 */
function withPendingTitle(session: Session): Session {
  const preview = pendingTitlePreview.get(session.id);
  if (!preview) return session;

  if (session.title === preview) {
    // 权威标题与本端预览逐字相同 → 确实是被控端对这条预览的回应(不可能是用户
    // 手动改名"恰好"改成同一串;真撞上了也只是把它当占位,与本机路径同一取舍)。
    if (synthesizedPreviewSessions.has(session.id)) {
      // 合成占位:被控端之后还要把它换掉,记下归属,用户打下第一句话时还能顶替。
      synthesizedPreviewSessions.delete(session.id);
      pendingTitlePreview.delete(session.id);
      landedSystemTitles.set(session.id, session.title);
      return session;
    }
    // 用户文字的预览落地 → 整个叠加层作废。**不**记系统占位:被控端的智能标题
    // 可能就此定稿,那是终态,不能让后续预览一直盖着它。更早那条合成占位的归属也
    // 一并清掉 —— 留着的话用户日后手动把标题改回那个串会被误判成系统占位。
    dropTitleOverlay(session.id);
    return session;
  }
  if (!isSystemOwnedTitle(session)) {
    dropTitleOverlay(session.id);
    return session;
  }
  return { ...session, title: preview };
}

/** 重算扁平快照 + origin 注册表,然后通知订阅者。所有 mutation 走这里。 */
function recompute(): void {
  sessionDeviceIndex.clear();
  // 先铺 origin 钉子:分片还没到的新建远程会话也必须能被判定为远程(见 pinnedOrigins)。
  // 分片派生值随后覆盖同 id 的条目。
  for (const [sessionId, deviceId] of pinnedOrigins) sessionDeviceIndex.set(sessionId, deviceId);
  if (shards.size === 0) {
    mergedSnapshot = EMPTY;
  } else {
    const flat: Session[] = [];
    for (const shard of shards.values()) {
      for (const s of shard.sessions) {
        flat.push(withPendingTitle(s));
        sessionDeviceIndex.set(s.id, shard.deviceId);
      }
    }
    mergedSnapshot = flat;
  }
  // 设备列表快照:按 deviceName(再 deviceId 兜底)稳定排序,避免 Map 插入序在设备增删时
  // 抖动导致切换栏 chip 乱跳;内容不变时保持旧引用(防 useRemoteDevices 无谓重渲染)。
  if (shards.size === 0) {
    if (deviceListSnapshot.length !== 0) deviceListSnapshot = EMPTY_DEVICES;
  } else {
    const nextDevices: RemoteDeviceSummary[] = [...shards.values()]
      .map((shard) => ({
        deviceId: shard.deviceId,
        deviceName: shard.deviceName,
        sessionCount: shard.sessions.length,
        connected: shard.connectionStatus === 'connected',
      }))
      .sort(
        (a, b) => a.deviceName.localeCompare(b.deviceName) || a.deviceId.localeCompare(b.deviceId),
      );
    if (!sameDeviceList(deviceListSnapshot, nextDevices)) deviceListSnapshot = nextDevices;
  }
  subs.forEach((fn) => fn());
}

/** 更新 bootstrap 状态但不通知；调用方与其它 mutation 合并成一次通知。 */
function setBootstrapState(deviceId: string, state: 'idle' | 'loading' | 'failed'): boolean {
  const wasLoading = bootstrapLoadingDeviceIds.has(deviceId);
  const wasFailed = bootstrapFailedDeviceIds.has(deviceId);
  const loading = state === 'loading';
  const failed = state === 'failed';
  if (wasLoading === loading && wasFailed === failed) return false;

  if (wasLoading !== loading) {
    const next = new Set(bootstrapLoadingDeviceIds);
    if (loading) next.add(deviceId);
    else next.delete(deviceId);
    bootstrapLoadingDeviceIds = next;
  }
  if (wasFailed !== failed) {
    const next = new Set(bootstrapFailedDeviceIds);
    if (failed) next.add(deviceId);
    else next.delete(deviceId);
    bootstrapFailedDeviceIds = next;
  }
  return true;
}

/** 给一条远端会话打上 device-link origin 标记(供 groupSessions + 传输层识别)。 */
function stamp(
  session: Session,
  deviceId: string,
  deviceName: string,
  connectionStatus: DeviceLinkConnectionStatus,
): Session {
  return {
    ...session,
    deviceLinkDeviceId: deviceId,
    deviceLinkDeviceName: deviceName,
    deviceLinkConnectionStatus: connectionStatus,
  };
}

const actions = {
  /**
   * 写入 / 覆盖某台设备的整份会话列表(bootstrap 订阅后拉一次 / reconnect 重拉 / reseed)。
   * rawSessions 是被控端 local-db:sessions:list 原样返回的 Session[],本函数负责打标记。
   * 逐字节不变时跳过(避免无谓重渲染);epoch 乱序保护在调用方(listing tier)用
   * nextSnapshotEpoch/isLatestSnapshotEpoch 完成,本函数无条件替换。
   */
  setDeviceSessions(deviceId: string, deviceName: string, rawSessions: readonly Session[]): void {
    const connectionStatus: DeviceLinkConnectionStatus = 'connected';
    const stamped = rawSessions.map((s) => stamp(s, deviceId, deviceName, connectionStatus));
    const existing = shards.get(deviceId);
    const bootstrapStateCleared = setBootstrapState(deviceId, 'idle');
    if (
      existing &&
      existing.connectionStatus === connectionStatus &&
      JSON.stringify(existing.sessions) === JSON.stringify(stamped)
    ) {
      // 内容不变但设备名可能变了(改名走 renameDevice,不经这里);保持引用不动。
      if (bootstrapStateCleared) subs.forEach((fn) => fn());
      return;
    }
    // 权威快照会整片替换分片:此前在片里、这次没回来的会话(patch 丢失期间被归档 /
    // 删除)就此离场,它们的叠加层必须在这里回收 —— 之后 removeDevice 只遍历片里
    // 还在的会话,再也够不着它们,unarchive/reseed 同一个仍是系统占位的会话时旧
    // 预览会复活(PR #510 review P1)。
    // mergeDeviceSessions(anti-entropy 半窗口)先把窗口外的会话并回 stamped 才
    // 调到这里,不会被误判成离场。
    if (existing) {
      const kept = new Set(stamped.map((session) => session.id));
      for (const session of existing.sessions) {
        if (!kept.has(session.id)) dropTitleOverlay(session.id);
      }
    }
    shards.set(deviceId, { deviceId, deviceName, connectionStatus, sessions: stamped });
    recompute();
  },

  /**
   * 冷启动:用本地冷缓存的列表快照种入分片,让侧边栏在 bootstrap 往返之前就有内容。
   *
   * 三条硬约束(见文件头「冷启动首屏借冷缓存」):
   *  - 只种**尚无分片**的设备:任何权威数据(snapshot / patch)都优先,缓存绝不覆盖它。
   *  - 一律标 **disconnected**:缓存不是 live 设备,标 connected 会画出假在线,
   *    也会让「新建对话」这类以连接态为准的判定误放行。
   *  - 不清 bootstrapFailed、不动 epoch:种入不是一次拉取,不参与乱序保护。
   */
  hydrateFromCache(
    devices: ReadonlyArray<{ deviceId: string; deviceName: string; sessions: readonly Session[] }>,
  ): void {
    let changed = false;
    for (const device of devices) {
      const deviceId = device.deviceId?.trim();
      if (!deviceId || shards.has(deviceId)) continue;
      if (device.sessions.length === 0) continue;
      const deviceName = device.deviceName?.trim() || deviceId;
      shards.set(deviceId, {
        deviceId,
        deviceName,
        connectionStatus: 'disconnected',
        sessions: device.sessions.map((s) => stamp(s, deviceId, deviceName, 'disconnected')),
      });
      changed = true;
    }
    if (changed) recompute();
  },

  /** 新一轮 bootstrap 开始：保留旧 shard，但显式进入读取中。 */
  markBootstrapLoading(deviceId: string): void {
    if (!setBootstrapState(deviceId, 'loading')) return;
    subs.forEach((fn) => fn());
  },

  /** bootstrap 永久失败 / 重试耗尽：保留旧 shard，但标明它不是本轮权威结果。 */
  markBootstrapFailed(deviceId: string): void {
    if (!setBootstrapState(deviceId, 'failed')) return;
    subs.forEach((fn) => fn());
  },

  /** 清除已被更新请求抢占的 loading 状态；不把它误报成一次终态失败。 */
  clearBootstrapLoading(deviceId: string): void {
    if (!bootstrapLoadingDeviceIds.has(deviceId)) return;
    const next = new Set(bootstrapLoadingDeviceIds);
    next.delete(deviceId);
    bootstrapLoadingDeviceIds = next;
    subs.forEach((fn) => fn());
  },

  /** 只清失败标记的兼容入口；snapshot 成功会由 setDeviceSessions 清掉全部 bootstrap 状态。 */
  clearBootstrapFailure(deviceId: string): void {
    if (!bootstrapFailedDeviceIds.has(deviceId)) return;
    const next = new Set(bootstrapFailedDeviceIds);
    next.delete(deviceId);
    bootstrapFailedDeviceIds = next;
    subs.forEach((fn) => fn());
  },

  /**
   * 合并一份有界会话快照。周期 anti-entropy 只拿最近 LIST_LIMIT 条 + 旧置顶，响应缺席
   * 不能证明窗口外会话已归档/删除；因此命中行用权威值替换，未命中行先保留，再由 refresh
   * 层有界补查终态。首次无分片时等价于 setDeviceSessions。
   */
  mergeDeviceSessions(deviceId: string, deviceName: string, rawSessions: readonly Session[]): void {
    const existing = shards.get(deviceId);
    if (!existing) {
      actions.setDeviceSessions(deviceId, deviceName, rawSessions);
      return;
    }
    const incomingIds = new Set(rawSessions.map((session) => session.id));
    actions.setDeviceSessions(deviceId, deviceName, [
      ...rawSessions,
      ...existing.sessions.filter((session) => !incomingIds.has(session.id)),
    ]);
  },

  /**
   * 应用一条被控端 `local-db:sessions:patched` 增量(push 驱动镜像核心)。幂等:
   *  - status ∈ {deleted, archived} → 从分片移除该会话(active 视图不含)。
   *  - 其它字段(title/pinnedAt/model/effort/...)→ 就地合并。
   *  - 落到未知 session:若 status=active(unarchive 应重新出现)→ 触发 reseed 拉回;否则丢弃
   *    (后续 snapshot 自带最终态;对不在 active 视图的会话的改动控制端不关心)。
   */
  applyPatch(deviceId: string, sessionId: string, patch: Record<string, unknown>): void {
    const terminal = patch.status === 'deleted' || patch.status === 'archived';
    // 终态清缓存必须放在**所有早退之前**:这个会话可能不在当前(有界)分片里、甚至这台设备
    // 还没有分片,但它完全可能有一份上次打开时留下的消息缓存文件 —— 那时早退就等于把
    // 「别的控制端刚删掉的会话」的正文一直留在盘上,直到 LRU 逐出 / 设备移除 / 登出
    // (review: codex P1)。缓存是纯优化,多清一次无害。
    if (terminal) clearCachedMessages(deviceId, sessionId);
    const shard = shards.get(deviceId);
    if (!shard) return;
    const idx = shard.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) {
      if (patch.status === 'active') requestRemoteReseed(deviceId);
      return;
    }
    const status = patch.status;
    if (status === 'deleted' || status === 'archived') {
      // 叠加层随会话一起离场:留着的话 removeDevice 也回收不到(它只遍历分片里还在的
      // 会话),之后 unarchive / reseed 会把边界前的旧预览顶回一个仍是系统占位的
      // 会话上(PR #510 review)。
      dropTitleOverlay(sessionId);
      // 消息冷缓存已在函数开头清掉(那里能覆盖"会话不在分片里"的情形)。
      shard.sessions = shard.sessions.filter((s) => s.id !== sessionId);
      recompute();
      return;
    }
    const wasPinned = shard.sessions[idx]?.pinnedAt != null;
    const unpinned =
      Object.prototype.hasOwnProperty.call(patch, 'pinnedAt') && patch.pinnedAt == null;
    shard.sessions = shard.sessions.map((s) =>
      s.id === sessionId
        ? {
            ...s,
            ...(patch as Partial<Session>),
            deviceLinkDeviceId: shard.deviceId,
            deviceLinkDeviceName: shard.deviceName,
            deviceLinkConnectionStatus: shard.connectionStatus,
          }
        : s,
    );
    recompute();
    if (wasPinned && unpinned) requestRemoteReseed(deviceId);
  },

  /**
   * 设备改名:即时把新名落到该设备分片 + 通知接入器对齐缓存名。设备未并入侧边栏时仅通知。
   * 由设置页 rename 成功后调用(设备名是 Device 元数据,非会话真相)。
   */
  renameDevice(deviceId: string, name: string): void {
    const shard = shards.get(deviceId);
    if (shard && shard.deviceName !== name) {
      shard.deviceName = name;
      shard.sessions = shard.sessions.map((s) => ({
        ...s,
        deviceLinkDeviceName: name,
        deviceLinkConnectionStatus: shard.connectionStatus,
      }));
      recompute();
    }
    renameSubs.forEach((fn) => fn(deviceId, name));
  },

  /**
   * 标记某台设备暂不可达,但保留最近一次会话快照。用于 presence offline / relay
   * connecting 等瞬态断线,避免 All Sessions 因网络抖动反复增删远程会话。
   */
  markDeviceDisconnected(deviceId: string): void {
    snapshotEpoch.set(deviceId, (snapshotEpoch.get(deviceId) ?? 0) + 1);
    const bootstrapStateCleared = setBootstrapState(deviceId, 'idle');
    const shard = shards.get(deviceId);
    if (!shard || shard.connectionStatus === 'disconnected') {
      if (bootstrapStateCleared) subs.forEach((fn) => fn());
      return;
    }
    shard.connectionStatus = 'disconnected';
    shard.sessions = shard.sessions.map((s) => ({
      ...s,
      deviceLinkConnectionStatus: 'disconnected',
    }));
    recompute();
  },

  /** 标记全部已缓存远程设备暂不可达,但不清空侧边栏会话快照。 */
  markAllDisconnected(): void {
    for (const [k, v] of snapshotEpoch) snapshotEpoch.set(k, v + 1);
    const bootstrapStateChanged =
      bootstrapLoadingDeviceIds.size > 0 || bootstrapFailedDeviceIds.size > 0;
    if (bootstrapLoadingDeviceIds.size > 0) bootstrapLoadingDeviceIds = new Set();
    if (bootstrapFailedDeviceIds.size > 0) bootstrapFailedDeviceIds = new Set();
    let shardChanged = false;
    for (const shard of shards.values()) {
      if (!snapshotEpoch.has(shard.deviceId)) snapshotEpoch.set(shard.deviceId, 1);
      if (shard.connectionStatus === 'disconnected') continue;
      shardChanged = true;
      shard.connectionStatus = 'disconnected';
      shard.sessions = shard.sessions.map((s) => ({
        ...s,
        deviceLinkConnectionStatus: 'disconnected',
      }));
    }
    if (shardChanged) recompute();
    else if (bootstrapStateChanged) subs.forEach((fn) => fn());
  },

  /** 移除某台设备的所有远端会话(访问撤销 / 关被控 / 本机禁用控制 / 删除)。 */
  removeDevice(deviceId: string): void {
    // **自增**该设备 epoch(不 delete,见 snapshotEpoch 注释的 ABA):在途 refreshRemoteDeviceSessions
    // 的 epoch 立即失效,且下次 bootstrap 拿到更高 epoch,不会与断连前在途的 epoch 撞值。即使尚未建
    // shard(首拉未完成就被移除)也要 bump,否则在途首拉 await 回来仍能通过 isLatestSnapshotEpoch 加回。
    snapshotEpoch.set(deviceId, (snapshotEpoch.get(deviceId) ?? 0) + 1);
    // 标题叠加层随分片一起丢弃:撤销授权 / 关闭控制后该设备的会话已不在视图里,
    // 留着会在下次重新接入时把边界前的旧预览顶回一个仍是系统占位的会话上。
    for (const session of shards.get(deviceId)?.sessions ?? []) {
      dropTitleOverlay(session.id);
    }
    const shardDeleted = shards.delete(deviceId);
    const bootstrapStateCleared = setBootstrapState(deviceId, 'idle');
    if (shardDeleted) recompute();
    else if (bootstrapStateCleared) subs.forEach((fn) => fn());
  },

  /** 清空所有远端项目(登出 / device-link stopped / 卸载)。 */
  clear(): void {
    // 所有设备 epoch 无条件**自增**(不 clear-to-0,见 snapshotEpoch 注释的 ABA):清空时在途
    // 首拉立即失效;下一轮 bootstrap 拿到更高 epoch,不会与清空前的 epoch 撞值把陈旧 snapshot 盖回。
    for (const [k, v] of snapshotEpoch) snapshotEpoch.set(k, v + 1);
    // 登出 / device-link stopped 是明确的生命周期边界:叠加层是本次会话期的临时
    // 显示态,跨过边界后不该复活(也避免长期留存用户输入的文本)。
    pendingTitlePreview.clear();
    landedSystemTitles.clear();
    synthesizedPreviewSessions.clear();
    const bootstrapStateChanged =
      bootstrapLoadingDeviceIds.size > 0 || bootstrapFailedDeviceIds.size > 0;
    if (bootstrapLoadingDeviceIds.size > 0) bootstrapLoadingDeviceIds = new Set();
    if (bootstrapFailedDeviceIds.size > 0) bootstrapFailedDeviceIds = new Set();
    if (shards.size === 0) {
      if (bootstrapStateChanged) subs.forEach((fn) => fn());
      return;
    }
    shards.clear();
    recompute();
  },

  /** 侧边栏合并点用:当前所有远端会话的扁平列表(引用稳定)。 */
  getMergedRemoteSessions(): Session[] {
    return mergedSnapshot;
  },

  /**
   * 发送瞬间登记标题预览(见 {@link pendingTitlePreview})。只影响投影层显示,
   * 权威标题仍由被控端写回;被控端标题到达后本条自动失效。
   *
   * @param isUserText 这串是用户真正写下的文字(true)还是本地合成的描述(false)。
   *   合成描述对应「被控端会先写占位、之后还要换掉」,要登记成系统占位归属;用户
   *   文字对应的标题可能就此定稿,不能登记(见 {@link landedSystemTitles})。
   */
  setPendingTitlePreview(sessionId: string, title: string, isUserText = true): void {
    const next = title.trim();
    if (!sessionId || !next) return;
    const previous = pendingTitlePreview.get(sessionId);
    if (previous === next) {
      // 同一串重复登记:归属状态也不该翻转(纯附件消息重复触发时保持合成归属)。
      if (!isUserText) synthesizedPreviewSessions.add(sessionId);
      return;
    }
    // 权威标题已经不是系统占位(智能标题已落 / 用户改过名)→ 预览本来就不会生效,
    // 直接 no-op,省掉一次「写入 → recompute → withPendingTitle 立刻回收」的空转。
    // 反过来,合成占位与 fork 占位仍算系统占位:被控端正准备把它们换掉,控制端这
    // 一步就是要抢在隧道往返之前先顶上(review P1)。
    const known = sessionDeviceIndex.get(sessionId);
    if (known) {
      const row = shards.get(known)?.sessions.find((s) => s.id === sessionId);
      if (row && !isSystemOwnedTitle(row)) return;
    }
    // 被顶掉的那条**合成**预览可能还在隧道里飞:用户在附件占位回流之前就打了字时,
    // 旧占位随后才到。它此刻既不等于当前预览、也不在归属表里,会被当成用户手动改名
    // 而把新预览整个丢掉,侧边栏于是回退到附件名直到下一跳(review P1)。先把它记进
    // 归属表,认出它是系统占位、让新预览继续顶着。
    if (previous && synthesizedPreviewSessions.has(sessionId)) {
      landedSystemTitles.set(sessionId, previous);
    }
    if (isUserText) synthesizedPreviewSessions.delete(sessionId);
    else synthesizedPreviewSessions.add(sessionId);
    pendingTitlePreview.set(sessionId, next);
    recompute();
  },

  /** 测试专用:清空标题预览叠加层。 */
  __resetPendingTitlePreviewForTest(): void {
    pendingTitlePreview.clear();
    landedSystemTitles.clear();
    synthesizedPreviewSessions.clear();
  },

  /** 测试专用:清空 origin 钉子(生产期刻意不清,见 pinnedOrigins)。 */
  __resetPinnedOriginsForTest(): void {
    pinnedOrigins.clear();
    recompute();
  },

  /** refresh anti-entropy 用:取某设备当前缓存分片，调用方只读。 */
  getDeviceSessions(deviceId: string): readonly Session[] {
    return shards.get(deviceId)?.sessions ?? EMPTY;
  },

  /**
   * origin 判定:给定 sessionId 返回其所属被控设备 deviceId;本地会话返回 undefined。
   * 传输层 / SessionView / 消息分页据此决定走本机 IPC 还是 deviceLink 隧道。
   */
  getSessionDeviceId(sessionId: string): string | undefined {
    return sessionDeviceIndex.get(sessionId);
  },

  /**
   * 远程新建会话后**立刻**登记归属(见 pinnedOrigins)。只让 origin 判定即刻可用,不制造会话行;
   * 权威快照回流后由分片派生值接管。幂等。
   */
  pinSessionOrigin(deviceId: string, sessionId: string): void {
    if (pinnedOrigins.get(sessionId) === deviceId) return;
    pinnedOrigins.set(sessionId, deviceId);
    recompute();
  },

  /** 取设备友好名(tooltip / 日志用)。 */
  getDeviceName(deviceId: string): string | undefined {
    return shards.get(deviceId)?.deviceName;
  },

  /** 当前是否保留着该设备的远程会话快照(connected 或 disconnected 都算)。 */
  hasDevice(deviceId: string): boolean {
    return shards.has(deviceId);
  },

  /** 当前在线可控的被控设备 id 列表。断线缓存仍显示,但不算 host online。 */
  getDeviceIds(): string[] {
    return [...shards.values()]
      .filter((shard) => shard.connectionStatus === 'connected')
      .map((shard) => shard.deviceId);
  },

  /**
   * **保留着分片的全部**设备 id(connected + disconnected)。
   *
   * 与 `getDeviceIds()` 的区别是刻意的,两者不可混用:那个是「在线可控」语义(anti-entropy
   * 轮询、Stop 按钮的 host-online 判定都只该看在线设备);这个是「本端还留着谁的镜像」语义,
   * 给需要遍历全部留存分片的场景用 —— 冷缓存回写(断连设备也要写进快照,否则下次冷启动
   * 就恢复不出它)、以及按权威列表收掉缺席分片(缓存种入的分片一律是 disconnected,
   * 用 connected-only 的访问器根本遍历不到它们)。见 review(codex P1)。
   */
  getAllDeviceIds(): string[] {
    return [...shards.keys()];
  },

  /** 机器切换栏用:当前已同步或保留断线缓存的被控设备摘要列表(引用稳定 + 稳定排序)。 */
  getDeviceList(): RemoteDeviceSummary[] {
    return deviceListSnapshot;
  },

  /** 正在读取任务快照的设备 id（可同时保留旧 shard）。 */
  getBootstrapLoadingDeviceIds(): ReadonlySet<string> {
    return bootstrapLoadingDeviceIds;
  },

  /** 最新一轮任务快照已终态失败的设备 id（可同时保留旧 shard）。 */
  getBootstrapFailedDeviceIds(): ReadonlySet<string> {
    return bootstrapFailedDeviceIds;
  },

  /** snapshot 乱序保护:发起一次全量拉取前取新 epoch。 */
  nextSnapshotEpoch(deviceId: string): number {
    const n = (snapshotEpoch.get(deviceId) ?? 0) + 1;
    snapshotEpoch.set(deviceId, n);
    return n;
  },

  /** snapshot 乱序保护:await 回来后判断本次拉取是否仍是最新一次(否则丢弃结果)。 */
  isLatestSnapshotEpoch(deviceId: string, epoch: number): boolean {
    return snapshotEpoch.get(deviceId) === epoch;
  },
};

function subscribe(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** 订阅设备改名通知(接入器据此对齐缓存名)。 */
function subscribeRename(fn: (deviceId: string, name: string) => void): () => void {
  renameSubs.add(fn);
  return () => {
    renameSubs.delete(fn);
  };
}

/** listing tier 挂载时注册「重拉某设备」的实现;卸载时传 null 清。 */
export function setRemoteReseedImpl(fn: ((deviceId: string) => void) | null): void {
  reseedImpl = fn;
}

/** listing tier 挂载时注册「重试首次 sessions bootstrap」实现；卸载时传 null 清。 */
export function setRemoteSessionBootstrapRetryImpl(fn: ((deviceId: string) => void) | null): void {
  bootstrapRetryImpl = fn;
}

/**
 * 请求重拉某被控设备的会话列表(reconcile)。由 push 消费侧调用:
 *  - `sessions:created`(无 row 数据)→ 重拉该设备;
 *  - applyPatch 收到未知 session 的 status=active(unarchive)→ 重拉补回。
 * 实现(含防抖)由 listing tier 注入;未挂载时 no-op。
 */
export function requestRemoteReseed(deviceId: string): void {
  reseedImpl?.(deviceId);
}

/** 用户可见错误态的重试入口：重新订阅并拉取该设备的首次任务快照。 */
export function retryRemoteSessionBootstrap(deviceId: string): void {
  bootstrapRetryImpl?.(deviceId);
}

/** 组件内订阅:返回扁平远端会话快照(喂给 sidebar 合并点)。 */
export function useRemoteProjectSessions(): Session[] {
  return useSyncExternalStore(subscribe, actions.getMergedRemoteSessions);
}

/** 组件内订阅:返回当前已连接的被控设备摘要列表(机器切换栏 chips)。 */
export function useRemoteDevices(): RemoteDeviceSummary[] {
  return useSyncExternalStore(subscribe, actions.getDeviceList);
}

/** 组件内订阅：bootstrap 已终态失败、下一次重试尚未开始的设备集合。 */
export function useRemoteBootstrapFailedDeviceIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, actions.getBootstrapFailedDeviceIds);
}

/** 组件内订阅：当前正在重新读取任务快照的设备集合。 */
export function useRemoteBootstrapLoadingDeviceIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, actions.getBootstrapLoadingDeviceIds);
}

/** 非组件上下文(presence 订阅器 / 传输层)读写入口。 */
export const remoteProjectsStore = { ...actions, subscribe, subscribeRename };

/** 便捷导出:传输层只关心 origin 判定。 */
export function getSessionDeviceId(sessionId: string): string | undefined {
  return actions.getSessionDeviceId(sessionId);
}
