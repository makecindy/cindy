/**
 * 首页会话行滑动操作的纯逻辑层(刻意不依赖 react / react-native,便于 node 单测):
 *  - createSwipeRowRegistry:同一时间只允许一行处于滑开状态的互斥注册表;
 *  - pinToggleAction / buildSessionActionMenu / swipeActionPatch:
 *    「置顶态 → 动作与文案」「选项菜单模型」「动作 → RPC 补丁」的确定性映射,
 *    补丁生成直接转发共享层 mobileSessionBulkPatch,不自己拼字段。
 */
import { i18n } from '@/i18n';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import {
  mobileSessionBulkPatch,
  type MobileSessionBulkPatch,
} from '@/session/sessionSelection';

/** swipe / 选项菜单可触发的全部动作。rename 无补丁形态(走重命名弹窗),单独排除。 */
export type SessionSwipeAction = 'pin' | 'unpin' | 'archive' | 'delete' | 'rename';

export interface SwipeRowRegistry {
  /**
   * 行开始滑开时上报(swipe 手势起手即调):自动关掉上一个打开的行,并把自己记为当前行。
   * 同一行重复上报是 no-op(不会自己关自己)。
   */
  onRowOpen(key: string, close: () => void): void;
  /**
   * 行自己关闭 / 卸载时注销。只有当前记录仍是自己时才清除 —— 关闭动画的回调可能晚于
   * 下一行的 onRowOpen 到达,晚到的注销不能抹掉新行的记录。
   */
  onRowClose(key: string): void;
  /** 关闭当前打开的行;返回是否真的关了(供「打开态点击 = 只关闭不进会话」判断)。 */
  closeOpenRow(): boolean;
}

/** 页面级单例(useMemo 持有),SectionList 各行共享同一实例实现互斥。 */
export function createSwipeRowRegistry(): SwipeRowRegistry {
  let current: { key: string; close: () => void } | null = null;
  return {
    onRowOpen(key, close) {
      if (current && current.key !== key) current.close();
      current = { key, close };
    },
    onRowClose(key) {
      if (current?.key === key) current = null;
    },
    closeOpenRow() {
      if (!current) return false;
      current.close();
      current = null;
      return true;
    },
  };
}

export interface LatestWriteGuard {
  /**
   * 开始一笔写:立即把本笔登记为该 key 下 fields 各字段的最新写。返回的 isLatest()
   * 实时判断本笔是否仍是全部字段的最新(后续对同 key 的**交集字段**再 begin 才会使
   * 旧笔过期;字段无交集的写互不取代)。
   */
  begin(key: string, fields: readonly string[]): { isLatest(): boolean };
}

/**
 * 「每 key 每字段最新写」守卫:同一会话并发多笔乐观写时,只有仍持有自己全部字段
 * 最新权的一笔有资格重发 / 对账 / 回滚,被同字段新写取代的旧笔迟到结果一律作废——
 * 否则旧笔失败的回滚(或慢回包的对账)会覆盖后续已成功的操作。
 *
 * 粒度按字段而非整会话(review P1:重命名 title 在退避中,用户随后置顶 pinnedAt,
 * 两笔字段无交集——重命名不得被置顶取代而静默丢弃,否则乐观标题成幻影,下次同步
 * 才跳回旧值)。同字段覆盖(置顶→取消置顶,归档→删除)才是真取代,旧笔让位。
 *
 * 计数器每 key:field 单调递增、**永不回收**(review P2:若最新笔终结时删掉登记,
 * 下一笔会从 1 重新计数,与仍在途的旧笔序号撞车,旧笔迟到结果会误判自己是最新)。
 * 代价是每个操作过的会话字段常驻一个 number,页面生命周期内可忽略。
 */
export function createLatestWriteGuard(): LatestWriteGuard {
  const seqs = new Map<string, number>();
  return {
    begin(key, fields) {
      const mine = fields.map((field) => {
        const slot = `${key} ${field}`;
        const seq = (seqs.get(slot) ?? 0) + 1;
        seqs.set(slot, seq);
        return [slot, seq] as const;
      });
      return {
        isLatest: () => mine.every(([slot, seq]) => seqs.get(slot) === seq),
      };
    },
  };
}

/**
 * 从远端回包 / 本地旧快照中只挑出本笔负责的字段(外加远端时间戳 updatedAt)构成
 * 对账 / 回滚补丁:字段级写序下,整对象覆盖会擦掉其它字段上后续写的乐观值
 * (review P1 场景的另一半:重命名回包不得把置顶新写的 pinnedAt 冲回旧值)。
 *
 * updatedAt 单调不回退(review P2):两条无交集道并行时(title 重试 + pinnedAt),
 * 晚 settle 的旧回包不得把另一道刚推进的 updatedAt 倒退——传入 floorUpdatedAt
 * (调用时 store 里的当前值),仅当 source 的 updatedAt 更新时才带上(ISO 同格式,
 * 字典序即时间序)。
 */
export function pickWriteFields<T extends object>(
  source: T,
  fields: readonly string[],
  floorUpdatedAt?: string | null,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) out[field] = (source as Record<string, unknown>)[field];
  }
  const nextUpdatedAt = (source as Record<string, unknown>)['updatedAt'];
  if (typeof nextUpdatedAt === 'string' && (!floorUpdatedAt || nextUpdatedAt > floorUpdatedAt)) {
    out['updatedAt'] = nextUpdatedAt;
  }
  return out as Partial<T>;
}

export interface SessionWriteQueue {
  /**
   * 把一笔远端写挂到该 key 下 fields 各字段队列的队尾:所有交集字段的前笔 settle
   * (成功/失败/让位)后才执行;无交集字段的写互不排队、并行出网。
   */
  enqueue<T>(key: string, fields: readonly string[], task: () => Promise<T>): Promise<T>;
}

/**
 * 每 key **按字段分道**的远端写串行化队列:同字段的 patch 依次出网(任一时刻同字段
 * 至多一笔在途),消除「旧写先发滞留、新写后发先到、旧写晚到覆盖新值」的并发在途
 * 乱序(review P1:服务端 patch-meta 是无版本条件的更新,到达序即写序;WS 级联链路
 * 对单发送方保序,同字段发出序 = 用户操作序,到达序就正确)。
 *
 * 分道依据(review P2:归档/删除不得被前面重命名的整轮重试拖住):被控端
 * patchSessionMetaInDb 是字段级 `UPDATE ... SET`,只写 patch 出现的字段——无交集
 * 字段的两笔写在被控端乱序执行也互不覆盖,并行是安全的;需要写序的只有同字段。
 *
 * 前一笔失败不阻断下一笔;排队期间同字段新笔已 begin,在途旧笔会在下一次重发前因
 * isLatest 屏障让位,新笔最多等一个退避间隔 + 一次在途请求。tail 登记与
 * LatestWriteGuard 同款每 key:field 常驻,页面生命周期内可忽略。
 */
export function createSessionWriteQueue(): SessionWriteQueue {
  const tails = new Map<string, Promise<unknown>>();
  return {
    enqueue<T>(key: string, fields: readonly string[], task: () => Promise<T>): Promise<T> {
      const slots = fields.map((field) => `${key} ${field}`);
      const prior = Promise.allSettled(slots.map((slot) => tails.get(slot) ?? Promise.resolve()));
      const next = prior.then(task);
      // 队尾只存吞掉结果/错误的影子,避免未消费的 rejection 链;结果仍由 next 交给调用方。
      const shadow = next.then(() => undefined, () => undefined);
      for (const slot of slots) tails.set(slot, shadow);
      return next;
    },
  };
}

export interface PendingWriteTracker {
  /** 登记一笔在途写(begin 时调用);返回幂等的 release,写 settle(成功/失败/让位)时调用。 */
  track(key: string, fields: readonly string[]): () => void;
  /**
   * 过滤掉 patch 中本机有在途写的字段。被控端 `sessions:patched` push 是无差别广播,
   * 同字段旧写的 push 回流会把本机更新的乐观意图滚回(review P2:pin RPC 在途时用户
   * unpin,pin 的 push 到达把乐观 unpin 冲掉);在途字段以本机 pending 写为准,push
   * 里这些字段丢弃,终态由本笔的对账/后续 push 收敛。
   *
   * localRow 传本地行当前值时,遮蔽留痕只记**差异遮蔽**:被控端先广播 push 再回
   * invoke 响应(patchSessionMetaInDb 先 broadcast 后 return),本笔自己的 echo push
   * 必然先于回包到达且值与本机乐观值相同——同值遮蔽零信息,不留痕,否则每次成功写
   * 都会误触发全量 reseed(review P2)。不传 localRow 时保守留痕(宁多一次 reseed)。
   */
  filterPatch<T extends Record<string, unknown>>(
    key: string,
    patch: T,
    localRow?: Record<string, unknown> | null,
  ): Partial<T>;
  /**
   * 查询并清除「fields 中任一字段在途期间曾有 push 被遮蔽」标记。被遮的可能是**其它
   * 控制端**的并发更新(review P1:手机重命名在途,桌面端改了同一标题):本机写成功
   * 时回包权威覆盖无需理会;本机写**失败回滚**时被遮的远端值就此丢失,调用方应据此
   * requestReseed 向被控端收敛。标记随 release 计数归零自动清除。
   */
  consumeMaskedPush(key: string, fields: readonly string[]): boolean;
  /**
   * 该 key 当前有在途写的字段清单(无则空数组)。供全量列表对账(setDeviceSessions)
   * 保护乐观意图:重连 / reseed 拉到的旧快照不得冲掉在途字段(review P1)。
   */
  pendingFields(key: string): string[];
  /**
   * 全量对账 overlay 的留痕入口(review P2):overlay 用本地乐观值藏起了权威快照值,
   * 与 push 遮蔽同样可能藏掉外部控制端的并发更新——快照值与本地值不同时记差异遮蔽
   * (同一 masked 集,由 consumeMaskedPush 消费触发 reseed);同值零信息不留痕。
   */
  noteMaskedValue(key: string, field: string, incoming: unknown, local: unknown): void;
}

/** 每 (key, field) 在途写计数器。track/release 配对;filterPatch 供 push 应用路径消费。 */
export function createPendingWriteTracker(): PendingWriteTracker {
  const counts = new Map<string, number>();
  const masked = new Set<string>();
  return {
    track(key, fields) {
      const slots = fields.map((field) => `${key} ${field}`);
      for (const slot of slots) counts.set(slot, (counts.get(slot) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        for (const slot of slots) {
          const next = (counts.get(slot) ?? 1) - 1;
          if (next <= 0) {
            counts.delete(slot);
            // 计数归零 = 该字段无在途写:清残留遮蔽标记,不污染下一笔写的失败判定
            //(计数>1 时保留——同字段另一笔在途,其结局仍需要这个信息)。
            masked.delete(slot);
          } else {
            counts.set(slot, next);
          }
        }
      };
    },
    filterPatch<T extends Record<string, unknown>>(
      key: string,
      patch: T,
      localRow?: Record<string, unknown> | null,
    ): Partial<T> {
      const out: Record<string, unknown> = {};
      for (const [field, value] of Object.entries(patch)) {
        const slot = `${key} ${field}`;
        if (counts.has(slot)) {
          // 差异遮蔽才留痕:echo push(值与本机乐观值相同)零信息;元数据字段均为
          // 标量(string|null),=== 即可。
          if (!localRow || value !== localRow[field]) masked.add(slot);
        } else {
          out[field] = value;
        }
      }
      return out as Partial<T>;
    },
    consumeMaskedPush(key, fields) {
      let hit = false;
      for (const field of fields) {
        const slot = `${key} ${field}`;
        if (masked.delete(slot)) hit = true;
      }
      return hit;
    },
    pendingFields(key) {
      const prefix = `${key} `;
      const fields: string[] = [];
      for (const slot of counts.keys()) {
        if (slot.startsWith(prefix)) fields.push(slot.slice(prefix.length));
      }
      return fields;
    },
    noteMaskedValue(key, field, incoming, local) {
      if (incoming !== local) masked.add(`${key} ${field}`);
    },
  };
}

/**
 * patch-meta 可写的全部元数据字段(与被控端 REMOTE_EDITABLE_META 同集)。
 * 消费方:writeGuardFields 的移行写(delete/archive)全字段取代。
 */
export const SESSION_META_FIELDS = ['status', 'title', 'pinnedAt'] as const;

/**
 * 写序登记字段:delete / archive 都是**移行**写——行从列表消失后,同会话 pending 的
 * 重命名/置顶既失去 UI 载体(乐观值随行消失,放弃无幻影代价),继续重试还会在行
 * 消失后冒出「重命名失败」弹窗或滞后更新已归档会话(review P2 两轮)——取代全部
 * 元数据字段的写序让它们立即让位;restore(不移行)与其余动作按 patch 自身字段
 * 登记(无交集写互不取代)。
 */
export function writeGuardFields(patch: { status?: string | null; [key: string]: unknown }): string[] {
  if (patch.status === 'deleted' || patch.status === 'archived') return [...SESSION_META_FIELDS];
  return Object.keys(patch);
}

/**
 * 带「过期即放弃」屏障的瞬时重试执行器:每次(重)发前先查 isLatest,本笔已被同
 * 会话后续写取代时返回 null 静默中止。isLatest 对账只能作废旧笔的**迟到回包**,
 * 挡不住旧笔在重试退避期间把旧 patch **重发到远端**覆盖新写的结果(review P1:
 * 置顶 A 退避中 → 取消置顶 B 成功 → 网络恢复后 A 重发旧 pinnedAt);屏障把这个
 * 窗口收敛回单次在途请求的固有水平。null = 已让位:调用方不对账、不回滚、不提示,
 * 本地与远端终态由取代它的新写负责收敛。
 *
 * send 会收到 assertStillLatest:过期即抛让位哨兵的同步断言。调用方应把它穿到
 * 尽可能贴近实际发送的位置(invoke 的 preSend——连接就绪后、真正出网前;review P2:
 * 重连等待最长 1.5s,期间被同字段新写取代的旧笔不该在重连后仍发出,否则其成功
 * push 会把更新的乐观状态短暂滚回)。
 */
export async function retryPatchWhileLatest<T>(
  isLatest: () => boolean,
  send: (assertStillLatest: () => void) => Promise<T>,
): Promise<T | null> {
  // 哨兵错误按引用识别;message 不含瞬时错误标记,withTransientRemoteRetry 不会重试它。
  const stale = new Error('stale session write superseded');
  const assertStillLatest = (): void => {
    if (!isLatest()) throw stale;
  };
  try {
    return await withTransientRemoteRetry(() => {
      assertStillLatest();
      return send(assertStillLatest);
    });
  } catch (err) {
    if (err === stale) return null;
    throw err;
  }
}

/** 右滑按钮:按当前置顶态给出动作与文案(置顶区行天然拿到「取消置顶」)。 */
export function pinToggleAction(
  pinnedAt: string | null | undefined,
): { action: 'pin' | 'unpin'; label: string } {
  return pinnedAt
    ? { action: 'unpin', label: i18n.t('session.menu.unpin') }
    : { action: 'pin', label: i18n.t('session.menu.pin') };
}

export interface SessionActionMenuItem {
  action: SessionSwipeAction;
  label: string;
  /** 删除项标红 + 触发系统 Alert 二次确认。 */
  destructive?: boolean;
}

/** 「选项」菜单模型:重命名 → 置顶切换 → 归档 → 删除(文案与会话详情页菜单保持一致)。 */
export function buildSessionActionMenu(
  pinnedAt: string | null | undefined,
): SessionActionMenuItem[] {
  const pinToggle = pinToggleAction(pinnedAt);
  return [
    { action: 'rename', label: i18n.t('session.menu.renameAction') },
    { action: pinToggle.action, label: pinToggle.label },
    { action: 'archive', label: i18n.t('session.menu.archive') },
    { action: 'delete', label: i18n.t('session.menu.deleteConversation'), destructive: true },
  ];
}

/** swipe 动作 → patchSessionMeta 补丁(rename 走重命名弹窗,不在此列)。 */
export function swipeActionPatch(
  action: Exclude<SessionSwipeAction, 'rename'>,
  now?: number,
): MobileSessionBulkPatch {
  return mobileSessionBulkPatch(action, now);
}
