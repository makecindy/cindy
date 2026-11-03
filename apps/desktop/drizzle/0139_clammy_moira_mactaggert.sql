CREATE TABLE `session_imports` (
	`session_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_session_id` text NOT NULL,
	`source_fingerprint` text,
	`source_version` text,
	`mode` text NOT NULL,
	`status` text NOT NULL,
	`issue` text,
	`original_cwd` text,
	`request_id` text,
	`imported_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_session_imports_source` ON `session_imports` (`source`,`source_session_id`);