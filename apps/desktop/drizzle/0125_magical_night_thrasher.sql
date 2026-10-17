CREATE TABLE IF NOT EXISTS `orca_remote_opens` (
	`remote_session_id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`created_at` integer NOT NULL
);
