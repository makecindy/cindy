import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import {
  loadDeviceLinkExistingProjects,
  removeDeviceLinkExistingProject,
  type ExistingRemoteProject,
} from '@/components/new-chat/remoteExistingProjects';

/**
 * useDeviceLinkProjects —— 单台被控设备上的最近项目(创建页项目 picker 的远程数据源)。
 *
 * 为什么是「单台」而不是把所有设备的项目摊在一个列表里(#807 方案 B):设备是一级维度,
 * 由设备 pill 选定;项目 picker 只在**当前设备**的语境里列「对话 + 该设备的项目」,与 mobile
 * 的工作区面板同构。好处是列表长度恒定(不随设备数膨胀)、「对话」只出现一次、当前设备始终显式。
 *
 * 数据源是被控端的 recent_workdirs(与被控端本地 folder picker 同源),不是会话列表 ——
 * 会话归档 / 删除后这张表仍然保留,所以「有目录但当前没有活跃会话」的项目照样列得出来
 * (issue #807 里用户明确抱怨过空项目看不见)。
 */
/**
 * 被控端 recent_workdirs 行 → picker 选项。抽成纯函数便于单测(key 唯一性、missing 透传、
 * remoteDevice 归属这三条是行为契约,不该只靠 grep 接线)。
 */
export function toDeviceProjectOptions(
  deviceId: string,
  deviceName: string | null,
  rows: readonly ExistingRemoteProject[],
): FolderPickerOption[] {
  return rows.map((row) => ({
    // key 带 deviceId:同名项目在不同设备上并存时 React 不会复用错行。
    key: `device-link:${deviceId}:${row.path}`,
    path: row.path,
    name: row.name,
    description: row.path,
    missing: row.exists === false,
    remoteDevice: { deviceId, deviceName: deviceName ?? deviceId },
  }));
}

/** 复用的空集合,免得每次取数都新建一个。 */
const EMPTY_PATHS: ReadonlySet<string> = new Set<string>();

export type DeviceLinkProjectsStatus = 'idle' | 'loading' | 'ready' | 'error';

export function useDeviceLinkProjects(
  deviceId: string | null,
  deviceName: string | null,
  enabled: boolean,
): {
  projects: FolderPickerOption[];
  loading: boolean;
  status: DeviceLinkProjectsStatus;
  error: string | null;
  retry: () => void;
  removeProject: (option: FolderPickerOption) => Promise<void>;
} {
  /**
   * 行**连同它属于哪台设备**一起存(Greptile review)。只存 rows 会留下一个结构性漏洞:
   * `deviceId` 变成 B 的那一帧先于清空 rows 的 effect 渲染(passive effect 在 paint 之后才跑),
   * 于是 projects memo 会把 A 的路径包成「属于 B」的可点击选项 —— 用户在那一帧点中,A 的路径就
   * 写进了 B 的草稿。把归属绑进状态后,「A 的行被标成 B」在类型与数据上都不可能出现,不再依赖
   * effect 与 render 的先后顺序(比改用 useLayoutEffect 把窗口缩小更彻底)。
   */
  const [loaded, setLoaded] = useState<{
    deviceId: string | null;
    rows: ExistingRemoteProject[];
  }>({ deviceId: null, rows: [] });
  const [requestState, setRequestState] = useState<{
    deviceId: string | null;
    status: DeviceLinkProjectsStatus;
    error: string | null;
  }>({ deviceId: null, status: 'idle', error: null });
  const [retryNonce, setRetryNonce] = useState(0);
  /**
   * loaded 的**同步**镜像。setState 的 updater 只在 React 处理这次更新时才跑,而删除失败后的恢复
   * 要在两次 await 之间就拿到「被移除的是哪一行、它原来在第几位」—— 从 updater 的副作用里取值会
   * 读到 undefined(Copilot review),于是 `if (!restored) return` 把恢复整个跳过,幻影删除
   * (本地看着删了、对端其实还在)又回来了。
   *
   * 所有写入都经 commitRows,镜像与状态同步推进,这条路径不再依赖 React 的调度时机;
   * 顺带让并发删除各自读到「前一次删除之后」的列表,插回位置也不会错位。
   */
  const loadedRef = useRef<{ deviceId: string | null; rows: ExistingRemoteProject[] }>({
    deviceId: null,
    rows: [],
  });
  /** 写行必须同时申明归属设备 —— 没有「只改 rows 不改归属」这种调用形态。 */
  const commitRows = useCallback((ownerDeviceId: string | null, next: ExistingRemoteProject[]) => {
    loadedRef.current = { deviceId: ownerDeviceId, rows: next };
    setLoaded(loadedRef.current);
  }, []);
  /**
   * **取数**序号,只由取数 effect 自增。切设备 / 重新打开 picker 会并发多个取数,只认最后一次的
   * 结果 —— 否则慢的旧请求回来会把新设备的列表覆盖成上一台的项目(看起来像「项目跑到别的机器上」)。
   *
   * ⚠️ 删除路径**不得**碰它(Greptile review)。它以前也被删除路径自增来「让在途取数失效」,
   * 而删除失败后的兜底回读是异步的:它的自增可能落在用户已经切到设备 B、B 的取数已在飞之后 ——
   * 于是 B 的结果被判成过期而丢弃,`setLoading(false)` 也跟着不执行,picker 就永久停在 loading
   * 且一个项目都没有,直到关掉重开。取数与删除是两件事,不能共用一个版本号。
   *
   * 「在途取数不能把刚乐观移除的行贴回来」改由下面的 pendingRemovalsRef 过滤解决 —— 那本来就是
   * 删除失败回读用的同一套机制,取数复用它即可,不需要作废任何请求。
   */
  const requestIdRef = useRef(0);
  /** 当前 hook 实例正在看哪台设备。删除失败后的权威回读用它做 gate(与取数序号无关)。 */
  const currentDeviceIdRef = useRef<string | null>(null);
  /**
   * 正在进行中的乐观删除,**按设备分层**(deviceId → path 集合)。删除失败后的权威回读必须减去
   * 同设备上其它仍在飞的删除 —— 否则 A 的回读会把已被乐观移除、但删除还没回来的 B 复活;
   * 等 B 真的成功时它的成功路径不再更新状态,于是 B 会一直显示到重开 picker 为止。
   *
   * 分层而不是用裸 path 集合:否则设备 A 上未结束的 `/x` 会被当成设备 B 的待删除项,
   * 如果 B 上恰好也有同名 `/x`,B 的权威列表会把它错误过滤掉、让那个项目从 B 的选择器里消失。
   */
  const pendingRemovalsRef = useRef<Map<string, Set<string>>>(new Map());
  /**
   * 每次**向对端发起**取数(effect 取数 / 删除失败的兜底回读)时自增。用来回答「这份快照是什么
   * 时候取的」—— 墓碑的退休判据要用它,见 tombstonesRef。与 requestIdRef 不同:那个只管「哪次
   * effect 取数是最新的」,这个管「快照的新鲜度」,两者语义不同,不能合并。
   */
  const fetchSeqRef = useRef(0);
  /**
   * 删除**已在对端成功**的路径 → 墓碑,按设备分层(deviceId → path → 成功时的 fetchSeq)。
   *
   * 为什么需要(Greptile review P1):A、B 两个删除并发,B 失败后的兜底回读可能取到「A 还在」的
   * 快照;等它落库时 A 其实已经删成了。A 的成功路径只清 pending 标记、不再更新列表,于是那份旧
   * 快照把 A 显示回来,而且**再没有任何东西会把它移除** —— 一个对端已经不存在的项目一直挂在选择器
   * 里,直到重开 picker。乐观删除的 pending 集合挡不住它:A 成功后就从 pending 里出去了。
   *
   * 「墓碑什么时候可以丢」这个生命周期问题由 fetchSeq 回答,而不是靠计时器或永久累积:
   * 任何**发起时刻晚于**该成功的取数,其快照已经反映了这次删除,一旦落库这块墓碑就退休。
   * 所以墓碑最多活到下一次取数返回,不会无限增长,也不需要人工清理。
   */
  const tombstonesRef = useRef<Map<string, Map<string, number>>>(new Map());
  /**
   * 每台设备**已落库**快照的发起序号。用来丢弃过期快照,见 applySnapshot。
   *
   * 不需要在切设备时清理:fetchSeqRef 全局单调递增,切回旧设备时新取数的序号必然更大。
   */
  const appliedSeqRef = useRef<Map<string, number>>(new Map());
  /**
   * 每台设备**最后一次已落库快照的原始路径集合**(未经 pending / 墓碑过滤)。
   *
   * 只服务一件事:判断「更新的权威快照有没有**否证**过某一行」。必须存原始集合而不是落库后的行 ——
   * 落库时会扣掉仍在飞的乐观删除,于是「落库后的行里没有它」有两种截然不同的原因:
   *   ① 对端确实没有这个项目(权威否证);
   *   ② 对端有,只是被 pending 过滤掉了(它的删除还在飞)。
   * 只有 ① 才能阻止按行恢复;拿落库后的行去判会把 ② 也一并挡掉,直接破坏「并发失败删除全部收敛」。
   */
  const lastSnapshotPathsRef = useRef<Map<string, ReadonlySet<string>>>(new Map());
  /**
   * 落库一份对端快照:统一扣掉「仍在飞的乐观删除」与「尚未被更新快照证实的墓碑」,并顺手让
   * 已被证实的墓碑退休。两个取数点(effect / 回读)都必须经这里,否则过滤规则会再次分叉。
   *
   * **返回是否真的落库了**(Codex review 第 31 轮 P1):更旧的快照必须丢弃 —— 设备 gate 只排除
   * 「已切走」,不给同一台设备的多个响应排序。真实序列:删除失败发起回读(seq=5)→ 用户关掉再
   * 打开 picker,新 effect 取数(seq=6)先回并落库 → 若对端在这两次快照之间新增/重开了一个项目,
   * 那个新项目只存在于 seq=6 的快照里 → 旧回读(seq=5)后到并整片覆盖,新项目就从选择器里消失,
   * 直到下一次刷新。tombstonesRef 挡不住它:墓碑只针对**已成功删除**的路径。
   */
  const applySnapshot = useCallback(
    (
      ownerDeviceId: string,
      issueSeq: number,
      list: readonly ExistingRemoteProject[],
      hiddenPaths: ReadonlySet<string>,
    ): boolean => {
      // 序号检查必须在最前面:被丢弃的快照不作数,不能让它顺带把墓碑退休掉。
      if (issueSeq < (appliedSeqRef.current.get(ownerDeviceId) ?? 0)) return false;
      appliedSeqRef.current.set(ownerDeviceId, issueSeq);
      // 原始路径集合(过滤前)—— 按行恢复要靠它判断这一行是否已被权威否证,见 lastSnapshotPathsRef。
      lastSnapshotPathsRef.current.set(ownerDeviceId, new Set(list.map((r) => r.path)));
      const tomb = tombstonesRef.current.get(ownerDeviceId);
      if (tomb) {
        // 这份快照发起于墓碑之后 → 它已经反映了那次删除,墓碑可以退休。
        for (const [path, seq] of [...tomb]) if (seq < issueSeq) tomb.delete(path);
        if (tomb.size === 0) tombstonesRef.current.delete(ownerDeviceId);
      }
      const stillTombstoned = tombstonesRef.current.get(ownerDeviceId);
      const drop = (path: string) => hiddenPaths.has(path) || stillTombstoned?.has(path) === true;
      commitRows(
        ownerDeviceId,
        list.some((row) => drop(row.path)) ? list.filter((row) => !drop(row.path)) : [...list],
      );
      return true;
    },
    [commitRows],
  );

  useEffect(() => {
    currentDeviceIdRef.current = deviceId;
    // 本机(deviceId=null)不走隧道;picker 没打开时不取数,避免常驻首页时白拉。
    if (!enabled || !deviceId) {
      commitRows(deviceId, []);
      setRequestState({ deviceId, status: 'idle', error: null });
      return;
    }
    let cancelled = false;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const issueSeq = ++fetchSeqRef.current;
    // 立刻清空上一台设备的行(#807 review):projects memo 依赖 [deviceId, deviceName, rows],
    // deviceId 已经变成 B 而 rows 还是 A 的,于是加载窗口里会渲染出「标着 B 的 A 的项目」——
    // 用户此时选中就把 A 的路径发给 B,撞 path guard 或打开 B 上同名的无关目录。
    commitRows(deviceId, []);
    setRequestState({ deviceId, status: 'loading', error: null });
    void loadDeviceLinkExistingProjects(deviceId)
      .then((list) => {
        if (cancelled || requestIdRef.current !== requestId) return;
        // 减去这台设备上仍在飞的乐观删除:取数可能在某次删除进行中回来,原样落库会把用户刚
        // 点掉的行贴回去。以前靠删除路径自增 requestIdRef 作废取数来避免,但那个共享版本号会
        // 顺带把**别的设备**的取数误判成过期(见 requestIdRef 的说明),所以改成在这里过滤。
        // 墓碑(已成功删除但快照可能更旧)由 applySnapshot 一并扣掉。
        applySnapshot(
          deviceId,
          issueSeq,
          list,
          pendingRemovalsRef.current.get(deviceId) ?? EMPTY_PATHS,
        );
        setRequestState({ deviceId, status: 'ready', error: null });
      })
      .catch((error: unknown) => {
        // 被控端离线、超时或老版本没这个 channel 都是读取失败；UI 显示错误与重试，
        // 不得把它们当成对端权威返回的「没有项目」。
        if (cancelled || requestIdRef.current !== requestId) return;
        // **刻意不 commitRows([])**(Codex review 第 33 轮 P1)。这个 effect 开头已经把行设成了
        // 「(这台设备, 空)」，失败由 requestState 单独表达；再提交空行是冗余的，
        // 而且会踩掉一个真实窗口:删除失败的兜底回读**在 effect 开头那次清空之后**才 apply,
        // 于是「回读刚带回一份好数据」与「本次取数瞬时失败(隧道抖动 / 超时)」可以同时成立。
        // 无条件清空会把那份刚被证明存在的列表抹成「没有项目」,直到用户再成功重开一次才恢复。
        // 归属正确性不依赖这里:effect 开头的清空已经保证当前行属于这台设备。
        setRequestState({
          deviceId,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId, enabled, retryNonce]);

  const removeProject = useCallback(async (option: FolderPickerOption) => {
    const target = option.remoteDevice;
    if (!target) return;

    // 刻意**不动** requestIdRef(Greptile review):在途取数不会把刚乐观移除的行贴回来 ——
    // 它落库前会减去下面这个 pending 集合。作废取数反而会误伤别的设备的取数,见 requestIdRef。
    const devicePending = pendingRemovalsRef.current.get(target.deviceId) ?? new Set<string>();
    devicePending.add(option.path);
    pendingRemovalsRef.current.set(target.deviceId, devicePending);
    // 记下被移除的行与它原来的位置:两条恢复路径都要用(回读失败时按原序插回)。
    // 从同步镜像读,不从 setState 的 updater 副作用读 —— 见 loadedRef 的说明。
    // 归属不符就不动列表:那说明当前显示的已经是别的设备的行,乐观移除会改错列表。
    const before = loadedRef.current.deviceId === target.deviceId ? loadedRef.current.rows : [];
    const removedIndex = before.findIndex((row) => row.path === option.path);
    const removedRow = removedIndex >= 0 ? before[removedIndex] : undefined;
    if (removedIndex >= 0) {
      commitRows(target.deviceId, [
        ...before.slice(0, removedIndex),
        ...before.slice(removedIndex + 1),
      ]);
    }

    /**
     * 把乐观移除的那一行按原位插回。
     *
     * 「这次删除失败了,所以这一行该在」是一件**与快照版本无关的局部事实**,所以两种情况都用它:
     *   ① 权威回读本身也失败(拿不到任何真相);
     *   ② 回读拿到了快照,但它比已落库的更旧而被丢弃 —— 这一条是 seq gate 的代价:不补的话
     *      并发失败删除就不再收敛(先回的那份快照隐藏了仍在飞的自己,后回的自己又被丢弃,
     *      于是自己那一行永远回不来),而「并发失败删除必须各自收敛」是既有不变量。
     *
     * 刻意**不按取数版本号一刀切**:期间用户重开 picker / 切回本设备都会推进版本号,按它直接
     * gate 会把这次恢复跳过,那一行就一直从选择器里消失(而它在对端还在)。自带存在性检查,
     * 期间真有成功回读把它带回来了也不会插重。
     *
     * 但**必须尊重更新快照的否证**(Greptile review):上一轮为保住收敛性而在「回读被 seq gate
     * 拒绝」时也走这里,那条路径当时只查设备归属与存在性 —— 于是当对端其实已经没有这个项目了
     * (用户在对端删了 / 删除实际成功只是响应失败),更新的权威快照如实不含它,旧回读却仍能把它
     * 插回选择器;用户选中就撞 path guard,或打开对端同名但无关的目录。
     *
     * 判据用**原始**快照集合而不是落库后的行,见 lastSnapshotPathsRef —— 落库会扣掉仍在飞的
     * 乐观删除,拿它判会把「对端有、只是被 pending 过滤」也当成否证,直接废掉并发收敛。
     */
    const restoreRemovedRow = (readbackSeq?: number) => {
      const restored = removedRow;
      if (!restored) return;
      // 按当前设备 gate:若请求还在飞时用户已切到别的设备,把 A 的行插进 B 的 rows 会被
      // toDeviceProjectOptions 标成属于 B —— 选中它就把 A 的路径发给 B 了。这与「并发删除不能
      // 互相取消」不冲突:设备身份只排除「已切走」,不排除同设备内的并发。
      if (currentDeviceIdRef.current !== target.deviceId) return;
      if (loadedRef.current.deviceId !== target.deviceId) return;
      // 已有**更新**的权威快照,且它的原始列表里没有这一行 → 对端确实没有,不恢复。
      if (readbackSeq !== undefined) {
        const applied = appliedSeqRef.current.get(target.deviceId) ?? 0;
        const snapshotPaths = lastSnapshotPathsRef.current.get(target.deviceId);
        if (applied > readbackSeq && snapshotPaths && !snapshotPaths.has(restored.path)) return;
      }
      // 删除其实已在对端成功过(墓碑)→ 同样不恢复,那一行不该再出现。
      if (tombstonesRef.current.get(target.deviceId)?.has(restored.path)) return;
      const current = loadedRef.current.rows;
      if (current.some((row) => row.path === restored.path)) return;
      const at =
        removedIndex >= 0 && removedIndex <= current.length ? removedIndex : current.length;
      commitRows(target.deviceId, [...current.slice(0, at), restored, ...current.slice(at)]);
    };

    try {
      await removeDeviceLinkExistingProject(target.deviceId, option.path);
      // 删成了 → 立墓碑。此刻可能已有一次「A 还在」的旧回读在飞,它落库会把这一行显示回来,
      // 而成功路径本身不再更新列表(行早就被乐观移除了)—— 墓碑就是那道防线,见 tombstonesRef。
      const deviceTombstones =
        tombstonesRef.current.get(target.deviceId) ?? new Map<string, number>();
      deviceTombstones.set(option.path, fetchSeqRef.current);
      tombstonesRef.current.set(target.deviceId, deviceTombstones);
    } catch {
      // 老被控端可能没有 remove channel。回读一次收敛到被控端真相,
      // 而不是留下一个「本地看着删了、对端其实还在」的幻影删除。
      // 同样不动 requestIdRef:晚到的 effect 取数即使覆盖这次回读也无害 —— 两者都是被控端
      // 真相,且都会减去仍在飞的乐观删除,结果一致。作废它只会误伤新设备的取数。
      const readbackSeq = ++fetchSeqRef.current;
      try {
        const list = await loadDeviceLinkExistingProjects(target.deviceId);
        // gate 用**设备身份**:只要设备没切走,这份回读就是被控端真相,该应用。不用版本号 ——
        // 并发删除会互相把对方的回读判成过期,那一行既没在对端删成、又没被恢复,会一直消失。
        if (currentDeviceIdRef.current !== target.deviceId) return;
        // 只减**这台设备上**其它仍在飞的乐观删除;不含自己 —— 这次删除失败了,真相里有它就该
        // 显示回来。跨设备的 pending 不参与,否则同名路径会互相误伤。
        const othersPending = new Set(
          [...(pendingRemovalsRef.current.get(target.deviceId) ?? [])].filter(
            (path) => path !== option.path,
          ),
        );
        // 快照比已落库的更旧 → 被丢弃。此时仍要让自己那一行回来,否则并发失败删除不再收敛;
        // 但要带上 readbackSeq,好让恢复尊重「更新快照已否证这一行」的情形(见 restoreRemovedRow)。
        if (!applySnapshot(target.deviceId, readbackSeq, list, othersPending)) {
          restoreRemovedRow(readbackSeq);
        }
      } catch {
        // 回读也失败(对端离线 / 隧道断)。此时**必须把行放回去**:删除既没在对端生效,
        // 权威列表也拿不到,保留乐观移除等于让选择器藏着一个远端仍然存在的项目,而且不给
        // 任何提示 —— 用户只能靠重开 picker 才发现它还在。
        restoreRemovedRow();
      }
    } finally {
      const set = pendingRemovalsRef.current.get(target.deviceId);
      set?.delete(option.path);
      if (set && set.size === 0) pendingRemovalsRef.current.delete(target.deviceId);
    }
  }, []);

  /**
   * 归属必须相符才输出选项 —— 这是上面把 deviceId 绑进状态的唯一目的:切设备的那一帧
   * `loaded` 仍描述上一台,此时输出空列表,绝不把 A 的路径标成 B 的。
   */
  const projects = useMemo<FolderPickerOption[]>(
    () =>
      deviceId && loaded.deviceId === deviceId
        ? toDeviceProjectOptions(deviceId, deviceName, loaded.rows)
        : [],
    [deviceId, deviceName, loaded],
  );

  // 归属还没对上 / picker 刚打开、effect 尚未执行时仍算「加载中」:否则切设备或首次打开
  // 会闪一下「没有项目」的空态。状态与 deviceId 绑定，上一台的 error 也不会串到新设备。
  const status: DeviceLinkProjectsStatus =
    !enabled || !deviceId
      ? 'idle'
      : requestState.deviceId !== deviceId || requestState.status === 'idle'
        ? 'loading'
        : requestState.status;
  const error = status === 'error' ? requestState.error : null;
  const retry = useCallback(() => {
    if (!enabled || !deviceId) return;
    setRequestState({ deviceId, status: 'loading', error: null });
    setRetryNonce((value) => value + 1);
  }, [deviceId, enabled]);

  return {
    projects,
    loading: status === 'loading',
    status,
    error,
    retry,
    removeProject,
  };
}
