CREATE INDEX IF NOT EXISTS `hook_group_context_cursors_updated_at_idx` ON `hook_group_context_cursors` (`updated_at`);--> statement-breakpoint
CREATE VIRTUAL TABLE IF NOT EXISTS `hook_group_messages_fts` USING fts5(
	`text`,
	`author`,
	`file_names`,
	content='hook_group_messages',
	content_rowid='id',
	tokenize='porter unicode61'
);--> statement-breakpoint
INSERT INTO `hook_group_messages_fts`(`hook_group_messages_fts`) VALUES('rebuild');--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `hook_group_messages_fts_insert`
AFTER INSERT ON `hook_group_messages`
BEGIN
	INSERT INTO `hook_group_messages_fts`(rowid, `text`, `author`, `file_names`)
	VALUES (new.`id`, new.`text`, new.`author`, new.`file_names`);
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `hook_group_messages_fts_delete`
AFTER DELETE ON `hook_group_messages`
BEGIN
	INSERT INTO `hook_group_messages_fts`(`hook_group_messages_fts`, rowid, `text`, `author`, `file_names`)
	VALUES ('delete', old.`id`, old.`text`, old.`author`, old.`file_names`);
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `hook_group_messages_fts_update`
AFTER UPDATE ON `hook_group_messages`
BEGIN
	INSERT INTO `hook_group_messages_fts`(`hook_group_messages_fts`, rowid, `text`, `author`, `file_names`)
	VALUES ('delete', old.`id`, old.`text`, old.`author`, old.`file_names`);
	INSERT INTO `hook_group_messages_fts`(rowid, `text`, `author`, `file_names`)
	VALUES (new.`id`, new.`text`, new.`author`, new.`file_names`);
END;
