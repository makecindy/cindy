/**
 * devKeychainName — 隔离 dev 实例的 safeStorage 钥匙串条目隔离(#871 候选 B 的收窄落地)。
 *
 * macOS 上 Electron `safeStorage` 的钥匙串条目名由 `app.name` 派生
 * (service = `<app.name> Safe Storage`),而 `app.name` 默认取 productName('Cindy'),
 * 三种身份(packaged cn / packaged global / 未打包 dev)共用同一条目:每种签名身份
 * 首次使用都会触发系统钥匙串授权弹窗,dev 的 stock Electron cdhash 也会进入正式
 * 条目的 ACL(#871)。
 *
 * 收窄语义 —— 只隔离「显式声明隔离意图(`--isolated` / `XDT_ISOLATED=1`)**且目录为
 * 纪元派生路径**(<userData>-dev2[-<名字>],由 devCliFlags.isolatedDirIsEpochDerived
 * 判定;调用方把两者的合取作为本函数的 isolated 入参)」的 dev 沙箱——显式指向其它
 * 目录的隔离启动不标记,防同一目录被「--isolated + 覆写」与「裸覆写 / 旧 checkout」
 * 等受支持启动形态以两种钥匙串身份轮流打开(review 反馈 P1 第十二轮):
 *  - 身份由 profile 根的标记文件承载,首启用「临时文件写完整内容 + hard link 独占
 *    落位」原子认领(可见即完整;无硬链接支持的文件系统回退 O_EXCL 独占创建,
 *    排他性不降级);此后每次启动按标记粘住,不看目录内容。
 *  - 标记读取三态:present / absent(仅 ENOENT)/ unreadable(其它 IO 错)。
 *    **不确定即拒绝启动**(review 反馈 P1 第七轮):标记暂不可读、内容为空或不可
 *    识别时,沙箱可能已有按 CindyDev 主密钥加密的存量密文,静默回退默认身份会用
 *    错钥匙覆盖它们——dev-only 场景响亮失败并给出处置指引,优于任何猜测。
 *  - 无标记(确证 ENOENT)且 profile 已有真实数据(排除标记自身产物)→ 复查标记
 *    后判旧沙箱,永久保持默认条目名(存量密文绑定 `Cindy Safe Storage`)。
 *  - 无标记且 profile 为空 = 全新沙箱 → 原子认领;输掉竞态以胜者完整标记为准;
 *    认领写失败(非 EEXIST 的瞬时错)同样 abort——「保持默认名」只在单进程下自洽,
 *    并发场景另一进程可能恰好认领成功,同一 profile 会跑在两个身份上(review 反馈
 *    P1 第八轮)。
 *  - 覆写目录的**非认领启动**(裸 `XDT_USER_DATA_DIR`,或 `--isolated` 指向非纪元
 *    目录)进入观察模式:绝不认领 CindyDev,但目录已带标记时依标记运行——裸覆写
 *    指向已按 CindyDev 认领的 `-dev2` 沙箱是受支持形态,若因缺隔离旗标就跳过标记、
 *    以默认身份打开,同一 profile 会被两种身份轮流打开互毁密文(review 反馈 P1
 *    第十四轮)。标记不可读/不可识别同样 abort。
 *  - 空 profile 的身份在**两种模式下都原子落定**:认领模式认领 CindyDev,观察模式
 *    认领默认身份(标记词表 = 两个身份名),输家依胜者标记。观察模式若对空 profile
 *    直接保持默认名而不落标记,与并发隔离启动的 CindyDev 认领无协调点,两个进程会
 *    对同一 profile 以两种身份写密文(review 反馈 P1 第十五轮)。
 *  - 共享 userData 的 dev(无目录覆写)、packaged cn/global 一律不改名也不读标记;
 *    packaged 改名属存量凭证迁移(#871 候选 A)。
 *
 * 调用方(main 入口)必须**先显式 pin 住 userData** 再 `app.setName()`,并在收到
 * abort 决策时终止启动。
 */

import { BRAND_IDENTITY } from '@cindy/maker-shared/brand-identity';

/**
 * 沙箱 profile 内的钥匙串身份标记文件名(userData 根下,纯文本存条目身份名;
 * 词表 = 'CindyDev' | 默认身份名 'Cindy',其它内容一律视为身份不确定)。
 */
export const KEYCHAIN_IDENTITY_MARKER_FILE = 'keychain-identity';

/** 该目录项是否属于身份标记机制自己的产物(最终标记 或 `<marker>.<pid>-<uuid>.tmp` 半成品)。 */
export function isKeychainIdentityMarkerArtifact(entryName: string): boolean {
  if (entryName === KEYCHAIN_IDENTITY_MARKER_FILE) return true;
  return (
    entryName.startsWith(`${KEYCHAIN_IDENTITY_MARKER_FILE}.`) && entryName.endsWith('.tmp')
  );
}

/**
 * 标记读取三态:absent 仅代表确证的 ENOENT;其它 IO 错一律 unreadable。
 * present.value 必须是**原始文件内容**(不 trim):完整性(终止换行)由 resolver
 * 判定,读侧提前 trim 会把 O_EXCL 回退中写到一半的合法身份前缀洗成完整标记。
 */
export type KeychainMarkerRead =
  | { kind: 'present'; value: string }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

/** 标记文件与 profile 的 IO 面(注入以便单测竞态时序)。 */
export interface KeychainIdentityIo {
  readMarker(): KeychainMarkerRead;
  /**
   * 原子独占发布**完整且持久**的标记:临时文件写完 + fsync → hard link 独占落位
   * → fsync 父目录。「写完」必须校验写满——writeSync 允许短写,截断标记可能恰好
   * 是词表另一合法身份("CindyDev\n" 截 5 字节 = "Cindy"),发布它会让两次启动
   * 各选一个身份(review 反馈 P1 第十七轮);短写按写失败处理。
   * 目标文件系统不支持硬链接时(exFAT / 部分 SMB,link 报非
   * EEXIST 错)回退 O_EXCL 独占创建:排他性(防双身份的协调点)仍由文件系统原子
   * 原语保证,仅该回退路径牺牲「可见即完整」——读侧以**终止换行**为完整判据
   * (resolver 只接受 `<name>\n`,合法身份的无换行前缀按不可识别 abort),半成品
   * 标记落在 fail-safe 方向(review 反馈 P1 第十六/十八轮)。回退路径的撤销只
   * 允许在内容不完整时做:内容写满后并发读者可能已按完整标记接受,fsync 失败再
   * 撤销会造成「读者已用身份 + 标记消失」的旧沙箱误判——此时留完整标记、本进程
   * 按 'error' 拒启;内容持久性由读侧接受前的自 fsync 兜底(review 反馈 P1
   * 第二十三轮,实现见 index.ts 的 readMarker / claimMarker)。
   * **'claimed' 与 'exists' 两种返回前都必须完成目录持久化**——
   * 输家不 flush 就接受对方标记,断电可能保住输家写的密文、丢掉标记(review 反馈
   * P1 第十二轮);flush 失败按 'error'(仅 Windows 因平台性打不开目录 fd 例外为
   * best-effort)。标记一旦可见内容即完整,不得出现零长度文件;
   * fsync 保证标记先于后续 profile/凭证写入持久化——否则断电后「标记消失 +
   * profile 非空」会被判成旧沙箱、用错钥匙覆盖既有密文(review 反馈 P1 第九轮)。
   * 已存在 → 'exists',其它失败 → 'error'。
   */
  claimMarker(name: string): 'claimed' | 'exists' | 'error';
  /**
   * profile 目录是否已有**真实数据**(读失败按 true,方向安全)。实现必须用
   * isKeychainIdentityMarkerArtifact 排除标记文件与其 .tmp 半成品。
   */
  profileHasData(): boolean;
  /**
   * fsync profile 目录,把已观察到的标记目录项持久化。**任何**对观察到标记的接受
   * (初读命中 / 有数据复查命中 / 认领竞态后读到胜者标记)都必须先经它确认——对手
   * link 后可能尚未完成自己的 fsync,不 flush 就接受,断电会保住本进程随后写的密文
   * 却丢掉标记(review 反馈 P1 第十三轮)。失败返回 false(仅 Windows 因平台性打不
   * 开目录 fd 可返回 true 作 best-effort)。
   */
  flushProfileDir(): boolean;
}

export type DevKeychainDecision =
  | { kind: 'rename'; appName: string }
  | { kind: 'keep-default' }
  /** 身份不确定(标记不可读/内容不可识别):必须终止启动,不得用任一身份写入。 */
  | { kind: 'abort'; reason: string };

function interpretMarker(
  read: KeychainMarkerRead,
  devName: string,
  defaultName: string,
  io: KeychainIdentityIo,
): DevKeychainDecision | null {
  if (read.kind === 'unreadable') {
    return { kind: 'abort', reason: '身份标记读取失败(非 ENOENT)' };
  }
  if (read.kind === 'present') {
    // 完整性判定(review 反馈 P1 第十八轮):value 是**原始文件内容**,必须带终止
    // 换行才算写完 —— 写侧格式恒为 `<name>\n`。O_EXCL 回退路径在最终路径上增量写,
    // "CindyDev\n" 的前 5 字节恰是词表另一合法身份 "Cindy":只 trim 的话,并发读端
    // 会把写到一半的前缀当完整标记接受,一个 profile 分裂到两个钥匙串身份。无终止
    // 换行(半成品/损坏)落入下方「不可识别 → abort」的 fail-safe。
    // 剥离规则严格到**恰好一个**末尾换行(兼容 \r\n,照顾 Windows 编辑器的手工修复):
    // "CindyDev\n\n" / " Cindy \n" 这类多余空白若被 trim 洗成合法身份,损坏/手改
    // 内容的判定就不再确定(review 反馈第二十轮)——格式不精确一律按不可识别 abort。
    const complete = read.value.endsWith('\n')
      ? read.value.slice(0, -1).replace(/\r$/, '')
      : null;
    if (complete === devName || complete === defaultName) {
      // 接受观察到的标记前先把它的目录项持久化:写入者可能尚未完成自己的 fsync,
      // 不 flush 就以该身份写密文,断电后会出现「密文在、标记丢」(review 反馈
      // P1 第十三轮)。flush 失败按身份不确定 → abort。默认身份标记同一规则——
      // 不为它单独论证「丢了也收敛」,统一不变量更可靠。
      if (!io.flushProfileDir()) {
        return { kind: 'abort', reason: '身份标记持久化确认失败' };
      }
      return complete === devName
        ? { kind: 'rename', appName: devName }
        : { kind: 'keep-default' };
    }
    // 空串或不可识别的值:身份不确定。可能是损坏的标记——静默回退默认身份
    // 会用错钥匙覆盖既有密文(review 反馈 P1 第七轮),拒绝启动。
    // 不回显原文:裸覆写目录里可能存在同名的**外来文件**,内容不受词表约束,
    // 拼进 reason 会经 stderr/日志泄露敏感材料或塞进巨量数据(review 反馈 P2
    // 第二十七轮)。只报可排查的元数据。
    return {
      kind: 'abort',
      reason:
        `身份标记内容不可识别(${Buffer.byteLength(read.value, 'utf8')} 字节,` +
        `${read.value.endsWith('\n') ? '有' : '无'}终止换行)`,
    };
  }
  return null; // absent → 由调用侧继续判定。
}

export function resolveDevKeychainDecision(input: {
  isPackaged: boolean;
  /**
   * 是否走认领路径 = 显式隔离意图(--isolated / XDT_ISOLATED)**且**目录为纪元
   * 派生路径的合取(调用方传 devFlags.isolated && devFlags.isolatedDirIsEpochDerived)。
   */
  isolated: boolean;
  /** 是否存在目录覆写(XDT_USER_DATA_DIR / --isolated 派生)。false 时不做任何 IO。 */
  hasDirOverride: boolean;
  io: KeychainIdentityIo;
}): DevKeychainDecision {
  if (input.isPackaged || !input.hasDirOverride) return { kind: 'keep-default' };
  const devName = BRAND_IDENTITY.executableNameByRegion.dev;
  const defaultName = BRAND_IDENTITY.executableName;
  // 两种模式共用同一状态机,唯一差别是空 profile 时认领哪个身份:认领模式
  // (--isolated + 纪元派生目录)认领 CindyDev,观察模式(裸覆写等非认领形态)
  // 认领默认身份。观察模式对空 profile 若直接 keep-default 而不落标记,与并发
  // 隔离启动的 CindyDev 认领之间没有任何协调点,两个进程会对同一 profile 以两种
  // 身份写密文(review 反馈 P1 第十五轮)——空 profile 的身份必须原子落定,
  // 输家一律依胜者标记。
  const claimName = input.isolated ? devName : defaultName;
  const decisionFor = (name: string): DevKeychainDecision =>
    name === devName ? { kind: 'rename', appName: devName } : { kind: 'keep-default' };

  const first = interpretMarker(input.io.readMarker(), devName, defaultName, input.io);
  if (first !== null) return first;

  if (input.io.profileHasData()) {
    // 无标记但有数据:复查标记,关掉「对手在首读后发布标记+数据」的并发窗口;
    // 复查确证 absent 才是真旧沙箱/外来目录,永久保持默认名且不落标记
    // (存量密文绑定默认条目,零迁移只对新沙箱成立)。
    const recheck = interpretMarker(input.io.readMarker(), devName, defaultName, input.io);
    return recheck ?? { kind: 'keep-default' };
  }

  // 空 profile:原子认领本模式的身份。
  const claim = input.io.claimMarker(claimName);
  if (claim === 'claimed') return decisionFor(claimName);
  if (claim === 'exists') {
    const winner = interpretMarker(input.io.readMarker(), devName, defaultName, input.io);
    // EEXIST 后复读确证 absent(对手发布后又消失)同样属身份不确定,拒绝启动。
    return winner ?? { kind: 'abort', reason: '认领竞态后身份标记消失' };
  }
  // 认领写失败(非 EEXIST 的瞬时错):身份不确定——并发对手可能恰好认领成功,
  // 「保持默认名」会让同一 profile 跑在两个身份上,统一按 abort 处理。
  return { kind: 'abort', reason: '身份标记认领失败(非竞态)' };
}
