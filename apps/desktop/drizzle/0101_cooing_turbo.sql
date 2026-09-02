CREATE TABLE `bot_delegations` (
	`id` text PRIMARY KEY NOT NULL,
	`requesting_bot_id` text NOT NULL,
	`target_bot_id` text,
	`parent_session_id` text,
	`child_session_id` text,
	`objective` text NOT NULL,
	`context_refs_json` text DEFAULT '[]' NOT NULL,
	`artifact_refs_json` text DEFAULT '[]' NOT NULL,
	`permission_snapshot_json` text DEFAULT '{}' NOT NULL,
	`lineage_json` text DEFAULT '[]' NOT NULL,
	`target_profile_version` integer,
	`depth` integer DEFAULT 1 NOT NULL,
	`budget_tokens` integer,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`result_summary` text,
	`output_artifacts_json` text DEFAULT '[]' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`accepted_at` integer,
	`completed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`requesting_bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`child_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_bot_delegations_requester_status` ON `bot_delegations` (`requesting_bot_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_bot_delegations_target_status` ON `bot_delegations` (`target_bot_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_bot_delegations_parent_session` ON `bot_delegations` (`parent_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_delegations_child_session` ON `bot_delegations` (`child_session_id`);--> statement-breakpoint
CREATE TABLE `bot_lifecycle_events` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`session_id` text,
	`event_type` text NOT NULL,
	`payload_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_bot_lifecycle_events_bot_created` ON `bot_lifecycle_events` (`bot_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_bot_lifecycle_events_session_created` ON `bot_lifecycle_events` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_profile_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`version` integer NOT NULL,
	`identity_source` text DEFAULT '' NOT NULL,
	`capabilities_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_profile_versions_bot_version` ON `bot_profile_versions` (`bot_id`,`version`);--> statement-breakpoint
CREATE INDEX `idx_bot_profile_versions_bot_created` ON `bot_profile_versions` (`bot_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`avatar` text DEFAULT '🤖' NOT NULL,
	`avatar_color` text DEFAULT 'violet' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`hidden_at` integer,
	`pinned_at` integer,
	`attention_reason` text,
	`attention_at` integer,
	`current_version` integer DEFAULT 1 NOT NULL,
	`canonical_session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`canonical_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_bot_profiles_status_updated` ON `bot_profiles` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_bot_profiles_canonical_session` ON `bot_profiles` (`canonical_session_id`);--> statement-breakpoint
CREATE TABLE `bot_runtime_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`session_id` text NOT NULL,
	`profile_version` integer NOT NULL,
	`agent_kind` text NOT NULL,
	`working_dir` text NOT NULL,
	`memory_scope_key` text,
	`configured_json` text DEFAULT '{}' NOT NULL,
	`resolved_json` text DEFAULT '{}' NOT NULL,
	`status` text NOT NULL,
	`prepared_at` integer DEFAULT 0 NOT NULL,
	`applied_at` integer,
	`failed_at` integer,
	`failure_json` text,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bot_runtime_snapshots_bot_prepared` ON `bot_runtime_snapshots` (`bot_id`,`prepared_at`);--> statement-breakpoint
CREATE INDEX `idx_bot_runtime_snapshots_session_prepared` ON `bot_runtime_snapshots` (`session_id`,`prepared_at`);--> statement-breakpoint
CREATE TABLE `bot_session_links` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`session_id` text NOT NULL,
	`profile_version` integer DEFAULT 1 NOT NULL,
	`role` text NOT NULL,
	`route_key` text,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_session_links_session` ON `bot_session_links` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_session_links_canonical_per_bot` ON `bot_session_links` (`bot_id`) WHERE "bot_session_links"."role" = 'canonical';--> statement-breakpoint
CREATE INDEX `idx_bot_session_links_bot_role` ON `bot_session_links` (`bot_id`,`role`);--> statement-breakpoint
CREATE UNIQUE INDEX `right_sidebar_tabs_bot_delegations_singleton_idx` ON `right_sidebar_tabs` (`session_id`) WHERE "right_sidebar_tabs"."kind" = 'bot-delegations';--> statement-breakpoint
CREATE UNIQUE INDEX `right_sidebar_tabs_bot_artifacts_singleton_idx` ON `right_sidebar_tabs` (`session_id`) WHERE "right_sidebar_tabs"."kind" = 'bot-artifacts';