/**
 * 历史工具 from / to 的时间解析(search_chat_history / get_chat_history /
 * list_sessions 共用)。
 *
 * `new Date('2024-02-30')` 不报错, 而是静默滚到 2024-03-01 —— 模型推算
 * 「月底」时很容易写出这种日期, 查询范围会悄悄偏移。这里在保留现有可接受
 * 写法的前提下, 只额外拒绝日历上不存在的 `YYYY-MM-DD` 日期部分。
 *
 *  - undefined / 空串 → null (不过滤)
 *  - 合法时间 → unix ms
 *  - 非法 → 'invalid' (调用方返 INVALID_ARGS)
 */
export function parseIsoMs(s: string | undefined): number | null | 'invalid' {
  if (s === undefined || s === '') return null;
  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) return 'invalid';
  // new Date 会忽略前导空白, 日期部分的定位也要跳过它, 否则 ' 2024-02-30' 绕过校验。
  const date = /^(\d{4})-(\d{2})-(\d{2})(?![\d])/.exec(s.trimStart());
  if (date) {
    const year = Number(date[1]);
    const month = Number(date[2]);
    const day = Number(date[3]);
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return 'invalid';
  }
  return t;
}
