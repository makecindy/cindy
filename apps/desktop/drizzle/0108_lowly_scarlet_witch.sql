CREATE TABLE `__new_bot_direct_message_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_a_id` text NOT NULL,
	`bot_b_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`close_reason` text,
	`message_count` integer DEFAULT 0 NOT NULL,
	`max_messages` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`blocked_until` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
INSERT INTO `__new_bot_direct_message_threads`("id", "bot_a_id", "bot_b_id", "status", "close_reason", "message_count", "max_messages", "expires_at", "blocked_until", "created_at", "updated_at", "closed_at") SELECT "id", "bot_a_id", "bot_b_id", "status", "close_reason", "message_count", "max_messages", "expires_at", "blocked_until", "created_at", "updated_at", "closed_at" FROM `bot_direct_message_threads`;--> statement-breakpoint
CREATE TABLE `__new_bot_direct_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`sender_bot_id` text NOT NULL,
	`recipient_bot_id` text NOT NULL,
	`sender_session_id` text,
	`recipient_session_id` text,
	`delivery_status` text DEFAULT 'pending' NOT NULL,
	`sender_name` text,
	`recipient_name` text,
	`content` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `__new_bot_direct_message_threads`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recipient_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_bot_direct_messages`("id", "thread_id", "sequence", "sender_bot_id", "recipient_bot_id", "sender_session_id", "recipient_session_id", "delivery_status", "sender_name", "recipient_name", "content", "created_at") SELECT "id", "thread_id", "sequence", "sender_bot_id", "recipient_bot_id", "sender_session_id", "recipient_session_id", "delivery_status", NULL, NULL, "content", "created_at" FROM `bot_direct_messages`;--> statement-breakpoint
DROP TABLE `bot_direct_messages`;--> statement-breakpoint
DROP TABLE `bot_direct_message_threads`;--> statement-breakpoint
ALTER TABLE `__new_bot_direct_message_threads` RENAME TO `bot_direct_message_threads`;--> statement-breakpoint
ALTER TABLE `__new_bot_direct_messages` RENAME TO `bot_direct_messages`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_dm_threads_active_pair` ON `bot_direct_message_threads` (`bot_a_id`,`bot_b_id`) WHERE "bot_direct_message_threads"."status" = 'active';--> statement-breakpoint
CREATE INDEX `idx_bot_dm_threads_pair_updated` ON `bot_direct_message_threads` (`bot_a_id`,`bot_b_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_direct_messages_thread_sequence` ON `bot_direct_messages` (`thread_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_bot_direct_messages_thread_created` ON `bot_direct_messages` (`thread_id`,`created_at`);