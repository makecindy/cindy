CREATE TABLE `group_task_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`delivery_seq` integer NOT NULL,
	`action` text NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`reviewer` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `group_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_group_task_acceptances_task_seq` ON `group_task_acceptances` (`task_id`,`delivery_seq`);--> statement-breakpoint
CREATE TABLE `group_task_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`author` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `group_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_group_task_comments_task_created` ON `group_task_comments` (`task_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `group_task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on_task_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_task_id`),
	FOREIGN KEY (`task_id`) REFERENCES `group_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_task_id`) REFERENCES `group_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `group_task_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`assignee_id` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`dispatched_at` integer NOT NULL,
	`started_at` integer,
	`settled_at` integer,
	`outcome` text,
	FOREIGN KEY (`task_id`) REFERENCES `group_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_group_task_runs_task_status` ON `group_task_runs` (`task_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_group_task_runs_active_per_task` ON `group_task_runs` (`task_id`) WHERE "group_task_runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE TABLE `group_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`group_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'todo' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`assignee_id` text,
	`created_by` text DEFAULT '' NOT NULL,
	`parent_task_id` text,
	`sort_order` real DEFAULT 0 NOT NULL,
	`due_at` integer,
	`estimate_hours` real,
	`labels_json` text DEFAULT '[]' NOT NULL,
	`delivery_seq` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`completed_at` integer,
	`canceled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `bot_groups`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_task_id`) REFERENCES `group_tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_group_tasks_group_number` ON `group_tasks` (`group_id`,`number`);--> statement-breakpoint
CREATE INDEX `idx_group_tasks_group_status` ON `group_tasks` (`group_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_group_tasks_parent` ON `group_tasks` (`parent_task_id`);