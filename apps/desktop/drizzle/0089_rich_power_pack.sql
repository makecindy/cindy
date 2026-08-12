CREATE TABLE IF NOT EXISTS `subagent_run_aliases` (
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`alias` text NOT NULL,
	`run_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`run_id`, `alias`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `subagent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subagent_run_aliases_lookup_idx` ON `subagent_run_aliases` (`session_id`,`provider`,`alias`,`created_at`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `subagent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`provider` text NOT NULL,
	`logical_agent_id` text NOT NULL,
	`parent_tool_use_id` text,
	`aliases` text DEFAULT '[]' NOT NULL,
	`provider_run_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`title` text,
	`description` text,
	`summary` text,
	`model` text,
	`reasoning_effort` text,
	`total_tokens` integer,
	`tool_uses` integer,
	`duration_ms` integer,
	`capabilities` text DEFAULT '{}' NOT NULL,
	`activity` text DEFAULT '[]' NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ended_at` integer,
	`rewind_at` integer,
	`deleted_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subagent_runs_logical_idx` ON `subagent_runs` (`session_id`,`provider`,`logical_agent_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subagent_runs_session_idx` ON `subagent_runs` (`session_id`,`rewind_at`,`deleted_at`,`started_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `subagent_runs_parent_tool_use_idx` ON `subagent_runs` (`session_id`,`parent_tool_use_id`);
