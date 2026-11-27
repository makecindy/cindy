/** 分享导入水印：记录本机导入时刻。
 *
 * 归属追溯（host-daemons/toolHistory）用它区分「导入的外机旧消息」与「导入后真正在本机
 * 执行的新消息」——前者保留原始时间，不能当本机执行证据。
 *
 * 默认热路径（client/WorkerThreadTransport 的内嵌 worker 代码）与 inproc 回滚口
 * （worker/opHandlers/tx）是两份同名实现，必须共用同一份 SQL，否则两份漂移：
 * 其中一份漏写水印 = 导入的外机历史被当成本机执行证据 → 归属误判 → 授权停止/删除
 * 无关的本机任务。
 */
export const SESSION_IMPORT_SHARE_WATERMARK_SQL = `
  INSERT OR IGNORE INTO session_imports
    (session_id, source, source_session_id, source_fingerprint, source_version,
     mode, status, issue, original_cwd, request_id, imported_at, updated_at)
  VALUES (?, 'cshare', ?, NULL, NULL, 'native', 'ready', NULL, NULL, NULL, ?, ?)
`;
