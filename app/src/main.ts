/**
 * @file Entry point for immich-smart-album.
 *
 * Loads configuration, runs an immediate album sync on startup,
 * and then schedules recurring syncs using a cron expression.
 */
import { SmartAlbumManager } from './smartAlbumManager'
import { loadConfig } from './smartConfig'
import cron from 'node-cron'
import dayjs from 'dayjs'

/**
 * Bootstraps the smart album manager:
 * 1. Loads config from disk.
 * 2. Registers a cron job for recurring syncs.
 * 3. Runs an immediate sync so the first execution does not wait for the schedule.
 * 4. Logs when the next scheduled run will occur.
 *
 * @throws Exits the process with code `1` if startup fails (e.g. bad config).
 */
async function main() {
  try {
    const config = loadConfig()
    const manager = new SmartAlbumManager(config)

    // Default to "every 30 minutes" if no schedule is configured
    const schedule = config.schedule || '0,30 * * * *'
    const logger = manager['logger']

    const cronTask = cron.schedule(schedule, async () => {
      await manager.run()
    })
    logger.info(`Scheduled smart album sync: ${schedule}`)

    // Run immediately on startup rather than waiting for the first cron tick
    await manager.run()

    // Log the next scheduled execution time if the cron library exposes it
    const nextRun = cronTask.getNextRun ? cronTask.getNextRun() : null
    if (nextRun) {
      logger.info(`Waiting for next scheduled sync at: ${dayjs(nextRun).format('YYYY-MM-DD HH:mm:ss')}`)
    } else {
      logger.info('Waiting for next scheduled sync...')
    }
  } catch (err) {
    console.error('Startup error:', err)
    process.exit(1)
  }
}

main()
