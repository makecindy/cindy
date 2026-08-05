PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `daily_model_usage` (
	`day` text NOT NULL,
	`agent_kind` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`cost_amount` real DEFAULT 0 NOT NULL,
	`cost_currency` text,
	`cost_is_approximate` integer DEFAULT false NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_create_tokens` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`day`, `agent_kind`, `model`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `daily_spend` (
	`day` text PRIMARY KEY NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`cost_amount` real DEFAULT 0 NOT NULL,
	`cost_currency` text,
	`cost_is_approximate` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `__new_daily_model_usage` (
	`day` text NOT NULL,
	`agent_kind` text NOT NULL,
	`model` text NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`cost_amount` real DEFAULT 0 NOT NULL,
	`cost_currency` text DEFAULT 'USD' NOT NULL,
	`cost_is_approximate` integer DEFAULT false NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_create_tokens` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`day`, `agent_kind`, `model`, `cost_currency`)
);
--> statement-breakpoint
INSERT INTO `__new_daily_model_usage`("day", "agent_kind", "model", "cost_usd", "cost_amount", "cost_currency", "cost_is_approximate", "input_tokens", "output_tokens", "cache_read_tokens", "cache_create_tokens", "updated_at") SELECT "day", "agent_kind", "model", "cost_usd", "cost_amount", COALESCE("cost_currency", 'USD'), "cost_is_approximate", "input_tokens", "output_tokens", "cache_read_tokens", "cache_create_tokens", "updated_at" FROM `daily_model_usage`;--> statement-breakpoint
DROP TABLE `daily_model_usage`;--> statement-breakpoint
ALTER TABLE `__new_daily_model_usage` RENAME TO `daily_model_usage`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_daily_spend` (
	`day` text NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL,
	`cost_amount` real DEFAULT 0 NOT NULL,
	`cost_currency` text DEFAULT 'USD' NOT NULL,
	`cost_is_approximate` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`day`, `cost_currency`)
);
--> statement-breakpoint
INSERT INTO `__new_daily_spend`("day", "cost_usd", "cost_amount", "cost_currency", "cost_is_approximate", "updated_at") SELECT "day", "cost_usd", "cost_amount", COALESCE("cost_currency", 'USD'), "cost_is_approximate", "updated_at" FROM `daily_spend`;--> statement-breakpoint
DROP TABLE `daily_spend`;--> statement-breakpoint
ALTER TABLE `__new_daily_spend` RENAME TO `daily_spend`;