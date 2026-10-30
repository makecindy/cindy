CREATE TABLE `auto_review_projections` (
	`session_id` text NOT NULL,
	`lead_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`projected_revision` integer DEFAULT -1 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`payload` text,
	PRIMARY KEY(`session_id`, `lead_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lead_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `auto_review_projections_lead_idx` ON `auto_review_projections` (`lead_id`);