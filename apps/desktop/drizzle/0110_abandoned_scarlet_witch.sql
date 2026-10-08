CREATE TABLE `session_task_tags` (
	`session_id` text NOT NULL,
	`tag_id` text NOT NULL,
	PRIMARY KEY(`session_id`, `tag_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `task_tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_task_tags_tag_idx` ON `session_task_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `task_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`favorite_order` integer,
	`revision` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_tags_name_idx` ON `task_tags` (`name`);
--> statement-breakpoint
INSERT INTO task_tags(id,name,color,favorite_order) VALUES
('default:red','Red','red',0),
('default:orange','Orange','orange',1),
('default:yellow','Yellow','yellow',2),
('default:green','Green','green',3),
('default:blue','Blue','blue',4),
('default:purple','Purple','purple',5),
('default:gray','Gray','gray',6);
