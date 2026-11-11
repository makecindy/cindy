/**
 * 纯文字渠道（微信、企业微信、钉钉、iMessage）里让用户回复的确认词。
 *
 * 提示里展示的是主人界面语言的说法（`imBot.text.shared.replyWords.*`）；解析时这个词与各渠道
 * 固定词表（中英常用说法）一并接受，避免提示让用户回一个解析不认的词。
 */

import { imText } from './imText';

export type ReplyWords = {
  allow: string;
  deny: string;
  approve: string;
};

export function localizedReplyWords(): ReplyWords {
  return {
    allow: imText('imBot.text.shared.replyWords.allow'),
    deny: imText('imBot.text.shared.replyWords.deny'),
    approve: imText('imBot.text.shared.replyWords.approve'),
  };
}

/** `normalized` 已小写、去空白；命中固定词表或当前语言的确认词即算匹配。 */
export function matchesReplyWord(normalized: string, fixed: readonly string[], localized: string): boolean {
  return fixed.includes(normalized) || normalized === localized.trim().toLowerCase();
}
