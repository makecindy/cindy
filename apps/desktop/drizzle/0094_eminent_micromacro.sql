CREATE TABLE `bot_automation_links` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`schedule_id` text,
	`project_binding_id` text,
	`target_route_id` text,
	`created_with_profile_version` integer NOT NULL,
	`durable_note_namespace` text,
	`execution_policy_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`suspended_status` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`schedule_id`) REFERENCES `schedules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_binding_id`) REFERENCES `bot_project_bindings`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`target_route_id`) REFERENCES `bot_routes`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_automation_links_schedule` ON `bot_automation_links` (`schedule_id`);--> statement-breakpoint
CREATE INDEX `idx_bot_automation_links_bot_status` ON `bot_automation_links` (`bot_id`,`status`);--> statement-breakpoint
CREATE TABLE `bot_automation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`automation_link_id` text NOT NULL,
	`schedule_run_id` text,
	`session_id` text,
	`workspace_lease_id` text,
	`profile_version` integer NOT NULL,
	`project_binding_id_snapshot` text,
	`target_route_id_snapshot` text,
	`target_route_owner_generation_snapshot` integer,
	`working_dir_snapshot` text,
	`remote_host_id_snapshot` text,
	`worktree_path_snapshot` text,
	`delivery_outbox_id` text,
	`delivery_status` text DEFAULT 'not-requested' NOT NULL,
	`delivery_error` text,
	`result_text_snapshot` text,
	`output_artifacts_json` text DEFAULT '[]' NOT NULL,
	`error_message` text,
	`execution_plan_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'claimed' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`automation_link_id`) REFERENCES `bot_automation_links`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`schedule_run_id`) REFERENCES `schedule_runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`workspace_lease_id`) REFERENCES `bot_workspace_leases`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`delivery_outbox_id`) REFERENCES `bot_delivery_outbox`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_automation_runs_schedule_run` ON `bot_automation_runs` (`schedule_run_id`);--> statement-breakpoint
CREATE INDEX `idx_bot_automation_runs_link_created` ON `bot_automation_runs` (`automation_link_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_channels` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`kind` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`config_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bot_channels_bot_kind` ON `bot_channels` (`bot_id`,`kind`);--> statement-breakpoint
CREATE INDEX `idx_bot_channels_enabled` ON `bot_channels` (`enabled`);--> statement-breakpoint
CREATE TABLE `bot_delegations` (
	`id` text PRIMARY KEY NOT NULL,
	`requesting_bot_id` text NOT NULL,
	`target_bot_id` text NOT NULL,
	`parent_session_id` text,
	`child_session_id` text,
	`objective` text NOT NULL,
	`context_refs_json` text DEFAULT '[]' NOT NULL,
	`artifact_refs_json` text DEFAULT '[]' NOT NULL,
	`permission_snapshot_json` text DEFAULT '{}' NOT NULL,
	`lineage_json` text DEFAULT '[]' NOT NULL,
	`target_profile_version` integer NOT NULL,
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
CREATE TABLE `bot_delivery_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`channel_id` text,
	`route_id` text,
	`session_id` text,
	`idempotency_key` text NOT NULL,
	`payload_ref_json` text DEFAULT '{}' NOT NULL,
	`owner_generation` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`last_error` text,
	`delivery_receipt_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `bot_channels`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`route_id`) REFERENCES `bot_routes`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_delivery_outbox_idempotency` ON `bot_delivery_outbox` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_bot_delivery_outbox_due` ON `bot_delivery_outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_bot_delivery_outbox_route_created` ON `bot_delivery_outbox` (`route_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_durable_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`namespace` text NOT NULL,
	`note_key` text NOT NULL,
	`value_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_durable_notes_bot_namespace_key` ON `bot_durable_notes` (`bot_id`,`namespace`,`note_key`);--> statement-breakpoint
CREATE INDEX `idx_bot_durable_notes_bot_namespace` ON `bot_durable_notes` (`bot_id`,`namespace`);--> statement-breakpoint
CREATE TABLE `bot_event_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`rule_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_bot_event_subscriptions_bot_status` ON `bot_event_subscriptions` (`bot_id`,`status`);--> statement-breakpoint
CREATE TABLE `bot_im_migration_items` (
	`id` text PRIMARY KEY NOT NULL,
	`migration_id` text NOT NULL,
	`session_id` text NOT NULL,
	`original_status` text NOT NULL,
	`history_link_created` integer DEFAULT false NOT NULL,
	`session_archived` integer DEFAULT false NOT NULL,
	`applied_session_updated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`rolled_back_at` integer,
	FOREIGN KEY (`migration_id`) REFERENCES `bot_im_migrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_im_migration_items_batch_session` ON `bot_im_migration_items` (`migration_id`,`session_id`);--> statement-breakpoint
CREATE INDEX `idx_bot_im_migration_items_session` ON `bot_im_migration_items` (`session_id`);--> statement-breakpoint
CREATE TABLE `bot_im_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`bot_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`route_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`ownership` text NOT NULL,
	`kind` text NOT NULL,
	`account_key` text NOT NULL,
	`plan_hash` text NOT NULL,
	`status` text DEFAULT 'applying' NOT NULL,
	`channel_before_json` text,
	`route_before_json` text,
	`adapter_bindings_json` text DEFAULT '[]' NOT NULL,
	`error_json` text,
	`created_at` integer NOT NULL,
	`applied_at` integer,
	`rolled_back_at` integer,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `bot_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`route_id`) REFERENCES `bot_routes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_im_migrations_request` ON `bot_im_migrations` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_bot_im_migrations_bot_created` ON `bot_im_migrations` (`bot_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_bot_im_migrations_connection_status` ON `bot_im_migrations` (`connection_id`,`status`);--> statement-breakpoint
CREATE TABLE `bot_inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`event_id` text NOT NULL,
	`processing_session_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`result_text` text,
	`result_delivery_status` text DEFAULT 'none' NOT NULL,
	`result_delivery_error` text,
	`received_at` integer NOT NULL,
	`started_at` integer,
	`handled_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_id`) REFERENCES `bot_event_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `bot_session_event_ledger`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`processing_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_inbox_subscription_event` ON `bot_inbox_items` (`subscription_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `idx_bot_inbox_bot_status_received` ON `bot_inbox_items` (`bot_id`,`status`,`received_at`);--> statement-breakpoint
CREATE INDEX `idx_bot_inbox_processing_session` ON `bot_inbox_items` (`processing_session_id`);--> statement-breakpoint
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
	`current_version` integer DEFAULT 1 NOT NULL,
	`canonical_session_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`canonical_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_bot_profiles_status_updated` ON `bot_profiles` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_bot_profiles_canonical_session` ON `bot_profiles` (`canonical_session_id`);--> statement-breakpoint
CREATE TABLE `bot_project_bindings` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`project_key` text NOT NULL,
	`working_dir` text NOT NULL,
	`remote_host_id` text,
	`default_branch` text,
	`workspace_policy` text DEFAULT 'none' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`allowed_paths_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_project_bindings_bot_project` ON `bot_project_bindings` (`bot_id`,`project_key`);--> statement-breakpoint
CREATE INDEX `idx_bot_project_bindings_bot_status` ON `bot_project_bindings` (`bot_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_project_bindings_default_per_bot` ON `bot_project_bindings` (`bot_id`) WHERE "bot_project_bindings"."is_default" = true AND "bot_project_bindings"."status" = 'active';--> statement-breakpoint
CREATE TABLE `bot_routes` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`route_key` text NOT NULL,
	`principal_key` text NOT NULL,
	`scope_key` text NOT NULL,
	`thread_key` text,
	`current_session_id` text,
	`project_binding_id` text,
	`capabilities_json` text DEFAULT '{}' NOT NULL,
	`owner_device_id` text,
	`owner_generation` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`suspended_status` text,
	`last_activity_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `bot_channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`current_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_binding_id`) REFERENCES `bot_project_bindings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_routes_channel_route` ON `bot_routes` (`channel_id`,`route_key`);--> statement-breakpoint
CREATE INDEX `idx_bot_routes_bot_status` ON `bot_routes` (`bot_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_bot_routes_session` ON `bot_routes` (`current_session_id`);--> statement-breakpoint
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
CREATE TABLE `bot_session_event_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`event_key` text NOT NULL,
	`session_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`origin_bot_id` text,
	`lineage_json` text DEFAULT '[]' NOT NULL,
	`hop_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_session_event_ledger_key` ON `bot_session_event_ledger` (`event_key`);--> statement-breakpoint
CREATE INDEX `idx_bot_session_event_ledger_session_created` ON `bot_session_event_ledger` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_bot_session_event_ledger_type_created` ON `bot_session_event_ledger` (`event_type`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_session_links` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`session_id` text NOT NULL,
	`profile_version` integer DEFAULT 1 NOT NULL,
	`role` text NOT NULL,
	`channel_id` text,
	`route_key` text,
	`created_at` integer NOT NULL,
	`archived_at` integer,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `bot_channels`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_session_links_session` ON `bot_session_links` (`session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_session_links_canonical_per_bot` ON `bot_session_links` (`bot_id`) WHERE "bot_session_links"."role" = 'canonical';--> statement-breakpoint
CREATE INDEX `idx_bot_session_links_bot_role` ON `bot_session_links` (`bot_id`,`role`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_session_links_route` ON `bot_session_links` (`channel_id`,`route_key`) WHERE "bot_session_links"."role" = 'route' AND "bot_session_links"."channel_id" IS NOT NULL AND "bot_session_links"."route_key" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `bot_workspace_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`lease_id` text NOT NULL,
	`session_id` text NOT NULL,
	`generation` integer NOT NULL,
	`access` text DEFAULT 'read-write' NOT NULL,
	`created_at` integer NOT NULL,
	`detached_at` integer,
	FOREIGN KEY (`lease_id`) REFERENCES `bot_workspace_leases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_workspace_attachments_lease_session` ON `bot_workspace_attachments` (`lease_id`,`session_id`,`generation`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_workspace_attachments_active_session` ON `bot_workspace_attachments` (`session_id`) WHERE "bot_workspace_attachments"."detached_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_bot_workspace_attachments_lease_active` ON `bot_workspace_attachments` (`lease_id`,`detached_at`);--> statement-breakpoint
CREATE TABLE `bot_workspace_leases` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_id` text NOT NULL,
	`project_binding_id` text NOT NULL,
	`lease_key` text DEFAULT 'shared' NOT NULL,
	`anchor_session_id` text,
	`worktree_path` text,
	`base_repo` text NOT NULL,
	`branch` text,
	`source_branch` text,
	`remote_host_id` text,
	`generation` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'acquiring' NOT NULL,
	`last_heartbeat_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`released_at` integer,
	FOREIGN KEY (`bot_id`) REFERENCES `bot_profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_binding_id`) REFERENCES `bot_project_bindings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`anchor_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_bot_workspace_leases_active_binding_key` ON `bot_workspace_leases` (`project_binding_id`,`lease_key`) WHERE "bot_workspace_leases"."status" IN ('acquiring', 'active', 'releasing');--> statement-breakpoint
CREATE INDEX `idx_bot_workspace_leases_bot_status` ON `bot_workspace_leases` (`bot_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_bot_workspace_leases_anchor_session` ON `bot_workspace_leases` (`anchor_session_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `right_sidebar_tabs_bot_delegations_singleton_idx` ON `right_sidebar_tabs` (`session_id`) WHERE "right_sidebar_tabs"."kind" = 'bot-delegations';--> statement-breakpoint
CREATE UNIQUE INDEX `right_sidebar_tabs_bot_artifacts_singleton_idx` ON `right_sidebar_tabs` (`session_id`) WHERE "right_sidebar_tabs"."kind" = 'bot-artifacts';