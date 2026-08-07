CREATE TABLE IF NOT EXISTS `hook_group_context_cursors` (
	`provider` text NOT NULL,
	`cursor_key` text NOT NULL,
	`cursor_id` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `cursor_key`)
);
