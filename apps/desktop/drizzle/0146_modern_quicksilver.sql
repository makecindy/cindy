CREATE TABLE `pi_usage_receipts` (
	`session_id` text NOT NULL,
	`settlement_id` text NOT NULL,
	`receipt_id` text NOT NULL,
	`recorded_at` integer NOT NULL,
	`priced` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`session_id`, `settlement_id`, `receipt_id`)
);
