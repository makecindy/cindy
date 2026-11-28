CREATE TABLE `daily_token_attribution` (
	`day` text NOT NULL,
	`provider` text NOT NULL,
	`billing_source` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_tokens` integer NOT NULL,
	`cache_create_tokens` integer NOT NULL,
	PRIMARY KEY(`day`, `provider`, `billing_source`, `model`)
);
