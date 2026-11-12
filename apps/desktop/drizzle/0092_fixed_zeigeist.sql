CREATE TABLE IF NOT EXISTS `media_invocations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`model_id` text NOT NULL,
	`capability` text NOT NULL,
	`guide_revision` text NOT NULL,
	`guide_json` text NOT NULL,
	`state` text NOT NULL,
	`task_id` text,
	`response_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_invocations_owner_created_at_idx` ON `media_invocations` (`owner`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `media_invocations_owner_state_idx` ON `media_invocations` (`owner`,`state`);
