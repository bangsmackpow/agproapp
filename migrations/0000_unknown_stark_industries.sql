CREATE TABLE `application_fees` (
	`id` text PRIMARY KEY NOT NULL,
	`method` text NOT NULL,
	`label` text NOT NULL,
	`price_per_acre_cents` integer NOT NULL,
	`crop` text,
	`effective_from` integer NOT NULL,
	`effective_to` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `application_fees_method_idx` ON `application_fees` (`method`);--> statement-breakpoint
CREATE INDEX `application_fees_effective_idx` ON `application_fees` (`effective_from`);--> statement-breakpoint
CREATE TABLE `application_programs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`crop` text DEFAULT 'other' NOT NULL,
	`stage` text DEFAULT 'other' NOT NULL,
	`pass_count` integer DEFAULT 1 NOT NULL,
	`trait_system` text,
	`default_application_method` text DEFAULT 'drone' NOT NULL,
	`season_year` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `application_programs_name_season_unique` ON `application_programs` (`name`,`season_year`);--> statement-breakpoint
CREATE INDEX `application_programs_crop_stage_idx` ON `application_programs` (`crop`,`stage`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_user_id` text,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text,
	`metadata` text,
	`ip_address` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_user_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_entity_idx` ON `audit_logs` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `bank_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`bank_name` text,
	`routing_number` text,
	`account_number_last4` text,
	`next_check_number` integer DEFAULT 1001 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `bank_accounts_name_unique` ON `bank_accounts` (`name`);--> statement-breakpoint
CREATE TABLE `check_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`check_id` text NOT NULL,
	`vendor_bill_id` text,
	`amount_cents` integer NOT NULL,
	`note` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`check_id`) REFERENCES `checks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vendor_bill_id`) REFERENCES `vendor_bills`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `check_allocations_check_idx` ON `check_allocations` (`check_id`);--> statement-breakpoint
CREATE INDEX `check_allocations_bill_idx` ON `check_allocations` (`vendor_bill_id`);--> statement-breakpoint
CREATE TABLE `checks` (
	`id` text PRIMARY KEY NOT NULL,
	`bank_account_id` text NOT NULL,
	`check_number` integer NOT NULL,
	`payee_vendor_id` text,
	`payee_name` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`memo` text,
	`payment_date` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`payment_descriptor` text,
	`printed_at` integer,
	`voided_at` integer,
	`void_reason` text,
	`created_by_user_id` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`bank_account_id`) REFERENCES `bank_accounts`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`payee_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `checks_account_number_unique` ON `checks` (`bank_account_id`,`check_number`);--> statement-breakpoint
CREATE INDEX `checks_payee_idx` ON `checks` (`payee_vendor_id`);--> statement-breakpoint
CREATE INDEX `checks_status_idx` ON `checks` (`status`);--> statement-breakpoint
CREATE INDEX `checks_payment_date_idx` ON `checks` (`payment_date`);--> statement-breakpoint
CREATE TABLE `company_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`legal_name` text DEFAULT 'AG Pro Solutions LLC' NOT NULL,
	`display_name` text DEFAULT 'AG Pro Solutions' NOT NULL,
	`address_line1` text DEFAULT '1200 E Howard St' NOT NULL,
	`address_line2` text,
	`city` text DEFAULT 'Creston' NOT NULL,
	`state` text DEFAULT 'IA' NOT NULL,
	`postal_code` text DEFAULT '50801' NOT NULL,
	`country` text DEFAULT 'US' NOT NULL,
	`phone` text,
	`email` text,
	`website` text,
	`ein` text,
	`pesticide_license_number` text,
	`default_tax_rate` real DEFAULT 0 NOT NULL,
	`invoice_terms_days` integer DEFAULT 30 NOT NULL,
	`default_currency` text DEFAULT 'USD' NOT NULL,
	`check_template_config` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_number` text NOT NULL,
	`name` text NOT NULL,
	`contact_name` text,
	`phone` text,
	`email` text,
	`bill_line1` text,
	`bill_line2` text,
	`bill_city` text,
	`bill_state` text,
	`bill_postal_code` text,
	`ship_line1` text,
	`ship_line2` text,
	`ship_city` text,
	`ship_state` text,
	`ship_postal_code` text,
	`pesticide_license_number` text,
	`pesticide_license_expires_at` integer,
	`resale_certificate_number` text,
	`tax_exempt` integer DEFAULT false NOT NULL,
	`default_terms_days` integer,
	`credit_limit_cents` integer,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_account_number_unique` ON `customers` (`account_number`);--> statement-breakpoint
CREATE INDEX `customers_name_idx` ON `customers` (`name`);--> statement-breakpoint
CREATE INDEX `customers_phone_idx` ON `customers` (`phone`);--> statement-breakpoint
CREATE TABLE `documents` (
	`id` text PRIMARY KEY NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`doc_type` text DEFAULT 'other' NOT NULL,
	`vendor_id` text,
	`customer_id` text,
	`uploaded_by_user_id` text,
	`page_count` integer,
	`checksum_sha256` text,
	`parsed_payload` text,
	`parsed_at` integer,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_r2_key_unique` ON `documents` (`r2_key`);--> statement-breakpoint
CREATE INDEX `documents_doc_type_idx` ON `documents` (`doc_type`);--> statement-breakpoint
CREATE INDEX `documents_vendor_idx` ON `documents` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `documents_customer_idx` ON `documents` (`customer_id`);--> statement-breakpoint
CREATE TABLE `drone_units` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`serial_number` text NOT NULL,
	`status` text DEFAULT 'in_stock' NOT NULL,
	`cost_cents` integer,
	`warranty_expires_at` integer,
	`lot_id` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lot_id`) REFERENCES `inventory_lots`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drone_units_serial_unique` ON `drone_units` (`serial_number`);--> statement-breakpoint
CREATE INDEX `drone_units_product_idx` ON `drone_units` (`product_id`);--> statement-breakpoint
CREATE INDEX `drone_units_status_idx` ON `drone_units` (`status`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`vendor_id` text,
	`document_id` text,
	`doc_type` text DEFAULT 'other' NOT NULL,
	`parser_key` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`committed_count` integer DEFAULT 0 NOT NULL,
	`uploaded_by_user_id` text,
	`committed_at` integer,
	`committed_by_user_id` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`committed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `import_batches_status_idx` ON `import_batches` (`status`);--> statement-breakpoint
CREATE INDEX `import_batches_vendor_idx` ON `import_batches` (`vendor_id`);--> statement-breakpoint
CREATE INDEX `import_batches_document_idx` ON `import_batches` (`document_id`);--> statement-breakpoint
CREATE TABLE `import_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`target` text NOT NULL,
	`line_number` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`confidence` real,
	`raw_payload` text,
	`parsed_payload` text,
	`issues` text,
	`committed_record_id` text,
	`reviewed_by_user_id` text,
	`reviewed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `import_drafts_batch_idx` ON `import_drafts` (`batch_id`);--> statement-breakpoint
CREATE INDEX `import_drafts_status_idx` ON `import_drafts` (`status`);--> statement-breakpoint
CREATE TABLE `inventory_lots` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`warehouse_id` text,
	`lot_number` text,
	`seed_number` text,
	`expiration_date` integer,
	`quantity_on_hand` real DEFAULT 0 NOT NULL,
	`quantity_reserved` real DEFAULT 0 NOT NULL,
	`unit_cost_cents` integer,
	`received_at` integer,
	`source_vendor_id` text,
	`source_document_id` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `inventory_lots_product_idx` ON `inventory_lots` (`product_id`);--> statement-breakpoint
CREATE INDEX `inventory_lots_warehouse_idx` ON `inventory_lots` (`warehouse_id`);--> statement-breakpoint
CREATE INDEX `inventory_lots_lot_idx` ON `inventory_lots` (`lot_number`);--> statement-breakpoint
CREATE INDEX `inventory_lots_seed_idx` ON `inventory_lots` (`seed_number`);--> statement-breakpoint
CREATE TABLE `invoice_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`method` text NOT NULL,
	`destination` text,
	`provider_message_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`sent_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invoice_deliveries_invoice_idx` ON `invoice_deliveries` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `invoice_deliveries_status_idx` ON `invoice_deliveries` (`status`);--> statement-breakpoint
CREATE TABLE `invoice_items` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`line_type` text NOT NULL,
	`product_id` text,
	`program_id` text,
	`application_fee_id` text,
	`application_method` text,
	`description` text NOT NULL,
	`quantity` real DEFAULT 1 NOT NULL,
	`unit` text,
	`acres` real,
	`unit_price_cents` integer NOT NULL,
	`unit_cost_cents` integer,
	`margin_percent` real,
	`line_subtotal_cents` integer NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`taxable` integer DEFAULT true NOT NULL,
	`lot_number` text,
	`compliance_log_id` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`program_id`) REFERENCES `application_programs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`application_fee_id`) REFERENCES `application_fees`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`compliance_log_id`) REFERENCES `iowa_compliance_logs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `invoice_items_invoice_idx` ON `invoice_items` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `invoice_items_product_idx` ON `invoice_items` (`product_id`);--> statement-breakpoint
CREATE INDEX `invoice_items_program_idx` ON `invoice_items` (`program_id`);--> statement-breakpoint
CREATE TABLE `invoice_sequences` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`prefix` text DEFAULT 'INV' NOT NULL,
	`next_number` integer DEFAULT 1001 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_sequences_scope_unique` ON `invoice_sequences` (`scope`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_number` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`pricing_tier_id` text,
	`pricing_tier_key` text,
	`issue_date` integer NOT NULL,
	`due_date` integer,
	`terms_days` integer,
	`po_number` text,
	`customer_name` text NOT NULL,
	`bill_line1` text,
	`bill_line2` text,
	`bill_city` text,
	`bill_state` text,
	`bill_postal_code` text,
	`ship_line1` text,
	`ship_line2` text,
	`ship_city` text,
	`ship_state` text,
	`ship_postal_code` text,
	`service_acres` real,
	`application_method` text,
	`subtotal_cents` integer DEFAULT 0 NOT NULL,
	`discount_cents` integer DEFAULT 0 NOT NULL,
	`tax_rate` real DEFAULT 0 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`amount_paid_cents` integer DEFAULT 0 NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`compliance_verified_at` integer,
	`compliance_verified_by_user_id` text,
	`notes` text,
	`internal_notes` text,
	`created_by_user_id` text,
	`sent_at` integer,
	`paid_at` integer,
	`canceled_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`pricing_tier_id`) REFERENCES `price_tiers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`compliance_verified_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_number_unique` ON `invoices` (`invoice_number`);--> statement-breakpoint
CREATE INDEX `invoices_customer_idx` ON `invoices` (`customer_id`);--> statement-breakpoint
CREATE INDEX `invoices_status_idx` ON `invoices` (`status`);--> statement-breakpoint
CREATE INDEX `invoices_issue_date_idx` ON `invoices` (`issue_date`);--> statement-breakpoint
CREATE TABLE `iowa_compliance_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`product_id` text,
	`bol_cmr_number` text,
	`order_number` text,
	`seed_number` text,
	`shipper_number` text,
	`po_number` text,
	`lot_number` text,
	`quantity` real,
	`unit` text,
	`purchase_date` integer,
	`source` text DEFAULT 'manual' NOT NULL,
	`document_id` text,
	`verified` integer DEFAULT false NOT NULL,
	`verified_by_user_id` text,
	`verified_at` integer,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`verified_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `iowa_compliance_tokens_unique` ON `iowa_compliance_logs` (`bol_cmr_number`,`order_number`,`lot_number`);--> statement-breakpoint
CREATE INDEX `iowa_compliance_customer_idx` ON `iowa_compliance_logs` (`customer_id`);--> statement-breakpoint
CREATE INDEX `iowa_compliance_product_idx` ON `iowa_compliance_logs` (`product_id`);--> statement-breakpoint
CREATE INDEX `iowa_compliance_verified_idx` ON `iowa_compliance_logs` (`verified`);--> statement-breakpoint
CREATE TABLE `price_tiers` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`description` text,
	`multiplier` real NOT NULL,
	`requires_application` integer DEFAULT false NOT NULL,
	`requires_pesticide_license` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_tiers_key_unique` ON `price_tiers` (`key`);--> statement-breakpoint
CREATE INDEX `price_tiers_sort_idx` ON `price_tiers` (`sort_order`);--> statement-breakpoint
CREATE TABLE `product_costs` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`cost_cents` integer NOT NULL,
	`unit` text,
	`effective_from` integer NOT NULL,
	`effective_to` integer,
	`source_vendor_id` text,
	`source_document_id` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `product_costs_product_idx` ON `product_costs` (`product_id`);--> statement-breakpoint
CREATE INDEX `product_costs_from_idx` ON `product_costs` (`effective_from`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`sku` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`brand` text,
	`manufacturer` text,
	`unit` text DEFAULT 'each' NOT NULL,
	`package_size` text,
	`category` text,
	`epa_number` text,
	`pesticide_type` text,
	`active_ingredient` text,
	`density` real,
	`state_restrictions` text,
	`is_regulated_seed` integer DEFAULT false NOT NULL,
	`seed_trait_system` text,
	`is_serialized` integer DEFAULT false NOT NULL,
	`financed_app_price_cents` integer,
	`cash_app_price_cents` integer,
	`carry_price_cents` integer,
	`default_cost_cents` integer,
	`taxable` integer DEFAULT true NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_sku_unique` ON `products` (`sku`);--> statement-breakpoint
CREATE INDEX `products_name_idx` ON `products` (`name`);--> statement-breakpoint
CREATE INDEX `products_type_idx` ON `products` (`type`);--> statement-breakpoint
CREATE INDEX `products_epa_idx` ON `products` (`epa_number`);--> statement-breakpoint
CREATE TABLE `program_ingredients` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`product_id` text,
	`product_name_raw` text,
	`rate_per_acre` real,
	`rate_unit` text,
	`cost_per_acre_cents` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `application_programs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `program_ingredients_program_idx` ON `program_ingredients` (`program_id`);--> statement-breakpoint
CREATE INDEX `program_ingredients_product_idx` ON `program_ingredients` (`product_id`);--> statement-breakpoint
CREATE TABLE `program_prices` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`tier_id` text NOT NULL,
	`price_per_acre_cents` integer NOT NULL,
	`cost_per_acre_cents` integer,
	`multiplier_applied` real,
	`effective_from` integer NOT NULL,
	`effective_to` integer,
	`source_sheet` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `application_programs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tier_id`) REFERENCES `price_tiers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_prices_unique` ON `program_prices` (`program_id`,`tier_id`,`effective_from`);--> statement-breakpoint
CREATE INDEX `program_prices_tier_idx` ON `program_prices` (`tier_id`);--> statement-breakpoint
CREATE INDEX `program_prices_effective_idx` ON `program_prices` (`effective_from`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`revoked_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'sales' NOT NULL,
	`phone` text,
	`is_active` integer DEFAULT true NOT NULL,
	`last_login_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE INDEX `users_role_idx` ON `users` (`role`);--> statement-breakpoint
CREATE TABLE `vendor_bill_items` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_bill_id` text NOT NULL,
	`product_id` text,
	`item_code` text,
	`description` text NOT NULL,
	`quantity` real,
	`unit` text,
	`unit_cost_cents` integer,
	`amount_cents` integer,
	`epa_number` text,
	`lot_number` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`vendor_bill_id`) REFERENCES `vendor_bills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `vendor_bill_items_bill_idx` ON `vendor_bill_items` (`vendor_bill_id`);--> statement-breakpoint
CREATE INDEX `vendor_bill_items_product_idx` ON `vendor_bill_items` (`product_id`);--> statement-breakpoint
CREATE TABLE `vendor_bills` (
	`id` text PRIMARY KEY NOT NULL,
	`vendor_id` text NOT NULL,
	`bill_number` text NOT NULL,
	`po_reference` text,
	`bill_date` integer NOT NULL,
	`due_date` integer,
	`terms_days` integer,
	`subtotal_cents` integer DEFAULT 0 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`balance_cents` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`document_id` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendor_bills_vendor_number_unique` ON `vendor_bills` (`vendor_id`,`bill_number`);--> statement-breakpoint
CREATE INDEX `vendor_bills_status_idx` ON `vendor_bills` (`status`);--> statement-breakpoint
CREATE INDEX `vendor_bills_due_idx` ON `vendor_bills` (`due_date`);--> statement-breakpoint
CREATE TABLE `vendors` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`contact_name` text,
	`phone` text,
	`email` text,
	`address_line1` text,
	`address_line2` text,
	`city` text,
	`state` text,
	`postal_code` text,
	`account_number` text,
	`default_terms_days` integer,
	`default_payment_method` text,
	`is_active` integer DEFAULT true NOT NULL,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vendors_code_unique` ON `vendors` (`code`);--> statement-breakpoint
CREATE INDEX `vendors_name_idx` ON `vendors` (`name`);--> statement-breakpoint
CREATE TABLE `warehouses` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`address_line1` text,
	`city` text,
	`state` text,
	`postal_code` text,
	`is_default` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warehouses_code_unique` ON `warehouses` (`code`);