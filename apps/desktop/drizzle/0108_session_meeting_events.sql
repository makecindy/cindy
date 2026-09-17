CREATE TABLE `session_meeting_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`meeting_id` text NOT NULL,
	`session_id` text NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`terminal` integer NOT NULL,
	`snapshot` text,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_meeting_events_revision_idx` ON `session_meeting_events` (`meeting_id`,`kind`,`revision`);--> statement-breakpoint
CREATE INDEX `session_meeting_events_session_idx` ON `session_meeting_events` (`session_id`,`id`);