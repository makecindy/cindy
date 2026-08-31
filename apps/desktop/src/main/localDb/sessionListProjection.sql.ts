import { SESSION_LIST_MESSAGE_COUNT_CAP } from '@cindy/maker-shared/session-list';

export { SESSION_LIST_MESSAGE_COUNT_CAP };

/** SQL 抽出的预览原文上限。mapper 再折叠空白并截到 140。 */
export const LIST_PREVIEW_EXTRACT_CHARS = 512;

/**
 * 从 messages.content（JSON 字符串）抽出纯文本。对齐 extractMessagePreview 的解析口径：
 * JSON 字符串（assistant）原样取；user 对象取 .text；非法 JSON 当纯文本。
 * 不做 substr 截断半截 JSON——先 json_extract 再截。
 */
export const LIST_PREVIEW_EXTRACT_SQL = `CASE
  WHEN json_valid(m.content) = 0 THEN substr(m.content, 1, ${LIST_PREVIEW_EXTRACT_CHARS})
  WHEN json_type(m.content) = 'text' THEN substr(json_extract(m.content, '$'), 1, ${LIST_PREVIEW_EXTRACT_CHARS})
  WHEN m.role = 'user' AND json_type(m.content) = 'object' THEN substr(json_extract(m.content, '$.text'), 1, ${LIST_PREVIEW_EXTRACT_CHARS})
  ELSE NULL
END`;

/** autoResume 只出现在注入的 user「继续」行；assistant 不读 agent_meta，避免跨越多 MB content overflow。 */
export const LATEST_VISIBLE_PREVIEW_FILTER_SQL = `m.role IN ('user', 'assistant')
    AND m.rewind_at IS NULL
    AND (m.role != 'user' OR m.agent_meta IS NULL OR CASE WHEN json_valid(m.agent_meta) THEN json_extract(m.agent_meta, '$.autoResume') END IS NOT 1)`;

const LATEST_VISIBLE_PREVIEW_FROM_SQL = `FROM messages m
      WHERE m.session_id = sessions.id
        AND ${LATEST_VISIBLE_PREVIEW_FILTER_SQL}
        AND (sessions.cleared_at IS NULL OR m.created_at > sessions.cleared_at)
      ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`;

/**
 * 把仍为 NULL 的 preview / count 一次性写回 sessions。
 * 绑定 JSON 数组，只用 `id`；preview/count 在本句内从 messages 现算，
 * 避免 list 读出的旧 payload 盖住读后、写回前的失效。
 * 只填当前仍是 NULL 的列，避免盖掉写路径已经落好的值。
 */
export const SESSION_LIST_PROJECTION_BACKFILL_SQL = `UPDATE sessions
SET
  list_preview = CASE
    WHEN sessions.list_preview IS NULL THEN (
      SELECT ${LIST_PREVIEW_EXTRACT_SQL} ${LATEST_VISIBLE_PREVIEW_FROM_SQL}
    )
    ELSE sessions.list_preview
  END,
  list_preview_role = CASE
    WHEN sessions.list_preview IS NULL THEN (
      SELECT m.role ${LATEST_VISIBLE_PREVIEW_FROM_SQL}
    )
    ELSE sessions.list_preview_role
  END,
  list_message_count = CASE
    WHEN sessions.list_message_count IS NULL THEN (
      SELECT count(*) FROM messages m WHERE m.session_id = sessions.id
    )
    ELSE sessions.list_message_count
  END
FROM (
  SELECT json_extract(value, '$.id') AS id FROM json_each(?)
) AS payload
WHERE sessions.id = payload.id`;
