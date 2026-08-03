/**
 * Dev-only 启动参数解析。与 scripts/restart-desktop-remote.mjs 的 --passive /
 * --isolated 同义,供人类直接跑 `pnpm dev:desktop*` 时使用:desktop 的 dev 脚本
 * 以 `electron-forge start -- ` 收尾,pnpm 追加的参数经 forge 的 `--` 分隔符
 * 原样透传进 Electron 主进程 argv,由 index.ts 在 app ready 前调用本函数落地。
 * restart 脚本路径没有 argv,靠 XDT_ISOLATED=1(开关)+ XDT_ISOLATED_NAME(名字,
 * 可选)两个环境变量把隔离意图带进来——开关与名字分离,名字 "1" 也不会撞标记值。
 *
 * 隔离沙箱支持命名多开:`--isolated` 不带名字 = 默认沙箱(目录 <userData>-dev2、
 * 设备标识 dev-<指纹>);`--isolated=<名字>` = 独立命名沙箱(目录
 * <userData>-dev2-<名字>、设备标识 dev-<名字>-<指纹>),想开几个开几个,
 * 数据 / 登录态 / 设备身份互不干扰、也不碰正式版。
 *
 * 纯函数、零 electron 依赖 —— index.ts 注入 argv / env / 默认 userData 目录,
 * 便于单元测试。packaged 版本一律返回"无覆写",线上零影响。
 */
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

/** 字母大小写整体翻转(卷语义探测用):无字母的段翻转后与原串相同。 */
function flipAsciiCase(s: string): string {
  return s.replace(/[a-zA-Z]/g, (ch) =>
    ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase(),
  );
}

/**
 * 探测**已存在**目录所在卷是否大小写不敏感:把末段字母翻转大小写后 realpath
 * 仍指向同一真实路径 → 不敏感。末段无字母可翻转时上溯父目录(父必然也存在);
 * 到根仍无从探测 → 保守按大小写敏感(不折叠,见调用方注释的代价论证)。
 */
function volumeIsCaseInsensitive(existingDir: string): boolean {
  let dir = existingDir;
  for (;;) {
    const parent = dirname(dir);
    const atRoot = parent === dir;
    // 挂载点边界必须在**翻转探测之前**判:名字翻转后的解析发生在父目录(宿主卷)
    // 的查找语义里——挂载点名含字母时(如 /Volumes/CaseSensitive 的大小写敏感卷
    // 挂在不敏感宿主上),翻转命中测到的是宿主语义而非目标卷(review 反馈 P1 第
    // 三十一轮);名字无字母继续上溯则会整个越过挂载点(第三十轮)。两种形态统一
    // 处理:与父目录设备号不同(= 挂载点)即按无从探测返回,保守不折叠。
    if (!atRoot) {
      try {
        if (statSync(parent).dev !== statSync(dir).dev) return false;
      } catch {
        return false;
      }
    }
    const name = basename(dir);
    const flipped = flipAsciiCase(name);
    if (flipped !== name) {
      try {
        return realpathSync.native(join(parent, flipped)) === realpathSync.native(dir);
      } catch {
        return false;
      }
    }
    if (atRoot) return false;
    dir = parent;
  }
}

/**
 * 纪元判定的缺省路径规范化:优先 realpath 的文件系统真值——大小写不敏感卷
 * (macOS 默认 APFS / NTFS)上等价写法收敛到磁盘真实路径,大小写敏感卷上不同
 * 目录保持不同,两个方向都不靠猜平台语义(#912 review 第十九~二十二轮)。
 * 路径尚不存在(首启)时,walk 到最近**存在**的祖先:realpath 该祖先取磁盘真值,
 * 再用大小写翻转探测该卷语义——探明不敏感才折叠剩余段的大小写(首启的大小写
 * 变体写法据此仍命中纪元目录),探明敏感或无从探测则保留原大小写(把不同目录
 * 误判成同一纪元会让不认标记的旧 checkout 与新身份互写密文,方向必须保守)。
 */
function defaultCanonicalizePath(p: string): string {
  const resolved = resolve(p);
  try {
    const real = realpathSync.native(resolved);
    // 不敏感卷统一折叠为全小写:存在与不存在两分支必须产出**同一种规范形式**,
    // 否则并发首启在两次 canonicalize 之间创建目录时(TOCTOU),同一路径会被判
    // 不等——隔离启动误落观察模式抢注默认身份(review 反馈 P1 第二十六轮)。
    // 折叠只用于判等,不回写任何路径。
    return volumeIsCaseInsensitive(real) ? real.toLowerCase() : real;
  } catch {
    // 不存在:找最近存在的祖先,祖先真值 + 按祖先卷语义归一的剩余段。
  }
  let dir = resolved;
  const suffix: string[] = [];
  for (;;) {
    const parent = dirname(dir);
    suffix.unshift(basename(dir));
    if (parent === dir) return resolved;
    dir = parent;
    try {
      const ancestorReal = realpathSync.native(dir);
      const rest = suffix.join(sep);
      // 卷语义按 ancestorReal(realpath 后的真实位置)探测,不能用词法路径 dir:
      // 祖先是跨卷符号链接时,剩余段实际创建在链接目标卷上,探链接所在卷会在
      // "不敏感卷链到敏感卷"时误折叠,把两个真实不同的目录判成同一纪元
      // (review 反馈 P1 第二十四轮)。不敏感卷折叠**整条路径**(含祖先真值),
      // 与上方存在分支的全小写形式保持一致(TOCTOU 稳定,第二十六轮)。
      const joined = join(ancestorReal, rest);
      return volumeIsCaseInsensitive(ancestorReal) ? joined.toLowerCase() : joined;
    } catch {
      // 该祖先也不存在,继续上溯。
    }
  }
}

/**
 * 沙箱名字白名单:字母数字下划线连字符、≤32。同时约束两件事——
 * (a) 目录名跨平台安全;(b) 设备标识总长可控(server 端 Slack 设备注册的
 * deviceId 白名单是 /^[A-Za-z0-9_-]{1,64}$/,名字并入 deviceId 后不能超)。
 */
const ISOLATION_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

export interface DevCliFlagsInput {
  argv: readonly string[];
  isPackaged: boolean;
  /** 已显式设置的 XDT_USER_DATA_DIR;非空时优先于隔离模式的默认沙箱目录。 */
  envUserDataDir: string | undefined;
  /**
   * 纪元判定用的路径规范化钩子(注入以便单测模拟不同卷语义);缺省实现走
   * fs.realpathSync.native(文件系统真值:大小写不敏感卷上返回磁盘真实大小写,
   * 敏感卷上不同目录得到不同规范路径),路径不存在(首启)时按最近存在祖先的
   * 卷语义探测决定是否折叠剩余段大小写,无从探测则保留原大小写(保守方向)。
   */
  canonicalizePath?: (p: string) => string;
  /** app.getPath('userData') 的默认值;隔离模式在其后缀 '-dev2[-<名字>]' 生成沙箱目录。 */
  defaultUserDataDir: string;
  /**
   * XDT_ISOLATED 环境变量:严格 '1' = 隔离开关开,其它任何值(含 '0'/'false'/名字)
   * 一律视为关。名字**不**挤在这个变量里——否则名叫 "1" 的沙箱会和开关标记值撞车
   * (数据目录是命名的、deviceId 却派生成默认的,把互踢问题带回来,codex review P2)。
   */
  envIsolated: string | undefined;
  /** XDT_ISOLATED_NAME 环境变量:命名沙箱的名字(restart 脚本路径专用,与开关分离)。 */
  envIsolationName: string | undefined;
  /**
   * XDT_USER_DATA_DIR_EPOCH 环境变量:严格 '1' = 显式 XDT_USER_DATA_DIR 由 restart
   * 脚本按 -dev2 纪元派生(可信纪元信号)。旧 checkout 与人肉覆写都不会携带——
   * 显式覆写没有该信号时即使路径与纪元派生相同也不认领 CindyDev,防旧代码以
   * 同一显式路径按默认身份打开造成双身份互写(#912 review P1 第三十二轮)。
   */
  envUserDataDirEpoch: string | undefined;
  /** 已显式设置的 XDT_DEVICE_ID_OVERRIDE;非空时隔离模式不再派生独立设备标识。 */
  envDeviceIdOverride: string | undefined;
  /** XDT_SCHEDULER_PASSIVE 环境变量:严格 '1' = 被动模式(restart 脚本路径)。 */
  envSchedulerPassive: string | undefined;
  /** XDT_ENDPOINTS_CDN 环境变量:严格 '1' = dev 也走完整 CDN 清单拉取(restart 脚本路径)。 */
  envEndpointsCdn: string | undefined;
}

export interface DevCliFlags {
  /** --passive:本实例定时任务不自动触发(scheduler-host 读 XDT_SCHEDULER_PASSIVE)。 */
  schedulerPassive: boolean;
  /** 是否由 --isolated / XDT_ISOLATED 明确进入独立 userData 沙箱。 */
  isolated: boolean;
  /**
   * 生效的 userData 覆写目录;null = 不覆写。来源优先级:
   * 显式 XDT_USER_DATA_DIR > 隔离模式默认沙箱目录(<userData>-dev2[-<名字>])> 不覆写。
   */
  userDataDirOverride: string | null;
  /**
   * 生效目录是否等于纪元派生路径(<userData>-dev2[-<名字>];含 restart 脚本经 env
   * 传入同一路径的标准流程)。CindyDev 钥匙串身份只允许落在纪元目录上——显式指向
   * 其它目录的隔离启动不标记,防同一目录被多种启动形态以两种身份打开。
   */
  isolatedDirIsEpochDerived: boolean;
  /**
   * 隔离模式且未显式给 XDT_DEVICE_ID_OVERRIDE 时为 true:调用方应派生独立
   * deviceId(dev-[<名字>-]<机器指纹>)。为什么必须派生:服务端 refresh token 按
   * (user, device) 一对一存,沙箱实例若沿用物理机指纹登录,会覆盖正式版的
   * 续期凭证 → 正式版下次续期时被登出(同机互踢)。
   */
  needsIsolatedDeviceId: boolean;
  /** 命名沙箱的名字;默认沙箱 / 未隔离时为 null。 */
  isolationName: string | null;
  /**
   * --isolated=<名字> 的名字不合法(字符集 / 长度)时原样带出,调用方应警告。
   * 此时按**默认沙箱**处理(仍隔离——回落到不隔离会直接混进正式版数据,更危险)。
   */
  invalidIsolationName: string | null;
  /**
   * --endpoints-cdn / XDT_ENDPOINTS_CDN=1:dev 下不读本地 config/endpoint.json,
   * 走与 packaged 完全相同的 CDN 阻断拉取链路(测线上清单用)。packaged 恒 false
   * (本来就走 CDN,该标志无意义)。
   */
  endpointsCdn: boolean;
}

/**
 * 是否获取 Electron single-instance lock。
 *
 * 正常 dev 与 packaged 各自保持单实例（锁作用域见
 * `resolveSingleInstanceLockUserDataDir`，dev 与 packaged 分域、互不阻塞），
 * 确保同 flavor 的 deep link 能交给已运行窗口；`--passive` 是明确的共享数据
 * 多开契约，所有 passive dev 都跳过获取。packaged 永远锁定，不能被环境变量
 * 误切成多实例。
 */
export function shouldRequestSingleInstanceLock(input: {
  isPackaged: boolean;
  schedulerPassive: boolean;
}): boolean {
  return input.isPackaged || !input.schedulerPassive;
}

/**
 * single-instance lock 的作用域目录（Electron 锁按调用时的 userData 路径生成）。
 *
 * packaged 用真实 userData —— release 之间单实例，双击第二份安装包会聚焦已运行
 * 窗口。dev 用 `<userData>/dev-single-instance-lock` 子目录 —— dev 之间仍单实例
 * （深链 second-instance redirect 保持有效），但**不再与共库的正式版互斥**：
 * dev + release 共享 userData 双开是明确支持的工作流（2026-07-19 dev 改为与
 * packaged 抢同一把锁曾误伤该工作流，2026-07-20 按 flavor 分域恢复）。跨实例
 * 并发由 SQLite WAL + busy_timeout、scheduler DB 级原子认领、auth
 * replacement-retry 等既有仲裁收敛，与 `--passive` 共库多开走的是同一套机制。
 * `--isolated` 沙箱的 userData 本身独立，锁子目录随之独立，语义不变。
 */
export function resolveSingleInstanceLockUserDataDir(input: {
  isPackaged: boolean;
  userDataDir: string;
}): string {
  return input.isPackaged
    ? input.userDataDir
    : join(input.userDataDir, 'dev-single-instance-lock');
}

/**
 * passive 只有在共享 userData 时才需要禁止 migration。
 *
 * 显式 isolated 沙箱没有其它实例替它初始化数据库，仍按正常启动路径迁移；packaged
 * 不接受任何 dev-only passive 语义。调用方会把这个纯判定同步成内部 env，供延后加载
 * 的 localDb 模块在首次打开用户数据库时执行硬闸。
 */
export function shouldEnforcePassiveMigrationCompatibility(input: {
  isPackaged: boolean;
  schedulerPassive: boolean;
  isolated: boolean;
}): boolean {
  return !input.isPackaged && input.schedulerPassive && !input.isolated;
}

export function resolveDevCliFlags(input: DevCliFlagsInput): DevCliFlags {
  if (input.isPackaged) {
    return {
      schedulerPassive: false,
      isolated: false,
      userDataDirOverride: null,
      isolatedDirIsEpochDerived: false,
      needsIsolatedDeviceId: false,
      isolationName: null,
      invalidIsolationName: null,
      endpointsCdn: false,
    };
  }

  // 隔离意图与名字:argv 优先(human 直跑路径),env 兜底(restart 脚本路径)。
  let isolated = false;
  let isolationName: string | null = null;
  let invalidIsolationName: string | null = null;
  for (const arg of input.argv) {
    if (arg === '--isolated') {
      isolated = true;
    } else if (arg.startsWith('--isolated=')) {
      isolated = true;
      const raw = arg.slice('--isolated='.length);
      if (ISOLATION_NAME_RE.test(raw)) isolationName = raw;
      else invalidIsolationName = raw;
    }
  }
  // env 路径:开关严格等于 '1' 才生效('0'/'false'/其它值都视为关,不做布尔猜测),
  // 名字单独走 XDT_ISOLATED_NAME——开关与名字分离,任何合法名字(包括 '1')都能用。
  if (!isolated && input.envIsolated === '1') {
    isolated = true;
    const rawName = input.envIsolationName?.trim();
    if (rawName) {
      if (ISOLATION_NAME_RE.test(rawName)) isolationName = rawName;
      else invalidIsolationName = rawName;
    }
  }

  const envDir = input.envUserDataDir?.trim() ? input.envUserDataDir : undefined;
  // 目录纪元 v2(-dev2):#871 起隔离沙箱使用独立的 CindyDev 钥匙串身份;旧
  // `-dev[-<名字>]` 目录属 Cindy 身份纪元,**留给旧 checkout 继续用**——同名目录
  // 被新旧 checkout 轮流以两种钥匙串身份打开会互毁密文(#912 review),换目录做
  // 物理隔离,新旧 checkout 各开各的沙箱。
  const epochDerivedDir = `${input.defaultUserDataDir}-dev2${isolationName ? `-${isolationName}` : ''}`;
  let userDataDirOverride: string | null = envDir ?? null;
  if (isolated && !envDir) {
    userDataDirOverride = epochDerivedDir;
  }
  // CindyDev 身份只允许落在纪元派生目录上:restart 脚本经 env 传入的标准路径与
  // 本地派生一字不差,同样命中;用户显式指向**任意其它目录**(可能是共享中的既有
  // profile,或会被无隔离/旧 checkout 启动形态打开的目录)则不标记——否则同一目录
  // 在「--isolated + 显式覆写」与「裸覆写 / 旧 checkout」两种受支持启动形态之间
  // 会被两种钥匙串身份轮流打开(#912 review P1 第十二轮)。
  // 判等按规范化路径:尾斜杠 / '.' 段 / 大小写不敏感卷上的大小写差异都指向同一
  // 实际目录,字符串全等会把标准纪元目录的等价写法误判成"其它目录"→ 观察模式给
  // 空沙箱抢注默认身份标记,该沙箱**永久**回到共享 Cindy 钥匙串(#912 review 第
  // 十九/二十轮)。规范化交给 canonicalizePath(缺省 realpath 文件系统真值,见
  // defaultCanonicalizePath 注释):不做平台性大小写折叠——大小写敏感卷上仅大小写
  // 不同的是另一个真实目录,把它标成纪元目录会让不认标记的旧 checkout 与 CindyDev
  // 身份对同一 profile 互写密文(#912 review P1 第二十一轮)。
  const canonicalize = input.canonicalizePath ?? defaultCanonicalizePath;
  // 显式 env 覆写必须携带可信纪元信号(XDT_USER_DATA_DIR_EPOCH=1,restart 脚本
  // 派生路径时设置)才允许命中:路径判等挡不住"旧 checkout 以同一显式路径启动"
  // ——旧代码不认标记、以默认身份打开,新代码若认领 CindyDev 即双身份互写
  // (review 反馈 P1 第三十二轮)。内部派生(无 envDir)无需信号。
  const explicitDirTrusted = !envDir || input.envUserDataDirEpoch === '1';
  const isolatedDirIsEpochDerived =
    isolated &&
    explicitDirTrusted &&
    userDataDirOverride !== null &&
    canonicalize(userDataDirOverride) === canonicalize(epochDerivedDir);
  return {
    schedulerPassive: input.argv.includes('--passive') || input.envSchedulerPassive === '1',
    isolated,
    userDataDirOverride,
    isolatedDirIsEpochDerived,
    needsIsolatedDeviceId: isolated && !input.envDeviceIdOverride?.trim(),
    isolationName,
    invalidIsolationName,
    // argv 优先(human 直跑),env 兜底(restart 脚本路径);与 --passive 同款双通道。
    endpointsCdn: input.argv.includes('--endpoints-cdn') || input.envEndpointsCdn === '1',
  };
}
