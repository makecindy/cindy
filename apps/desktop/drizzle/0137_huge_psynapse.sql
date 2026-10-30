CREATE TABLE `bot_task_origin_messages` (
	`bot_id` text NOT NULL,
	`message_id` text NOT NULL,
	PRIMARY KEY(`bot_id`, `message_id`),
	FOREIGN KEY (`bot_id`) REFERENCES `bot_task_origins`(`bot_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bot_task_origins` (
	`bot_id` text PRIMARY KEY NOT NULL,
	`source_session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`handoff_consumed_at` integer,
	`prepared_at` integer,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_task_origin_source` ON `bot_task_origins` (`source_session_id`);