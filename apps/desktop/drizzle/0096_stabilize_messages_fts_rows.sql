CREATE TABLE IF NOT EXISTS `messages_fts_rows` (
	`fts_rowid` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `messages_fts_rows_message_id_idx` ON `messages_fts_rows` (`message_id`);
