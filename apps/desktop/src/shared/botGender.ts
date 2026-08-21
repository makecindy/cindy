/**
 * 伙伴的性别与人称代词。
 *
 * 产品裁决(Chris 2026-08-21):**女的就是「她」,男的就是「他」,不用「TA」**。
 * 「TA」在中文界面里是一种偷懒 —— 角色明明有性别,却用一个书面缩写把所有人
 * 抹平。阵容里的角色各自有设定,界面文案就该照着叫。
 *
 * 只有两种情况用中性词:
 *   1. 用户自己建的伙伴(没选性别) —— 用「这位伙伴」这类说法,不用代词;
 *   2. 还没选定角色的通用页面(阵容页) —— 同上。
 *
 * 中文以外的语言不需要这套:英文用 they、日文韩文本来就不带性别代词,i18n
 * 里各自写自然表达即可。所以本模块只产出代词字符串,由 i18n 插值决定放在哪。
 */

export const BOT_GENDERS = ['female', 'male', 'neutral'] as const;

export type BotGender = (typeof BOT_GENDERS)[number];

export function normalizeBotGender(value: unknown): BotGender {
  return value === 'female' || value === 'male' ? value : 'neutral';
}

/**
 * 界面文案里指代这个伙伴的那个词。
 *
 * 性别已知就用「她 / 他」;用户自建、没有性别设定的伙伴用**它自己的名字**
 * (「小助手记得的」)—— 比留一个空洞或退回「TA」都自然,而且不需要为中性情况
 * 另写一套文案变体:所有句子都是同一个 `{{pronoun}}` 插值。
 *
 * 中文以外的语言不需要这套(英文 they、日韩本就不带性别代词),各自在 i18n 里
 * 写自然表达即可 —— 那些文案不引用本函数。
 */
export function botPronoun(gender: BotGender, displayName: string): string {
  if (gender === 'female') return '她';
  if (gender === 'male') return '他';
  return padLatin(displayName.trim()) || '这位伙伴';
}

/**
 * 中文正文里代词紧贴前后字(「让她加入」),但夹进来的如果是西文名字,不留空隙就
 * 挤成一团(「让Cindy加入」)。文案模板里因此**不写空格**,由这里按值决定 ——
 * 名字首尾是西文才补,中文名字原样返回。
 *
 * 只对中文生效:en / ja / ko 的文案根本不引用这个插值。
 */
function padLatin(name: string): string {
  if (!name) return name;
  const cjk = /[㐀-鿿぀-ヿ가-힯]/;
  const head = cjk.test(name[0]!) ? '' : ' ';
  const tail = cjk.test(name[name.length - 1]!) ? '' : ' ';
  return `${head}${name}${tail}`;
}
