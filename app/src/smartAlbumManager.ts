import { ImmichClient, AlbumSettings, SmartAlbumConfig } from './types'
import { createLogger } from './utils'
import { init, addAssetsToAlbum, searchAssets, searchPerson, removeAssetFromAlbum, getAlbumInfo, getMyUser } from '@immich/sdk'
import fs from 'fs'
import path from 'path'
import dayjs from 'dayjs'

const PAGE_SIZE = 100
const SYNC_STATE_FILENAME = '.sync-state.json'

export class SmartAlbumManager {
  private config: SmartAlbumConfig
  private logger: ReturnType<typeof createLogger>
  private logLevel: 'debug' | 'info'
  private syncState: Record<string, Record<string, Record<string, string>>> = {}
  private syncFilePath: string

  /**
   * @param config - The full smart album configuration, including server URL,
   *                 user API keys, album definitions, and optional log level.
   */
  constructor(config: SmartAlbumConfig) {
    this.config = config
    this.logLevel = config.options?.logLevel || 'info'
    this.logger = createLogger(this.logLevel)
    const configDir = process.env.CONFIG_DIR || '/config'
    this.syncFilePath = path.join(configDir, SYNC_STATE_FILENAME)
  }

  /**
   * Iterates over all configured users, initialises the Immich SDK for each,
   * and processes every album defined under that user.
   */
  async run() {
    this.syncState = this.loadSyncState()
    const syncStartTime = dayjs().toISOString()

    for (const user of this.config.users) {
      try {
        init({ baseUrl: this.config.immichServer + '/api', apiKey: user.apiKey })
        const userInfo = await getMyUser()
        const userName = userInfo.name
        this.logger.info(`Processing user: ${userName}`)
        for (const album of user.albums) {
          await this.processAlbum(userName, album, syncStartTime)
        }
      } catch (err) {
        this.logger.error('User processing failed', err)
      }
    }

    this.saveSyncState()
  }

  /**
   * Processes a single album end-to-end:
   * resolves face names → IDs, fetches matching assets, adds them to the album,
   * and removes any assets belonging to excluded faces.
   *
   * @param album - The album settings to process.
   */
  async processAlbum(userName: string, album: AlbumSettings, syncStartTime: string) {
    const { faceIds, faceNameToId, excludeFaceIds, excludeFaceNameToId } = await this.resolveAllFaceIds(album)
    const getFaceName = this.buildFaceNameLookup(faceNameToId, excludeFaceNameToId)

    this.logAlbumHeader(album)

    try {
      const excludedAssetIds = await this.fetchExcludedAssetIds(excludeFaceIds, getFaceName)
      const finalAssetIds = await this.collectTargetAssetIds(userName, album, faceIds, excludedAssetIds, getFaceName)

      const addedCount = await this.addAssets(album, finalAssetIds)
      const removedCount = await this.removeExcludedAssets(album, excludeFaceIds, excludedAssetIds)

      // Update sync state for each face in this album after successful processing
      for (const faceId of faceIds) {
        if (!this.syncState[userName]) this.syncState[userName] = {}
        if (!this.syncState[userName][album.name]) this.syncState[userName][album.name] = {}
        this.syncState[userName][album.name][getFaceName(faceId)] = syncStartTime
      }

      this.logSummary(album, addedCount, removedCount)
    } catch (err) {
      this.logger.error('Error processing album', err)
    }
  }

  /**
   * Resolves both the include and exclude face name lists for an album into
   * their corresponding Immich person IDs, and returns reverse-lookup maps for logging.
   *
   * @param album - The album whose face name lists should be resolved.
   * @returns Resolved IDs and name-to-ID maps for both include and exclude lists.
   */
  private async resolveAllFaceIds(album: AlbumSettings) {
    const faceNameToId: Record<string, string> = {}
    const excludeFaceNameToId: Record<string, string> = {}

    const faceIds = await this.resolveNamesToIds(album.faceNames || [], 'face', faceNameToId)
    const excludeFaceIds = await this.resolveNamesToIds(album.excludeFaceNames || [], 'exclude face', excludeFaceNameToId)

    return { faceIds, faceNameToId, excludeFaceIds, excludeFaceNameToId }
  }

  /**
   * Resolves a list of human-readable person names to Immich person IDs.
   * Successful resolutions are stored in the provided `nameToId` map as a side effect.
   *
   * @param names     - List of person names to resolve.
   * @param label     - Human-readable label used in log messages (e.g. `'face'` or `'exclude face'`).
   * @param nameToId  - Map that will be populated with `name → id` entries for resolved names.
   * @returns Array of successfully resolved person IDs, in the same order as `names`.
   */
  private async resolveNamesToIds(names: string[], label: string, nameToId: Record<string, string>): Promise<string[]> {
    const ids: string[] = []
    for (const name of names) {
      try {
        const result = await searchPerson({ name })
        if (result && Array.isArray(result) && result.length > 0) {
          ids.push(result[0].id)
          nameToId[name] = result[0].id
          this.logger.info(`Resolved ${label} name '${name}' to id '${result[0].id}'`)
        } else {
          this.logger.info(`No match found for ${label} name '${name}'`)
        }
      } catch (err) {
        this.logger.error(`Error resolving ${label} name '${name}':`, err)
      }
    }
    return ids
  }

  /**
   * Builds a function that maps a person ID back to its human-readable name,
   * falling back to the raw ID if no name is found in either map.
   *
   * @param faceNameToId        - Map of include face names to their IDs.
   * @param excludeFaceNameToId - Map of exclude face names to their IDs.
   * @returns A lookup function `(id: string) => string`.
   */
  private buildFaceNameLookup(
    faceNameToId: Record<string, string>,
    excludeFaceNameToId: Record<string, string>
  ): (id: string) => string {
    const idToName: Record<string, string> = {}
    for (const [name, id] of Object.entries(faceNameToId)) idToName[id] = name
    for (const [name, id] of Object.entries(excludeFaceNameToId)) idToName[id] = name
    return (id: string) => idToName[id] ?? id
  }

  /**
   * Fetches all asset IDs matching the given person IDs across all pages.
   * Assets whose IDs appear in `excludeSet` are omitted from the result.
   *
   * @param personIds  - Immich person IDs to search for.
   * @param label      - Human-readable label used in log messages.
   * @param excludeSet - Optional set of asset IDs to exclude from the result.
   * @returns A `Set` of matching asset IDs.
   */
  private async fetchAllAssetIdsForPersons(
    personIds: string[],
    label: string,
    excludeSet: Set<string> = new Set(),
    updatedAfter?: string | null
  ): Promise<Set<string>> {
    const assetIdSet = new Set<string>()
    let nextPage: any = 1

    if (updatedAfter) {
      this.logger.info(`Incremental fetch for [${label}]: assets updated after ${updatedAfter}`)
    } else {
      this.logger.info(`Full fetch for [${label}]`)
    }

    do {
      this.logger.info(`Fetching page ${nextPage} for [${label}]`)
      const dto: any = { personIds, page: Number(nextPage), size: PAGE_SIZE }
      if (updatedAfter) {
        dto.updatedAfter = updatedAfter
      }
      const result = await searchAssets({ metadataSearchDto: dto })
      const items = result.assets?.items || []

      for (const asset of items) {
        if (!excludeSet.has(asset.id)) assetIdSet.add(asset.id)
      }

      this.logger.debug(`Fetched ${items.length} assets for [${label}] (page ${nextPage})`)
      nextPage = result.assets?.nextPage ?? null
    } while (nextPage !== null)

    return assetIdSet
  }

  /**
   * Fetches the full set of asset IDs associated with the excluded face IDs.
   * Returns an empty set if no exclude faces are configured.
   *
   * @param excludeFaceIds - Person IDs whose assets should be excluded.
   * @param getFaceName    - Lookup function for human-readable name logging.
   * @returns A `Set` of asset IDs belonging to excluded persons.
   */
  private async fetchExcludedAssetIds(
    excludeFaceIds: string[],
    getFaceName: (id: string) => string
  ): Promise<Set<string>> {
    if (excludeFaceIds.length === 0) return new Set()

    const label = excludeFaceIds.map(getFaceName).join(', ')
    return this.fetchAllAssetIdsForPersons(excludeFaceIds, `exclude: ${label}`)
  }

  /**
   * Determines which assets should be added to the album, respecting the
   * configured `logic` (OR / AND) and filtering out excluded asset IDs.
   *
   * @param album            - The album settings (used for `logic` and `faceNames`).
   * @param faceIds          - Resolved person IDs to include.
   * @param excludedAssetIds - Asset IDs to omit from the result.
   * @param getFaceName      - Lookup function for human-readable name logging.
   * @returns Array of asset IDs to add to the album.
   */
  private async collectTargetAssetIds(
    userName: string,
    album: AlbumSettings,
    faceIds: string[],
    excludedAssetIds: Set<string>,
    getFaceName: (id: string) => string
  ): Promise<string[]> {
    if (faceIds.length === 0) {
      if ((album.faceNames || []).length > 0) {
        this.logger.info(`No valid faceIds found for album '${album.name}', skipping asset search.`)
      }
      return []
    }

    if (album.logic === 'OR') {
      return this.collectOrAssets(userName, album, faceIds, excludedAssetIds, getFaceName)
    } else {
      return this.collectAndAssets(userName, album, faceIds, excludedAssetIds, getFaceName)
    }
  }

  /**
   * Collects the union of all assets across all face IDs (OR logic).
   * A single search covering all `faceIds` at once is used.
   *
   * @param faceIds          - Person IDs to include.
   * @param excludedAssetIds - Asset IDs to omit.
   * @param getFaceName      - Lookup function for human-readable name logging.
   * @returns Deduplicated array of asset IDs matching any of the face IDs.
   */
  private async collectOrAssets(
    userName: string,
    album: AlbumSettings,
    faceIds: string[],
    excludedAssetIds: Set<string>,
    getFaceName: (id: string) => string
  ): Promise<string[]> {
    const combined = new Set<string>()

    for (const faceId of faceIds) {
      const label = getFaceName(faceId)
      const syncDate = this.syncState[userName]?.[album.name]?.[label] || null
      const assets = await this.fetchAllAssetIdsForPersons([faceId], label, excludedAssetIds, syncDate)
      for (const id of assets) combined.add(id)
    }

    const result = Array.from(combined)
    this.logger.info(`OR logic: union count = ${result.length}`)
    return result
  }

  /**
   * Collects the intersection of assets across all face IDs (AND logic).
   * Each face ID is queried individually and the results are intersected.
   *
   * @param faceIds          - Person IDs that must ALL appear on an asset.
   * @param excludedAssetIds - Asset IDs to omit before intersecting.
   * @param getFaceName      - Lookup function for human-readable name logging.
   * @returns Array of asset IDs matching all face IDs simultaneously.
   */
  private async collectAndAssets(
    userName: string,
    album: AlbumSettings,
    faceIds: string[],
    excludedAssetIds: Set<string>,
    getFaceName: (id: string) => string
  ): Promise<string[]> {
    // For AND logic, if any face is new (no sync date), we must do a full
    // sync for ALL faces — an incremental fetch on old faces would miss
    // historical assets that now match the full intersection.
    const anyNew = faceIds.some(id => !this.syncState[userName]?.[album.name]?.[getFaceName(id)])
    if (anyNew) {
      this.logger.info('AND logic: new face detected, performing full sync for all faces in this album')
    }

    const perFaceSets: Set<string>[] = []

    for (const faceId of faceIds) {
      const label = getFaceName(faceId)
      const syncDate = anyNew ? null : (this.syncState[userName]?.[album.name]?.[label] || null)
      const assetIdSet = await this.fetchAllAssetIdsForPersons([faceId], label, excludedAssetIds, syncDate)
      perFaceSets.push(assetIdSet)
    }

    const intersection = perFaceSets.reduce((acc, curr) => new Set([...acc].filter(x => curr.has(x))))
    const result = Array.from(intersection)
    this.logger.info(`AND logic: intersection count = ${result.length}`)
    return result
  }

  /**
   * Adds the given assets to the Immich album.
   * Does nothing if `assetIds` is empty.
   *
   * @param album    - The target album.
   * @param assetIds - IDs of assets to add.
   * @returns Number of assets added.
   */
  private async addAssets(album: AlbumSettings, assetIds: string[]): Promise<number> {
    this.logger.info(`Found ${assetIds.length} assets to add to album '${album.name}'`)
    this.logger.debug('Asset IDs:', assetIds)

    if (assetIds.length === 0) {
      this.logger.info('No assets found to add.')
      return 0
    }

    await addAssetsToAlbum({ id: album.albumId, bulkIdsDto: { ids: assetIds } })
    this.logger.info(`Added ${assetIds.length} assets to album '${album.name}'`)
    return assetIds.length
  }

  /**
   * Removes any assets currently in the album that belong to excluded persons.
   * Fetches the current album contents and cross-references with `excludedAssetIds`.
   * Does nothing if no exclude faces are configured.
   *
   * @param album            - The target album.
   * @param excludeFaceIds   - Person IDs whose assets should be removed.
   * @param excludedAssetIds - Pre-fetched set of asset IDs belonging to excluded persons.
   * @returns Number of assets removed.
   */
  private async removeExcludedAssets(
    album: AlbumSettings,
    excludeFaceIds: string[],
    excludedAssetIds: Set<string>
  ): Promise<number> {
    if (excludeFaceIds.length === 0) return 0

    try {
      const albumInfo = await getAlbumInfo({ id: album.albumId })
      const albumAssets = albumInfo?.assets || []
      const toRemove = albumAssets.filter(asset => excludedAssetIds.has(asset.id))

      if (toRemove.length === 0) return 0

      await removeAssetFromAlbum({ id: album.albumId, bulkIdsDto: { ids: toRemove.map(a => a.id) } })
      this.logger.info(`Removed ${toRemove.length} excluded assets from album '${album.name}'`)
      return toRemove.length
    } catch (err) {
      this.logger.error('Error removing excluded assets from album:', err)
      return 0
    }
  }

  /**
   * Logs a header block at the start of album processing.
   * In `info` mode, key fields are logged individually.
   * In `debug` mode, the full album object is logged.
   *
   * @param album - The album being processed.
   */
  private logAlbumHeader(album: AlbumSettings) {
    this.logger.info(`Processing album: ${album.name}`)
    if (this.logLevel === 'debug') {
      this.logger.debug('Album details:', album)
    } else {
      this.logger.info(`Logic: ${album.logic}`)
      this.logger.info(`faceNames: ${album.faceNames?.join(', ') || ''}`)
      this.logger.info(`excludeFaceNames: ${album.excludeFaceNames?.join(', ') || ''}`)
    }
  }

  /**
   * Logs a structured summary after an album has been processed.
   *
   * @param album        - The album that was processed.
   * @param addedCount   - Number of assets added.
   * @param removedCount - Number of assets removed.
   */
  private logSummary(album: AlbumSettings, addedCount: number, removedCount: number) {
    this.logger.info('--- Album Processing Summary ---')
    this.logger.info(`Album: ${album.name}`)
    this.logger.info(`Logic: ${album.logic}`)
    this.logger.info(`faceNames: ${album.faceNames?.join(', ') || ''}`)
    this.logger.info(`excludeFaceNames: ${album.excludeFaceNames?.join(', ') || ''}`)
    this.logger.info(`Assets added: ${addedCount}`)
    this.logger.info(`Assets removed: ${removedCount}`)
    this.logger.info('------------------------------')
    this.logger.debug('Summary:', { album: album.name, albumId: album.albumId, addedCount, removedCount })
  }

  private loadSyncState(): Record<string, Record<string, Record<string, string>>> {
    try {
      if (fs.existsSync(this.syncFilePath)) {
        const content = fs.readFileSync(this.syncFilePath, 'utf-8').trim()
        const parsed = JSON.parse(content)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const userCount = Object.keys(parsed).length
          this.logger.info(`Loaded sync state with ${userCount} user(s)`)
          return parsed
        }
        this.logger.info('Invalid sync state file, starting fresh')
      }
    } catch (err) {
      this.logger.error('Error reading sync state:', err)
    }
    return {}
  }

  private saveSyncState(): void {
    try {
      fs.writeFileSync(this.syncFilePath, JSON.stringify(this.syncState, null, 2), 'utf-8')
      const userCount = Object.keys(this.syncState).length
      this.logger.info(`Saved sync state with ${userCount} user(s)`)
    } catch (err) {
      this.logger.error('Error saving sync state:', err)
    }
  }
}
