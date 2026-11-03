CREATE TABLE `chat_cache_messages` (
	`namespace` text NOT NULL,
	`room_id` text NOT NULL,
	`message_id` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`namespace`, `room_id`, `message_id`)
);
--> statement-breakpoint
CREATE TABLE `chat_cache_rooms` (
	`namespace` text NOT NULL,
	`room_id` text NOT NULL,
	`state` text NOT NULL,
	`version` integer NOT NULL,
	PRIMARY KEY(`namespace`, `room_id`)
);
