/**
 * sessionTitle —— 会话标题占位与哨兵的**跨端单一来源**。
 *
 * 为什么必须共享:自动起名分两步落库(先用用户原话截断写占位,再用模型生成的智能
 * 标题覆盖),而 renderer 在建会话那一刻还会先做一次乐观预览、main 随后才写权威
 * 值。两侧算出的串必须**逐字相同**,否则侧边栏会在「预览」与「回流」之间跳变一
 * 次。此前 main 与 renderer 各持一份复制实现、只靠注释约束一致;新增第三个使用
 * 点(乐观预览)之前先收敛到这里。
 */

/**
 * 建会话时的默认标题,同时充当「尚未起名」的哨兵值。
 *
 * **刻意保持英文字面量、不做 i18n**:它既是 SQLite 列默认值,又要跨设备
 * (device-link 控制端读被控端标题)、跨语言(用户随时切 locale)做逐字比对,还是
 * 条件写 `WHERE title = 期望值` 里的期望值。把它本地化会让哨兵匹配失效、自动起名
 * 永久跳过 —— 标题会永远钉死在占位上。
 *
 * 面向用户的显示层另有本地化兜底(见各端的 display title 推导),**不要**把这个
 * 常量直接拿去显示。
 */
export const DEFAULT_DRAFT_SESSION_TITLE = 'New Maker';

/**
 * 自动标题的统一归一化:折叠空白 → trim → 截断 40 字。先 trim 再截断,避免前导
 * 大量空白吃满长度后得到空标题。
 *
 * 落库出口、占位覆写方与 renderer 的乐观预览都用它算出同一个串。
 */
export function normalizeAutoTitle(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 40).trimEnd();
}

/**
 * 标题是否仍是建会话时的裸默认哨兵 —— 即「既没被自动起名、也没被用户改名」。
 *
 * 精确比较,不做大小写归一:用户手动把标题改成 `new maker` 是一个合法的自定义
 * 标题,不该被当成系统占位覆盖掉。
 */
export function isDefaultDraftSessionTitle(title: string | null | undefined): boolean {
  return title === DEFAULT_DRAFT_SESSION_TITLE;
}

/**
 * 哨兵 → 兜底文案的**最小投影**:所有「渲染 / 搜索匹配 / 重命名预填」路径共用的
 * 唯一判据出口。
 *
 * 只做一件事:标题是哨兵且调用方给了已解析的 i18n 文案时换成那个文案,其余原样返回
 * (`null` / `undefined` 归一成空串,由调用方自己接后续兜底链,例如 workingDir)。
 * 刻意不在这里兜任何具体文案:共享层不知道调用方的 locale,写死中文串会让 en / ja /
 * ko 端悄悄显示中文(PR #1031 review P1)。
 *
 * 为什么必须共享:同一条会话的「显示串」被三类路径消费 —— 渲染、搜索 haystack /
 * 命中下标、重命名输入框预填。任何一处用原始 `title`、另一处用投影值,就会错位:
 * 搜界面上看得见的文案搜不到、搜不可见的内部哨兵反而命中,或者高亮画到别的字上。
 */
export function projectDraftSessionTitle(
  title: string | null | undefined,
  unnamedLabel: string | null | undefined,
): string {
  if (isDefaultDraftSessionTitle(title) && unnamedLabel) return unnamedLabel;
  return title ?? '';
}
