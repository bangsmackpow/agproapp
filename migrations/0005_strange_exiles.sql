CREATE TABLE `customer_sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`prefix` text DEFAULT 'AGP' NOT NULL,
	`next_number` integer DEFAULT 57 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
-- The starting row lives here rather than in seed/0001_reference.sql. Seeds are
-- applied by hand, and invoice numbering already depends on one: a migrated-but-
-- unseeded database cannot write an invoice, which is a trap worth not repeating.
-- A fixed id keeps the row identifiable, mirroring the invoice sequence.
INSERT INTO `customer_sequences` (`id`, `prefix`, `next_number`)
VALUES ('40000000-0000-0000-0000-000000000002', 'AGP', 57);
