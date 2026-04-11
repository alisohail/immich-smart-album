// Entry point for immich-smart-album
import { SmartAlbumManager } from './smartAlbumManager'
import { loadConfig } from './smartConfig'
import cron from 'node-cron'

async function start() {
  try {
    const config = loadConfig()
    const manager = new SmartAlbumManager(config)
    await manager.run()
    // Optionally, schedule with cron if config.schedule exists
    if (config.schedule) {
      cron.schedule(config.schedule, async () => {
        await manager.run()
      })
      console.log(`Scheduled smart album sync: ${config.schedule}`)
    }
  } catch (err) {
    console.error('Startup error:', err)
    process.exit(1)
  }
}

start()
