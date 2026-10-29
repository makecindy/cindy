DROP INDEX `uniq_bot_task_origin_source`;--> statement-breakpoint
ALTER TABLE `bot_task_origins` ADD `request_id` text;--> statement-breakpoint
CREATE INDEX `idx_bot_task_origin_source` ON `bot_task_origins` (`source_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_task_origin_request` ON `bot_task_origins` (`request_id`);