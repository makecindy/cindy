CREATE TABLE `bot_existing_session_receipts` (
	`client_id` text PRIMARY KEY NOT NULL,
	`caller_session_id` text NOT NULL,
	`target_session_id` text NOT NULL,
	`message_sha256` text NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`caller_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
