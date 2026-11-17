CREATE TABLE `mcp_app_view_states` (
	`message_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`server_id` text NOT NULL,
	`server_revision` text NOT NULL,
	`plugin_instance` text,
	`state_json` text NOT NULL,
	`byte_length` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_app_view_states_session` ON `mcp_app_view_states` (`session_id`);