ALTER TABLE `meeting` ADD `workflow_instance_id` text;
--> statement-breakpoint
ALTER TABLE `bot_run` ADD `recording_key` text;
--> statement-breakpoint
ALTER TABLE `bot_run` ADD `error_message` text;
--> statement-breakpoint
ALTER TABLE `bot_run` ADD `workflow_instance_id` text;
