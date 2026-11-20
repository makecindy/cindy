CREATE TABLE `token_reporting_first_day` (
	`provider` text NOT NULL,
	`billing` text NOT NULL,
	`model` text NOT NULL,
	`generation` text NOT NULL,
	`input` integer NOT NULL,
	`output` integer NOT NULL,
	`cache_read` integer NOT NULL,
	`cache_write` integer NOT NULL,
	PRIMARY KEY(`provider`, `billing`, `model`)
);
--> statement-breakpoint
CREATE TABLE `token_reporting_window` (
	`id` integer PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`day` text NOT NULL,
	`starts_at` integer NOT NULL
);
