import {
  createS3BackupBucket,
  loadCloudBackupConfigFromFileSystem,
  scheduleCloudBackups,
} from "../types/cloud_backups";
import type { CronScheduler } from "../types/job";

/**
 * Arms scheduled cloud backups on the given cron scheduler, if configured.
 *
 * Returns false and arms nothing when the environment carries no backup
 * bucket or key — the normal case for most apps, and the reason importing
 * the cron subsystem costs nothing for backups. A malformed backup config
 * logs once and also arms nothing, so a typo in backup settings can never
 * stop the server from booting.
 *
 * The S3 bucket client is built here, only on the configured path. Bun's
 * S3 file handles are lazy (no network request until a method runs), so
 * even constructing it performs no bucket work; the first network call is
 * the first scheduled run's upload.
 */
export function maybeScheduleCloudBackups(cron: CronScheduler): boolean {
  let config;
  try {
    // Reads YATTA_BACKUP_CONFIG_FILE (JSON5) when set, plus the environment.
    // The key and bucket credentials still come from the environment only.
    config = loadCloudBackupConfigFromFileSystem();
  } catch (err) {
    console.error(
      `[cloud-backup] not scheduled: ${err instanceof Error ? err.message : "invalid backup configuration"}`,
    );
    return false;
  }
  if (!config) return false;
  const bucket = createS3BackupBucket({ driver: "s3", bucket: config.bucket, ...config.s3 });
  scheduleCloudBackups(cron, config, bucket);
  return true;
}
