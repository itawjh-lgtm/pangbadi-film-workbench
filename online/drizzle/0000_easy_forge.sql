CREATE TABLE `records` (
	`owner` text NOT NULL,
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`body` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`request_id` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`owner`, `kind`, `id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `records_request` ON `records` (`owner`,`kind`,`request_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`owner` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`updated_at` integer NOT NULL
);
