ALTER TABLE `session_pr_refs` ADD `association_source` text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
UPDATE `session_pr_refs` SET `association_source` = 'explicit' WHERE `manually_added` = 1 OR `pinned` = 1;
