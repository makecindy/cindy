CREATE TABLE `session_control_requests` (
	`key` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`session_id` text NOT NULL,
	`input_id` text,
	`receipt` text,
	`created_at` integer NOT NULL
);
