import fs from 'fs'
import path from 'path'
import { SmartAlbumConfig } from './types'

/**
 * Loads and parses the smart album configuration from disk.
 *
 * The config file path is resolved in priority order:
 * 1. `SMART_ALBUM_CONFIG` environment variable (full path to a JSON file).
 * 2. `CONFIG_DIR` environment variable + `/config.json`.
 * 3. Default: `/config/config.json`.
 *
 * @returns The parsed {@link SmartAlbumConfig} object.
 * @throws {Error} If the file cannot be read or its content is not valid JSON.
 */
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
