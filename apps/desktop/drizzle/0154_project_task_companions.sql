CREATE TABLE `project_task_companions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`bot_id` text,
	`revision` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
