CREATE TABLE `auxiliary_usage_receipts` (
	`receipt_id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`model` text NOT NULL,
	`source` text NOT NULL,
	`session_id` text,
	`transport` text NOT NULL,
	`day` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cache_read_tokens` integer,
	`cache_create_tokens` integer
);
--> statement-breakpoint
CREATE INDEX `auxiliary_usage_receipts_day_idx` ON `auxiliary_usage_receipts` (`day`);