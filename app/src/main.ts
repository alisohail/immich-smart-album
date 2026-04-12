// Entry point for immich-smart-album
import { SmartAlbumManager } from './smartAlbumManager'
import { loadConfig } from './smartConfig'
import cron from 'node-cron'
import dayjs from 'dayjs'

async function main() {
  try {
    const config = loadConfig()
    const manager = new SmartAlbumManager(config)
    // Schedule cron job first (with default if not set)
    const schedule = config.schedule || '0,30 * * * *'
    const logger = manager['logger']
    const cronTask = cron.schedule(schedule, async () => {
      await manager.run()
    })
    logger.info(`Scheduled smart album sync: ${schedule}`)
    // Run immediately on startup
    await manager.run()
    // Log when waiting for schedule and next execution time
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
