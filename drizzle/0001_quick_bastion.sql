CREATE TABLE `aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain` text NOT NULL,
	`store_id` integer,
	`raw_text_normalized` text NOT NULL,
	`item_id` integer NOT NULL,
	`default_quantity` real,
	`default_unit` text,
	`source` text DEFAULT 'human' NOT NULL,
	`hit_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `aliases_key_idx` ON `aliases` (`domain`,`store_id`,`raw_text_normalized`);--> statement-breakpoint
CREATE TABLE `cook_session_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`recipe_ingredient_id` integer,
	`item_id` integer,
	`label` text NOT NULL,
	`proposed_quantity_base` real,
	`unit_family` text,
	`action` text,
	FOREIGN KEY (`session_id`) REFERENCES `cook_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipe_ingredient_id`) REFERENCES `recipe_ingredients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cook_session_lines_session_idx` ON `cook_session_lines` (`session_id`);--> statement-breakpoint
CREATE TABLE `cook_sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`servings` integer,
	`cooked_at` integer NOT NULL,
	`status` text DEFAULT 'pending_confirm' NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `item_state` (
	`item_id` integer PRIMARY KEY NOT NULL,
	`quantity_base_estimate` real,
	`unit_family` text,
	`level_estimate` text,
	`last_event_at` integer,
	`last_human_confirmed_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`unit_family` text DEFAULT 'count' NOT NULL,
	`shelf_life_days` integer,
	`staleness_half_life_days` integer DEFAULT 30 NOT NULL,
	`density_g_per_ml` real,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `items_name_unique` ON `items` (`name`);--> statement-breakpoint
CREATE TABLE `llm_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`run_after` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `llm_jobs_status_idx` ON `llm_jobs` (`status`,`run_after`);--> statement-breakpoint
CREATE TABLE `pantry_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`type` text NOT NULL,
	`quantity` real,
	`unit` text,
	`quantity_base` real,
	`unit_family` text,
	`level` text,
	`occurred_at` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	`source_type` text DEFAULT 'api' NOT NULL,
	`source_id` integer,
	`note` text,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `pantry_events_item_idx` ON `pantry_events` (`item_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `receipt_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`receipt_id` integer NOT NULL,
	`line_no` integer NOT NULL,
	`raw_text` text NOT NULL,
	`item_id` integer,
	`proposed_name` text,
	`quantity` real,
	`unit` text,
	`unit_family` text,
	`resolution` text DEFAULT 'unresolved' NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `receipt_lines_receipt_idx` ON `receipt_lines` (`receipt_id`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`paperless_doc_id` integer,
	`store_id` integer,
	`purchased_at` integer,
	`raw_text` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending_parse' NOT NULL,
	`parse_method` text,
	`note` text,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_paperless_doc_id_unique` ON `receipts` (`paperless_doc_id`);--> statement-breakpoint
CREATE TABLE `recipe_ingredients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`position` integer NOT NULL,
	`raw_text` text NOT NULL,
	`item_id` integer,
	`quantity` real,
	`unit` text,
	`unit_family` text,
	`optional` integer DEFAULT false NOT NULL,
	`resolution` text DEFAULT 'unresolved' NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `recipe_ingredients_recipe_idx` ON `recipe_ingredients` (`recipe_id`);--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`source_type` text DEFAULT 'url' NOT NULL,
	`source_url` text,
	`source_image_path` text,
	`servings` integer,
	`instructions` text DEFAULT '[]' NOT NULL,
	`raw_source` text,
	`status` text DEFAULT 'needs_review' NOT NULL,
	`image_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`non_grocery` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stores_name_unique` ON `stores` (`name`);