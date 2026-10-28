CREATE TABLE `custom_mcp_setup_receipts` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`server_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `custom_mcp_servers` ADD `credential_format` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `custom_mcp_servers` ADD `credential_ref` text;