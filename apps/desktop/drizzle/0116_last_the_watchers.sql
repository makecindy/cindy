CREATE TABLE `bot_group_members` (
	`group_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`position` integer NOT NULL,
	`last_seen_sequence` integer DEFAULT 0 NOT NULL,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`group_id`, `bot_id`),
	FOREIGN KEY (`group_id`) REFERENCES `bot_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bot_group_members_bot` ON `bot_group_members` (`bot_id`);--> statement-breakpoint
CREATE TABLE `bot_group_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`kind` text DEFAULT 'message' NOT NULL,
	`author_kind` text NOT NULL,
	`author_bot_id` text,
	`author_name` text DEFAULT '' NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`mentions_json` text DEFAULT '{"all":false,"botIds":[]}' NOT NULL,
	`notice_code` text,
	`client_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `bot_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_group_messages_group_sequence` ON `bot_group_messages` (`group_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_group_messages_group_client` ON `bot_group_messages` (`group_id`,`client_id`) WHERE "bot_group_messages"."client_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `bot_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`reply_mode` text DEFAULT 'all' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bot_groups_updated` ON `bot_groups` (`updated_at`);