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

  const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

  // albumId uniqueness is checked per-user only. The same albumId CAN appear under
  // different users — this is the intended shared-album scenario where each user
  // contributes their own photos to a common album.
  for (const user of config.users) {
    const seenIds = new Set<string>()
    for (const album of user.albums) {
      if (!album.albumId || !UUID_REGEX.test(album.albumId.trim())) {
        throw new Error(`Album '${album.name}': 'albumId' must be a valid UUID (received: "${album.albumId}").`)
      }

      if (seenIds.has(album.albumId)) {
        throw new Error(`Duplicate albumId "${album.albumId}" within the same user's albums. Each user's album list must reference distinct Immich albums.`)
      }
      seenIds.add(album.albumId)

      const hasFaceNames = (album.faceNames?.length ?? 0) > 0
      const hasMinNamedFaces = album.minNamedFaces !== undefined

      if (!hasFaceNames && !hasMinNamedFaces) {
        throw new Error(`Album '${album.name}' must define either non-empty 'faceNames' or 'minNamedFaces'.`)
      }

      if (album.minNamedFaces !== undefined) {
        if (
          typeof album.minNamedFaces !== 'number' ||
          !Number.isInteger(album.minNamedFaces) ||
          album.minNamedFaces < 1
        ) {
          throw new Error(`Album '${album.name}': 'minNamedFaces' must be an integer greater than or equal to 1.`)
        }
      }

      if (album.logic !== undefined && album.logic !== 'AND' && album.logic !== 'OR') {
        throw new Error(`Album '${album.name}': 'logic' must be 'AND' or 'OR'.`)
      }

      if ((album.faceNames?.length ?? 0) >= 2 && !album.logic) {
        throw new Error(`Album '${album.name}' has multiple faceNames and must specify 'logic' as either 'AND' or 'OR'.`)
      }
    }
  }

  return config
}
