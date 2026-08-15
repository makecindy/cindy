CREATE TABLE IF NOT EXISTS `coding_plan_usage_snapshots` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`snapshot` text NOT NULL,
	`updated_at` integer NOT NULL
);
