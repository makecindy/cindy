/**
 * 伙伴文案里那个第三人称的取值口。
 *
 * 中文文案统一写成 `{{pronoun}}`,由这里按角色性别填「她 / 他」;用户自建、
 * 没有性别设定的伙伴填它自己的名字(「小助手记得的」),不退回「TA」——
 * 产品裁决见 shared/botGender.ts。
 *
 * 英日韩文案不含这个插值(那些语言本来就不带性别代词),多传一个变量无副作用。
 */
import { botPronoun, normalizeBotGender } from '../../../shared/botGender';

export function botPronounFor(
  bot: { gender?: unknown; name?: string | null } | null | undefined,
): string {
  return botPronoun(normalizeBotGender(bot?.gender), bot?.name ?? '');
}
