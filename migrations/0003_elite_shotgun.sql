CREATE TABLE `units` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`dimension` text NOT NULL,
	`factor_to_base` real DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `units_dimension_idx` ON `units` (`dimension`);