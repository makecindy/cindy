// Fresh owner-scoped terminal database. Schema and triggers match Desktop
// migrations 0083, 0086, 0087 and 0088; historical migrations remain unchanged.
export const GROUP_WINDOW_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS \`hook_group_messages\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	\`provider\` text NOT NULL,
	\`chat_id\` text NOT NULL,
	\`thread_id\` text DEFAULT '' NOT NULL,
	\`message_id\` text NOT NULL,
	\`chat_name\` text,
	\`author\` text NOT NULL,
	\`is_bot\` integer DEFAULT 0 NOT NULL,
	\`text\` text NOT NULL,
	\`file_names\` text,
	\`sent_at\` integer NOT NULL,
	\`created_at\` integer NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS \`hook_group_messages_msg_idx\` ON \`hook_group_messages\` (\`provider\`,\`chat_id\`,\`thread_id\`,\`message_id\`);
CREATE INDEX IF NOT EXISTS \`hook_group_messages_window_idx\` ON \`hook_group_messages\` (\`provider\`,\`chat_id\`,\`thread_id\`,\`id\`);
CREATE TABLE IF NOT EXISTS \`hook_group_context_cursors\` (
	\`provider\` text NOT NULL,
	\`cursor_key\` text NOT NULL,
	\`cursor_id\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	PRIMARY KEY(\`provider\`, \`cursor_key\`)
);

CREATE INDEX IF NOT EXISTS \`hook_group_context_cursors_updated_at_idx\` ON \`hook_group_context_cursors\` (\`updated_at\`);
CREATE VIRTUAL TABLE IF NOT EXISTS \`hook_group_messages_fts\` USING fts5(
	\`text\`,
	\`author\`,
	\`file_names\`,
	content='hook_group_messages',
	content_rowid='id',
	tokenize='porter unicode61'
);
INSERT INTO \`hook_group_messages_fts\`(\`hook_group_messages_fts\`) VALUES('rebuild');
CREATE TRIGGER IF NOT EXISTS \`hook_group_messages_fts_insert\`
AFTER INSERT ON \`hook_group_messages\`
BEGIN
	INSERT INTO \`hook_group_messages_fts\`(rowid, \`text\`, \`author\`, \`file_names\`)
	VALUES (new.\`id\`, new.\`text\`, new.\`author\`, new.\`file_names\`);
END;
CREATE TRIGGER IF NOT EXISTS \`hook_group_messages_fts_delete\`
AFTER DELETE ON \`hook_group_messages\`
BEGIN
	INSERT INTO \`hook_group_messages_fts\`(\`hook_group_messages_fts\`, rowid, \`text\`, \`author\`, \`file_names\`)
	VALUES ('delete', old.\`id\`, old.\`text\`, old.\`author\`, old.\`file_names\`);
END;
CREATE TRIGGER IF NOT EXISTS \`hook_group_messages_fts_update\`
AFTER UPDATE ON \`hook_group_messages\`
BEGIN
	INSERT INTO \`hook_group_messages_fts\`(\`hook_group_messages_fts\`, rowid, \`text\`, \`author\`, \`file_names\`)
	VALUES ('delete', old.\`id\`, old.\`text\`, old.\`author\`, old.\`file_names\`);
	INSERT INTO \`hook_group_messages_fts\`(rowid, \`text\`, \`author\`, \`file_names\`)
	VALUES (new.\`id\`, new.\`text\`, new.\`author\`, new.\`file_names\`);
END;

CREATE TABLE IF NOT EXISTS \`hook_group_message_stats\` (
	\`provider\` text PRIMARY KEY NOT NULL,
	\`row_count\` integer NOT NULL,
	\`text_bytes\` integer NOT NULL
);
INSERT INTO \`hook_group_message_stats\` (\`provider\`, \`row_count\`, \`text_bytes\`)
SELECT \`provider\`, count(*), coalesce(sum(length(CAST(\`text\` AS BLOB))), 0)
FROM \`hook_group_messages\`
GROUP BY \`provider\`
ON CONFLICT(\`provider\`) DO UPDATE SET
	\`row_count\` = excluded.\`row_count\`,
	\`text_bytes\` = excluded.\`text_bytes\`;
CREATE TRIGGER IF NOT EXISTS \`hook_group_message_stats_insert\`
AFTER INSERT ON \`hook_group_messages\`
BEGIN
	INSERT INTO \`hook_group_message_stats\` (\`provider\`, \`row_count\`, \`text_bytes\`)
	VALUES (new.\`provider\`, 1, length(CAST(new.\`text\` AS BLOB)))
	ON CONFLICT(\`provider\`) DO UPDATE SET
		\`row_count\` = \`row_count\` + 1,
		\`text_bytes\` = \`text_bytes\` + excluded.\`text_bytes\`;
END;
CREATE TRIGGER IF NOT EXISTS \`hook_group_message_stats_delete\`
AFTER DELETE ON \`hook_group_messages\`
BEGIN
	UPDATE \`hook_group_message_stats\`
	SET \`row_count\` = \`row_count\` - 1,
		\`text_bytes\` = max(0, \`text_bytes\` - length(CAST(old.\`text\` AS BLOB)))
	WHERE \`provider\` = old.\`provider\`;
	DELETE FROM \`hook_group_message_stats\`
	WHERE \`provider\` = old.\`provider\` AND \`row_count\` <= 0;
END;
CREATE TRIGGER IF NOT EXISTS \`hook_group_message_stats_update\`
AFTER UPDATE ON \`hook_group_messages\`
BEGIN
	UPDATE \`hook_group_message_stats\`
	SET \`row_count\` = \`row_count\` - 1,
		\`text_bytes\` = max(0, \`text_bytes\` - length(CAST(old.\`text\` AS BLOB)))
	WHERE \`provider\` = old.\`provider\`;
	DELETE FROM \`hook_group_message_stats\`
	WHERE \`provider\` = old.\`provider\` AND \`row_count\` <= 0;
	INSERT INTO \`hook_group_message_stats\` (\`provider\`, \`row_count\`, \`text_bytes\`)
	VALUES (new.\`provider\`, 1, length(CAST(new.\`text\` AS BLOB)))
	ON CONFLICT(\`provider\`) DO UPDATE SET
		\`row_count\` = \`row_count\` + 1,
		\`text_bytes\` = \`text_bytes\` + excluded.\`text_bytes\`;
END;
`;
