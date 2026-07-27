/**
 * 「跳过登录」本地模式标记 —— 无账号进主界面的本机记忆。
 *
 * 产品拍板 2026-07-27:手机端新增「跳过登录」入口(推翻 2026-07-24「手机/pad 必须有
 * 账号」),语义与桌面 app-session 的 local 模式对齐 —— 跳过一次之后**重启仍直接进
 * 主界面**,直到用户真正登录(账号优先,标记清除)或主动退出。
 *
 * 存储选型:AsyncStorage 而非 SecureStore —— 这里存的是一个 UI/路由偏好,不是凭证
 * (仓规:凭证走 SecureStore;非凭证不占用安全存储)。读写全 best-effort:写失败只
 * 影响「下次冷启动是否记住」,不阻断本次进入主界面;读失败按未跳过处理(回登录页,
 * 用户可再点一次),不把异常升级成启动失败。
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'cindy.mobile.auth.localMode';
/** 唯一合法的「已跳过」值;其余(含历史脏值)一律按未跳过。 */
const ENABLED_VALUE = '1';

/** 读本机是否处于「跳过登录」态(异常/缺失 → false)。 */
export async function readLocalMode(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(STORAGE_KEY)) === ENABLED_VALUE;
  } catch {
    return false;
  }
}

/**
 * 写入串行队列:保证「调用顺序 == 盘上生效顺序」。
 *
 * 为什么必须串行(2026-07-27 P1 修复):本标记的写入方有三条并发路径 ——
 * `enterLocalMode`(点跳过)、`applyUser`(拿到真实身份即清标记)、`clearLocalSession`
 * (登出)。native storage mutation 是异步的,并发下 `setItem('1')` 可能比后发出的
 * `removeItem` **更晚** settle,内存已是账号态而盘上留下 `"1"`;凭证随后失效或被清理后,
 * 下一次冷启动就会错误地直接进无账号主界面而不是登录页。串行化让后发起的写永远后落盘,
 * 最终盘上态与内存态一致(last-write-wins)。机制沿用 AuthContext 里 refresh token /
 * user profile / deletion receipt 三处已在用的 promise-chain serializer;落点放在 store
 * 是因为这个键的所有写入口都在本模块,放这里能覆盖全部调用方(含未来新增的)。
 */
let writeQueue: Promise<void> = Promise.resolve();

/** 落盘/清除「跳过登录」态(best-effort,失败静默;写入按调用顺序串行)。 */
export function persistLocalMode(enabled: boolean): Promise<void> {
  const write = async () => {
    try {
      if (enabled) await AsyncStorage.setItem(STORAGE_KEY, ENABLED_VALUE);
      else await AsyncStorage.removeItem(STORAGE_KEY);
    } catch {
      // 见文件头:持久化失败不阻断进入/退出主界面
    }
  };
  // then(write, write):前一次写失败也照样接着跑,队列不会被一次异常卡死。
  const run = writeQueue.then(write, write);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
