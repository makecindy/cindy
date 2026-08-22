/**
 * cindy-docs/csv.ts —— RFC 4180 分隔符文本解析(csv / tsv 共用)。
 *
 * 为什么手写而不是拉一个库:read_sheet 只需要「把一份本地文本切成二维数组」,
 * 规则本身就是 RFC 4180 那几条,自己实现比引一个新依赖更可控,也方便把口径
 * 钉在测试里。
 *
 * 覆盖的口径:
 *  - 引号字段内可含分隔符、换行与转义引号("" → ");
 *  - CRLF / LF / CR 三种行尾都当换行,输出统一不带行尾符;
 *  - 前导 BOM 剥掉(Excel 导出的 UTF-8 CSV 常带 BOM,不剥会污染第一列表头);
 *  - 最后一行没有行尾符也算一行;整份文本为空则返回零行;
 *  - 引号只有在字段的第一个字符时才进入引号态,`a"b` 原样保留(与 Excel 一致)。
 */

export interface ParseDelimitedOptions {
  /** 单字符分隔符。csv → ','; tsv → '\t'。 */
  delimiter: string;
}

/** 把分隔符文本解析成二维字符串数组。永不 throw。 */
export function parseDelimited(text: string, opts: ParseDelimitedOptions): string[][] {
  const delimiter = opts.delimiter.length > 0 ? opts.delimiter[0]! : ',';
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // 字段是否还停在「第一个字符」上 —— 决定引号算引号态还是普通字符。
  let atFieldStart = true;

  const endField = (): void => {
    row.push(field);
    field = '';
    atFieldStart = true;
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      continue;
    }
    if (ch === delimiter) {
      endField();
      continue;
    }
    if (ch === '\r') {
      // CRLF 与裸 CR 都作一次换行。
      if (src[i + 1] === '\n') i += 1;
      endRow();
      continue;
    }
    if (ch === '\n') {
      endRow();
      continue;
    }
    field += ch;
    atFieldStart = false;
  }

  // 未闭合的引号:按「读到文件尾即字段结束」收尾,不报错 —— 半截文件也应该
  // 尽量给出可用内容,让模型自己判断要不要重取。
  if (inQuotes || field.length > 0 || row.length > 0) {
    endRow();
  }

  // 尾部单个空行(文本以换行结尾)不是数据行,去掉。
  const last = rows[rows.length - 1];
  if (rows.length > 0 && last && last.length === 1 && last[0] === '') {
    rows.pop();
  }
  return rows;
}

/** 按扩展名推断分隔符;未知扩展名按逗号处理。 */
export function delimiterForExtension(ext: string): string {
  const normalized = ext.toLowerCase();
  if (normalized === '.tsv' || normalized === '.tab') return '\t';
  return ',';
}
