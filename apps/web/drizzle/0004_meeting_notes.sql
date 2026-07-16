CREATE TABLE `meeting_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`bot_run_id` text NOT NULL,
	`meeting_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`summary_text` text,
	`action_items` text,
	`error_message` text,
	`workflow_instance_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`bot_run_id`) REFERENCES `bot_run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`meeting_id`) REFERENCES `meeting`(`id`) ON UPDATE no action ON DELETE cascade
);
