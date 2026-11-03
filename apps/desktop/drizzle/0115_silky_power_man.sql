CREATE TABLE `daily_session_usage` (
	`day` text NOT NULL,
	`session_id` text NOT NULL,
	`tokens` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`day`, `session_id`)
);
