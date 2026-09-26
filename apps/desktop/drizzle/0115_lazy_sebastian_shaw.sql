CREATE TABLE `plugin_task_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`plugin_id` text NOT NULL,
	`operation` text NOT NULL,
	`target_id` text NOT NULL,
	`request_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`payload` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugin_task_request_key` ON `plugin_task_requests` (`plugin_id`,`operation`,`target_id`,`request_key`);--> statement-breakpoint
CREATE INDEX `plugin_task_target` ON `plugin_task_requests` (`target_id`,`plugin_id`);