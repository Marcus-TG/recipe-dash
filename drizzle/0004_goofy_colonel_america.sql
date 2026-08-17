CREATE TABLE `product_codes` (
	`code` text PRIMARY KEY NOT NULL,
	`found` integer DEFAULT false NOT NULL,
	`name` text,
	`brand` text,
	`quantity_text` text,
	`quantity` real,
	`unit` text,
	`category` text,
	`source` text DEFAULT 'openfoodfacts' NOT NULL,
	`fetched_at` integer NOT NULL
);
