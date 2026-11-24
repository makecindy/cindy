CREATE TABLE `dag_history_edits` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`client_id` text NOT NULL,
	`action` text NOT NULL,
	`state` text NOT NULL,
	`undo_data` text,
	`fingerprint` text NOT NULL,
	`created_at` integer NOT NULL
);
