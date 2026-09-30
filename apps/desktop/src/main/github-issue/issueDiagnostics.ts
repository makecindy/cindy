/**
 * /issue 的相关日志摘要。
 *
 * 这里只消费 log-upload 的最终安全记录，不直接读取日志文件，也不把原始日志交给
 * issue 提交链路。这样来源白名单、字段白名单、脱敏和长度限制始终只有一套事实源。
 */

import { redactSensitive } from '../learn-host/redaction';
import { redact } from '../log-upload/redact';
import type { UploadRecord } from '../log-upload/types';

const RELATED_LOG_LOOKBACK_MS = 2 * 60 * 60 * 1000;
const MAX_RELATED_LOG_RECORDS = 24;
const MAX_RELATED_LOG_CHARS = 2200;
const MAX_RELATED_LOG_LINE_CHARS = 500;
export const RELATED_LOG_SECTION_MARKER = '\n---\n## 相关日志';

export interface RelatedIssueLogs {
  section: string;
  recordCount: number;
}

function publicLogText(text: string, workingDir?: string): string {
  const withoutWorkdir = workingDir && workingDir.length > 1
    ? text.split(workingDir).join('[REDACTED:path]')
    : text;
  return redactSensitive(redact(withoutWorkdir)).text
    .replace(/[A-Za-z0-9.*_%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[REDACTED:email]')
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g, '[REDACTED:url]')
    .replace(/(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/(?:Users|home)\/)[^\r\n"']*/g, '[REDACTED:path]')
    .replace(/(^|[\s=("'])(\/(?!\/)[^\r\n"']+)/gm, '$1[REDACTED:path]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
}

function safeLogLine(record: UploadRecord, workingDir?: string): string {
  const timestamp = new Date(record.ts).toISOString();
  const scope = publicLogText(record.scope.split(/[/:]/)[0], workingDir);
  const level = ['info', 'warn', 'error', 'fatal'].includes(record.level.toLowerCase())
    ? record.level.toUpperCase()
    : 'INFO';
  const message = publicLogText(record.msg, workingDir).replace(/[\r\n]+/g, ' ↵ ').trim();
  const line = '- ' + timestamp + ' [' + level + '] [' + record.src + '/' + scope + '] ' + message;
  return line.length > MAX_RELATED_LOG_LINE_CHARS
    ? line.slice(0, MAX_RELATED_LOG_LINE_CHARS - 1) + '…'
    : line;
}

export function formatRelatedIssueLogs(
  records: readonly UploadRecord[],
  nowMs: number,
  workingDir?: string,
): RelatedIssueLogs {
  const recent = records
    .filter((record) => {
      const timestamp = Date.parse(record.ts);
      return Number.isFinite(timestamp) && timestamp <= nowMs &&
        timestamp >= nowMs - RELATED_LOG_LOOKBACK_MS &&
        ['info', 'warn', 'error', 'fatal'].includes(record.level.toLowerCase());
    })
    .sort((left, right) => {
      const priority = (record: UploadRecord) =>
        ['error', 'fatal'].includes(record.level.toLowerCase()) ? 2 :
          record.level.toLowerCase() === 'warn' ? 1 : 0;
      return priority(right) - priority(left) || Date.parse(right.ts) - Date.parse(left.ts);
    });

  const selected: { timestamp: number; line: string }[] = [];
  let remaining = MAX_RELATED_LOG_CHARS - 400;
  for (const record of recent) {
    const line = safeLogLine(record, workingDir);
    if (line.length + 1 > remaining) continue;
    selected.push({ timestamp: Date.parse(record.ts), line });
    remaining -= line.length + 1;
    if (selected.length >= MAX_RELATED_LOG_RECORDS) break;
  }
  const content = selected.sort((left, right) => left.timestamp - right.timestamp)
    .map((record) => record.line).join('\n');
  const fenceLength = Math.max(3, ...Array.from(content.matchAll(/\x60+/g), (match) => match[0].length + 1));
  const fence = String.fromCharCode(96).repeat(fenceLength);

  return {
    recordCount: selected.length,
    section: [
      '',
      '---',
      '## 相关日志',
      '',
      '提交客户端本机最近 2 小时的运行日志摘录，不代表已定位故障，也不包含 SSH 远端或手机日志。已按来源和字段白名单过滤并脱敏；不读取对话正文或原始请求响应。',
      ...(content ? [fence + 'text', content, fence] : ['未找到可公开的相关日志记录。']),
      ...(selected.length < recent.length ? ['部分记录因条数或长度限制省略，优先保留错误和警告。'] : []),
    ].join('\n'),
  };
}

export const __testing = {
  RELATED_LOG_LOOKBACK_MS,
  MAX_RELATED_LOG_RECORDS,
  MAX_RELATED_LOG_CHARS,
  safeLogLine,
};
