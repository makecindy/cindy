CREATE TABLE IF NOT EXISTS `bot_event_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`rule_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bot_event_subscriptions_bot_status` ON `bot_event_subscriptions` (`bot_id`,`status`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bot_inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`event_id` text NOT NULL,
	`processing_session_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`result_text` text,
	`result_delivery_status` text DEFAULT 'none' NOT NULL,
	`result_delivery_error` text,
	`received_at` integer NOT NULL,
	`started_at` integer,
	`handled_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `bot_event_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `bot_session_event_ledger`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`processing_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_bot_inbox_subscription_event` ON `bot_inbox_items` (`subscription_id`,`event_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bot_inbox_bot_status_received` ON `bot_inbox_items` (`bot_id`,`status`,`received_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bot_inbox_processing_session` ON `bot_inbox_items` (`processing_session_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `bot_session_event_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`event_key` text NOT NULL,
	`session_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`origin_bot_id` text,
	`lineage_json` text DEFAULT '[]' NOT NULL,
	`hop_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_bot_session_event_ledger_key` ON `bot_session_event_ledger` (`event_key`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bot_session_event_ledger_session_created` ON `bot_session_event_ledger` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_bot_session_event_ledger_type_created` ON `bot_session_event_ledger` (`event_type`,`created_at`);
