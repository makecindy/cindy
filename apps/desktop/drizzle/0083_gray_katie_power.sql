CREATE TABLE IF NOT EXISTS `hook_group_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`chat_id` text NOT NULL,
	`thread_id` text DEFAULT '' NOT NULL,
	`message_id` text NOT NULL,
	`chat_name` text,
	`author` text NOT NULL,
	`is_bot` integer DEFAULT 0 NOT NULL,
	`text` text NOT NULL,
	`file_names` text,
	`sent_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `hook_group_messages_msg_idx` ON `hook_group_messages` (`provider`,`chat_id`,`thread_id`,`message_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `hook_group_messages_window_idx` ON `hook_group_messages` (`provider`,`chat_id`,`thread_id`,`id`);