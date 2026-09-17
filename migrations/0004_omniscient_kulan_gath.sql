CREATE TABLE `inventory_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`lot_id` text,
	`movement_type` text NOT NULL,
	`quantity_delta` real NOT NULL,
	`unit` text,
	`quantity_in_base` real NOT NULL,
	`unit_cost_cents` integer,
	`reference_type` text,
	`reference_id` text,
	`occurred_at` integer NOT NULL,
	`note` text,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`lot_id`) REFERENCES `inventory_lots`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `inventory_movements_product_idx` ON `inventory_movements` (`product_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `inventory_movements_lot_idx` ON `inventory_movements` (`lot_id`);--> statement-breakpoint
CREATE INDEX `inventory_movements_reference_idx` ON `inventory_movements` (`reference_type`,`reference_id`);--> statement-breakpoint
ALTER TABLE `products` ADD `base_unit_code` text;--> statement-breakpoint
ALTER TABLE `products` ADD `markup_percent` real DEFAULT 10 NOT NULL;