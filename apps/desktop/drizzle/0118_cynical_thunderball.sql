CREATE TABLE `bot_group_plan_steps` (
	`plan_id` text NOT NULL,
	`position` integer NOT NULL,
	`bot_id` text NOT NULL,
	`bot_name` text NOT NULL,
	`task` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result_message_id` text,
	`started_at` integer,
	`finished_at` integer,
	PRIMARY KEY(`plan_id`, `position`),
	FOREIGN KEY (`plan_id`) REFERENCES `bot_group_plans`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `bot_group_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`status` text NOT NULL,
	`request_text` text NOT NULL,
	`organizer_bot_id` text NOT NULL,
	`organizer_name` text NOT NULL,
	`current_step` integer,
	`work_dir` text,
	`branch` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `bot_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bot_group_plans_group_created` ON `bot_group_plans` (`group_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `bot_group_messages` ADD `plan_id` text;--> statement-breakpoint
ALTER TABLE `bot_group_messages` ADD `files_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_groups` ADD `organizer_bot_id` text;--> statement-breakpoint
ALTER TABLE `bot_groups` ADD `project_dir` text;