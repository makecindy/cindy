CREATE TABLE IF NOT EXISTS `wechat_file_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_epoch` text NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text,
	`abs_path` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`promoted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`binding_epoch`) REFERENCES `wechat_sync_state`(`binding_epoch`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `wechat_inbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_wechat_file_attachments_task` ON `wechat_file_attachments` (`binding_epoch`,`task_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wechat_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_epoch` text NOT NULL,
	`platform_message_id` text NOT NULL,
	`platform_seq` integer NOT NULL,
	`peer_id` text NOT NULL,
	`received_at` integer NOT NULL,
	`platform_created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lease_until` integer,
	`session_id` text,
	`conversation_epoch` integer DEFAULT 0 NOT NULL,
	`payload_json` text NOT NULL,
	`context_nonce` text NOT NULL,
	`context_ciphertext` text NOT NULL,
	`context_tag` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	FOREIGN KEY (`binding_epoch`) REFERENCES `wechat_sync_state`(`binding_epoch`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_wechat_inbox_platform_message` ON `wechat_inbox` (`binding_epoch`,`platform_message_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_wechat_inbox_queue` ON `wechat_inbox` (`binding_epoch`,`status`,`received_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_wechat_inbox_lease` ON `wechat_inbox` (`binding_epoch`,`lease_until`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_wechat_inbox_conversation` ON `wechat_inbox` (`binding_epoch`,`peer_id`,`conversation_epoch`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_wechat_inbox_running_session` ON `wechat_inbox` (`binding_epoch`,`session_id`) WHERE "wechat_inbox"."session_id" IS NOT NULL AND "wechat_inbox"."status" IN ('dispatching', 'accepted_running', 'waiting_desktop', 'delivery_pending');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wechat_outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`binding_epoch` text NOT NULL,
	`task_id` text NOT NULL,
	`client_id` text NOT NULL,
	`kind` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`text` text NOT NULL,
	`media_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`binding_epoch`) REFERENCES `wechat_sync_state`(`binding_epoch`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `wechat_inbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_wechat_outbox_client_id` ON `wechat_outbox` (`binding_epoch`,`client_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_wechat_outbox_delivery` ON `wechat_outbox` (`binding_epoch`,`status`,`next_retry_at`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_wechat_outbox_task` ON `wechat_outbox` (`binding_epoch`,`task_id`,`chunk_index`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `wechat_sync_state` (
	`binding_epoch` text PRIMARY KEY NOT NULL,
	`is_active` integer DEFAULT false NOT NULL,
	`sync_cursor` text DEFAULT '' NOT NULL,
	`last_poll_at` integer,
	`last_error_code` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_wechat_sync_active` ON `wechat_sync_state` (`is_active`) WHERE "wechat_sync_state"."is_active" = 1;
