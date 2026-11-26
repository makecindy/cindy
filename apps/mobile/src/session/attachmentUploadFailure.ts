/**
 * attachmentUploadFailure.ts — 手机端附件上传失败 → 界面文案(内部码换人话)。
 *
 * 直连电脑的附件上传(peerFileTransport)失败时抛的是内部码
 * `FILE_PEER_CANCELLED` / `FILE_PEER_TIMEOUT` / `FILE_PEER_UNAVAILABLE`。这些码对
 * 用户没有意义:锁屏、切走 App、离开这个任务都会让上传以 CANCELLED 中断,用户需要知道
 * 的是「中断了,可以重试或删掉」,而不是猜一个下划线常量。
 *
 * 这里只做「内部码 → i18n key」的映射:不翻译、不自动重试、不改传输层的失败判定。
 * 识别不了的原样返回 null:调用方**必须保留上传管线自己的文案**(取不到 token 的
 * 「登录已过期」、预处理超时等已经是可读的具体提示),不能压成通用句。
 *
 * 纯函数,无 RN / 网络依赖,node 可单测。
 */

/** 内部码标记 → 界面文案 key,按顺序匹配第一个命中的。 */
const FAILURE_KEYS: ReadonlyArray<readonly [marker: string, key: string]> = [
  // 取消 / 中断同一条通道:用户主动 X 掉的任务不会走到这里(controller 标 discarded),
  // 能在界面上看到 CANCELLED 的,都是锁屏、切走 App、离开任务这类被动中断。
  ['FILE_PEER_CANCELLED', 'composer.upload.interrupted'],
  ['FILE_PEER_TIMEOUT', 'composer.upload.timeout'],
  ['FILE_PEER_UNAVAILABLE', 'composer.upload.peerUnavailable'],
];

/** 同族内部码(CLOSED / CHANGED / UPLOAD / ANSWER …)统一按「中断」给出可操作的一句话。 */
const PEER_FAMILY_MARKER = 'FILE_PEER_';

/** 错误 → 待匹配文本:兼容 Error(含可能存在的 `code` 字段)与裸字符串。 */
function failureText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? `${error.message} ${code}` : error.message;
  }
  return String(error);
}

/**
 * 上传失败错误 → 界面文案 i18n key;不是已知的上传内部码时返回 null。
 * 调用方用 `t(key)` 取文案。
 */
export function attachmentUploadFailureKey(error: unknown): string | null {
  const text = failureText(error);
  for (const [marker, key] of FAILURE_KEYS) {
    if (text.includes(marker)) return key;
  }
  if (text.includes(PEER_FAMILY_MARKER)) return 'composer.upload.interrupted';
  return null;
}
