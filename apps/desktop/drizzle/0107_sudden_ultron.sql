CREATE TABLE `im_notification_origins` (
	`channel` text NOT NULL,
	`bot_context_id` text NOT NULL,
	`user_id` text NOT NULL,
	`message_id` text NOT NULL,
	`chat_id` text NOT NULL,
	`session_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`channel`, `bot_context_id`, `user_id`, `message_id`)
);
