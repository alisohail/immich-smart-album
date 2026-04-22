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
  let config: SmartAlbumConfig
  try {
    const raw = fs.readFileSync(configPath, 'utf-8')
    config = JSON.parse(raw)
  } catch (err) {
    throw new Error('Failed to load config: ' + err)
  }

  const allNames = config.users.flatMap(u => u.albums.map(a => a.name))
  const seen = new Set<string>()
  for (const name of allNames) {
    if (seen.has(name)) throw new Error(`Duplicate album name in config: "${name}". Album names must be unique across all users as they are used as sync state keys.`)
    seen.add(name)
  }

  const allAlbumIds = config.users.flatMap(u => u.albums.map(a => a.albumId))
  const seenIds = new Set<string>()
  for (const id of allAlbumIds) {
    if (seenIds.has(id)) throw new Error(`Duplicate albumId in config: "${id}". Each album entry must reference a distinct Immich album.`)
    seenIds.add(id)
  }

  return config
}
