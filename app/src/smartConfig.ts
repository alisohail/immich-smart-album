import fs from 'fs'
import path from 'path'
import { SmartAlbumConfig } from './types'

export function loadConfig(): SmartAlbumConfig {
  const configDir = process.env.CONFIG_DIR || '/config'
  const configPath = process.env.SMART_ALBUM_CONFIG || path.join(configDir, 'config.json')
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    return JSON.parse(raw)
  } catch (err) {
    throw new Error('Failed to load config: ' + err)
  }
}
