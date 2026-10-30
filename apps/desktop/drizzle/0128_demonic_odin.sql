CREATE TABLE `plugin_usage_events` (
	`call_id` text PRIMARY KEY NOT NULL,
	`subject_id` text NOT NULL,
	`history_generation` integer NOT NULL,
	`occurred_at` integer NOT NULL,
	`tool_name` text NOT NULL,
	`session_id` text,
	`version` text,
	`release_id` text,
	`outcome` text DEFAULT 'unknown' NOT NULL,
	`report_target` text,
	`report_state` text DEFAULT 'not-applicable' NOT NULL,
	`next_attempt_at` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `plugin_usage_subjects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `plugin_usage_events_time_idx` ON `plugin_usage_events` (`subject_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `plugin_usage_events_task_idx` ON `plugin_usage_events` (`subject_id`,`session_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `plugin_usage_events_pending_idx` ON `plugin_usage_events` (`next_attempt_at`,`occurred_at`) WHERE "plugin_usage_events"."report_state" = 'pending';--> statement-breakpoint
CREATE TABLE `plugin_usage_subjects` (
	`id` text PRIMARY KEY NOT NULL,
	`stable_key` text,
	`source_kind` text NOT NULL,
	`plugin_id` text,
	`organization_id` text,
	`source_key` text,
	`server_root` text,
	`ghost_id` text NOT NULL,
	`display_name` text NOT NULL,
	`binding_revision` text,
	`recording_started_at` integer NOT NULL,
	`history_generation` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_usage_subjects_source_idx` ON `plugin_usage_subjects` (`stable_key`);--> statement-breakpoint
CREATE INDEX `plugin_usage_subjects_binding_idx` ON `plugin_usage_subjects` (`ghost_id`,`binding_revision`);