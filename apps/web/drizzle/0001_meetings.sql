CREATE TABLE `meeting` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`google_event_id` text NOT NULL,
	`title` text NOT NULL,
	`meet_link` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`html_link` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `meeting_user_event_uidx` ON `meeting` (`user_id`,`google_event_id`);
--> statement-breakpoint
CREATE TABLE `participant` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`response_status` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meeting`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `participant_meeting_email_uidx` ON `participant` (`meeting_id`,`email`);
--> statement-breakpoint
CREATE TABLE `bot_run` (
	`id` text PRIMARY KEY NOT NULL,
	`meeting_id` text NOT NULL,
	`joined_at` integer,
	`left_at` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`meeting_id`) REFERENCES `meeting`(`id`) ON UPDATE no action ON DELETE cascade
);
