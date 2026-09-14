CREATE TABLE IF NOT EXISTS `ghost_usage_daily` (
	`ghost_id` text NOT NULL,
	`local_day` text NOT NULL,
	`call_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`ghost_id`, `local_day`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `ghost_usage_daily_day_idx` ON `ghost_usage_daily` (`local_day`);
