CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`batch_id` text NOT NULL,
	`tool` text NOT NULL,
	`args` text,
	`via` text NOT NULL,
	`table_name` text NOT NULL,
	`row_id` integer NOT NULL,
	`action` text NOT NULL,
	`before` text,
	`after` text,
	`undone` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_batch_idx` ON `audit_log` (`batch_id`);--> statement-breakpoint
CREATE TABLE `container` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` integer NOT NULL,
	`label` text,
	`portions_total` real NOT NULL,
	`portions_left` real NOT NULL,
	`portion_g` real NOT NULL,
	`started_on` text NOT NULL,
	`finished_at` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `food` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`brand` text,
	`aliases` text DEFAULT '[]' NOT NULL,
	`barcode` text,
	`serving_size_g` real,
	`kcal` real NOT NULL,
	`protein` real NOT NULL,
	`carbs` real NOT NULL,
	`fat` real NOT NULL,
	`fiber` real,
	`sugar` real,
	`sodium_mg` real,
	`source` text DEFAULT 'manual' NOT NULL,
	`confidence` real,
	`source_urls` text DEFAULT '[]' NOT NULL,
	`favorite` integer DEFAULT false NOT NULL,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `food_barcode_idx` ON `food` (`barcode`);--> statement-breakpoint
CREATE INDEX `food_name_idx` ON `food` (`name`);--> statement-breakpoint
CREATE TABLE `log_entry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`meal` text NOT NULL,
	`ref_type` text NOT NULL,
	`ref_id` integer,
	`name` text NOT NULL,
	`amount` real NOT NULL,
	`unit` text NOT NULL,
	`grams` real,
	`kcal` real NOT NULL,
	`protein` real NOT NULL,
	`carbs` real NOT NULL,
	`fat` real NOT NULL,
	`fiber` real,
	`sugar` real,
	`sodium_mg` real,
	`created_via` text NOT NULL,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `log_entry_date_idx` ON `log_entry` (`date`);--> statement-breakpoint
CREATE TABLE `profile` (
	`id` integer PRIMARY KEY NOT NULL,
	`height_cm` real,
	`weight_kg` real,
	`age` integer,
	`sex` text,
	`activity` text,
	`goal` text DEFAULT 'maintain',
	`pace_lb_per_week` real DEFAULT 0.5,
	`goal_weight_kg` real,
	`units` text DEFAULT 'metric' NOT NULL,
	`timezone` text DEFAULT 'UTC',
	`protein_g_per_kg` real DEFAULT 1.6 NOT NULL,
	`targets` text,
	`target_override_kcal` integer,
	`maintenance_override` integer,
	`adaptive` text,
	`weekly_budget` integer DEFAULT false NOT NULL,
	`tradeoff_cards` integer DEFAULT true NOT NULL,
	`calc_history` text DEFAULT '[]' NOT NULL,
	`onboarded` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recipe` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`root_id` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`name` text NOT NULL,
	`ingredients` text NOT NULL,
	`total_raw_g` real NOT NULL,
	`total_cooked_weight_g` real NOT NULL,
	`portion_g` real,
	`kcal` real NOT NULL,
	`protein` real NOT NULL,
	`carbs` real NOT NULL,
	`fat` real NOT NULL,
	`fiber` real,
	`sugar` real,
	`sodium_mg` real,
	`notes` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recipe_root_idx` ON `recipe` (`root_id`);--> statement-breakpoint
CREATE TABLE `restaurant_order` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`restaurant` text NOT NULL,
	`item` text NOT NULL,
	`kcal` real NOT NULL,
	`protein` real NOT NULL,
	`carbs` real NOT NULL,
	`fat` real NOT NULL,
	`fiber` real,
	`sugar` real,
	`sodium_mg` real,
	`source` text DEFAULT 'estimate' NOT NULL,
	`confidence` real,
	`source_urls` text DEFAULT '[]' NOT NULL,
	`notes` text,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `template` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`items` text NOT NULL,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `weight_entry` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`weight_kg` real NOT NULL,
	`body_fat_pct` real,
	`deleted_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `weight_entry_date_idx` ON `weight_entry` (`date`);