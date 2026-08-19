CREATE TABLE `grocery_list_lines` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`list_id` integer NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`item_id` integer,
	`quantity` real,
	`unit` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`checked` integer DEFAULT false NOT NULL,
	`dismissed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `grocery_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grocery_list_lines_key_idx` ON `grocery_list_lines` (`list_id`,`key`);--> statement-breakpoint
CREATE TABLE `grocery_list_recipes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`list_id` integer NOT NULL,
	`recipe_id` integer NOT NULL,
	`servings` integer,
	`added_at` integer NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `grocery_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grocery_list_recipes_key_idx` ON `grocery_list_recipes` (`list_id`,`recipe_id`);--> statement-breakpoint
CREATE TABLE `grocery_lists` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text DEFAULT 'Shopping' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
