CREATE TABLE `shared_task_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`shared_task_id` text NOT NULL,
	`session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`terminal` integer NOT NULL,
	`snapshot` text,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shared_task_events_revision_idx` ON `shared_task_events` (`shared_task_id`,`kind`,`revision`);--> statement-breakpoint
CREATE INDEX `shared_task_events_session_idx` ON `shared_task_events` (`session_id`,`id`);