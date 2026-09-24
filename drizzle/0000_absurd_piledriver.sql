CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`data` text NOT NULL,
	`at` integer NOT NULL,
	`op` text,
	`x` integer,
	`y` integer,
	`w` integer,
	`h` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_op_unique` ON `events` (`op`);--> statement-breakpoint
CREATE INDEX `events_at` ON `events` (`at`);--> statement-breakpoint
CREATE TABLE `pairs` (
	`hash` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`expires` integer NOT NULL,
	`redeemed` integer DEFAULT 0 NOT NULL,
	`receipt` text
);
--> statement-breakpoint
CREATE TABLE `quotas` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`used` integer DEFAULT 0 NOT NULL,
	`budget` integer NOT NULL,
	`next_write` integer DEFAULT 0 NOT NULL,
	`expires` integer NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`last_op` text
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`expires` integer NOT NULL
);
