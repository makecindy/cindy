CREATE TABLE `message_annotations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`anchor_json` text NOT NULL,
	`comment` text NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_message_annotations_session` ON `message_annotations` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_message_annotations_ordinal` ON `message_annotations` (`message_id`,`ordinal`);