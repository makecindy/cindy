/**
 * IM 控制文案的多语言入口。
 *
 * 个人 bot（飞书、Telegram、Discord、微信、企业微信、钉钉、iMessage）与官方 hook 的控制文案
 * ——命令回执、状态提示、卡片按钮、错误说明——跟随主人在 Cindy 里选的界面语言，与个人 bot
 * 命令菜单同一口径（见 docs/product-rules/telegram-bot-parity.md）。Agent 的正文回复不经过这里，
 * 仍随来信语言。
 *
 * 文案放在 renderer locale 的 `imBot.text.<渠道>.*` 下，与界面词库同一套门禁与术语表。
 * 每次调用都按当前语言现取，主人切换语言后下一条消息即生效。
 */

import { t, tCount } from '../../i18n.desktop';

export type ImTextVars = Record<string, string | number | null | undefined>;

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** 取 `key` 的当前语言文案并填入 `{{变量}}`；传数字 `count` 时按复数规则选 `_one` / `_other`。 */
export function imText(key: string, vars?: ImTextVars): string {
  const count = vars?.count;
  const raw = typeof count === 'number' ? tCount(key, count) : t(key);
  if (!vars) return raw;
  return raw.replace(PLACEHOLDER, (match, name: string) => {
    const value = vars[name];
    return value === undefined || value === null ? match : String(value);
  });
}
