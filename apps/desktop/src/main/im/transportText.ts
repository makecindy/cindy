/**
 * 把 @cindy/im 传输层的用户可见文案（上下线播报、思考占位、文件送达提示、连接错误原因等）
 * 接到桌面端的界面语言上。
 *
 * 文案 key 在 `imBot.text.transport.*`。imText 找不到 key 时会原样返回 key——这里改回 null，
 * 让传输层落回它内置的中文文案，而不是把 key 发进聊天。
 *
 * 只需以副作用方式导入一次（见 ./host）；之后每条文案都在发送时按当前语言现取。
 */

import { setTransportTextResolver } from '@cindy/im';

import { imText } from './shared/imText';

export function resolveTransportText(
  key: string,
  vars?: Record<string, string | number>,
): string | null {
  const text = imText(key, vars);
  return text === key ? null : text;
}

setTransportTextResolver(resolveTransportText);
