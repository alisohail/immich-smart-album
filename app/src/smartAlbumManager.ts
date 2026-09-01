import { ImmichClient, AlbumSettings, SmartAlbumConfig, SmartAlbumSyncState, AlbumSyncState, FetchedAssetInfo } from './types'
import { createLogger } from './utils'
import { init, addAssetsToAlbum, searchAssets, searchPerson, removeAssetFromAlbum, getMyUser } from '@immich/sdk'
import fs from 'fs'
import path from 'path'
import dayjs from 'dayjs'

const PAGE_SIZE = 100
const BATCH_SIZE = 500  // max IDs per addAssetsToAlbum / removeAssetFromAlbum call
const SYNC_STATE_FILENAME = '.sync-state.json'

export class SmartAlbumManager {
  private config: SmartAlbumConfig
  private logger: ReturnType<typeof createLogger>
  private logLevel: 'debug' | 'info'
  private syncState: SmartAlbumSyncState = {}
  private syncFilePath: string
  private runAlbumChecksums = new Map<string, Set<string>>()
  private running = false

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

  get log() {
    return this.logger
  }

  /**
   * Counts how many distinct recognized people are in the photo.
   * Deduplicated strictly by person ID (`p.id`), ignoring empty names.
   * Faces are not disqualified by `isHidden`.
   */
  private countNamedFaces(asset: {
    people?: Array<{ id: string; name?: string | null }>
  }): number {
    const uniquePersons = new Set<string>();
    for (const p of asset.people || []) {
      const name = p.name?.trim();
      if (name && name.length > 0) {
        uniquePersons.add(p.id);
      }
    }
    return uniquePersons.size;
  }

  /**
   * Iterates over all configured users, initialises the Immich SDK for each,
   * and processes every album defined under that user.
   */
  async run() {
    if (this.running) {
      this.logger.warn('Previous sync still in progress — skipping this scheduled run')
      return
    }
    this.running = true
    const runStart = dayjs()
    const totalAlbums = this.config.users.reduce((sum, u) => sum + u.albums.length, 0)
    this.logger.info(`Sync started — ${runStart.format('YYYY-MM-DD HH:mm:ss')} | ${this.config.users.length} user(s), ${totalAlbums} album(s)`)

    this.syncState = this.loadSyncState()
    this.runAlbumChecksums = new Map() // reset per run — shared across users for cross-user dedup

    for (const user of this.config.users) {
      try {
        init({ baseUrl: this.config.immichServer + '/api', apiKey: user.apiKey })
        const userInfo = await getMyUser()
        const userId = userInfo.id    // stable UUID — used as sync state key
        const userName = userInfo.name // display name — used only for logging
        this.logger.info(`User: ${userName}`)
        for (const album of user.albums) {
          await this.processAlbum(userId, userName, album)
        }
      } catch (err) {
        this.logger.error('User processing failed:', err)
      }
    }

    const elapsed = dayjs().diff(runStart, 'second')
    this.logger.info(`Sync complete — ${elapsed}s elapsed`)
    this.running = false
  }

  /**
   * Processes a single album end-to-end:
   * resolves face names → IDs, fetches matching assets, adds them to the album,
   * and removes any assets belonging to excluded faces.
   *
   * @param album - The album settings to process.
   */
  async processAlbum(userId: string, userName: string, album: AlbumSettings) {
    const { faceIds, faceNameToId, excludeFaceIds, excludeFaceNameToId } = await this.resolveAllFaceIds(album)
    const getFaceName = this.buildFaceNameLookup(faceNameToId, excludeFaceNameToId)

    // Conditionally render components:
    const parts: string[] = [`"${album.name}"`];
    if (album.logic) {
      parts.push(`[${album.logic}]`);
    }
    if ((album.faceNames || []).length > 0) {
      parts.push(`faces: ${(album.faceNames || []).join(', ')}`);
    }
    if (album.minNamedFaces !== undefined) {
      parts.push(`minNamedFaces: ${album.minNamedFaces}`);
    }
    if ((album.excludeFaceNames || []).length > 0) {
      parts.push(`exclude: ${(album.excludeFaceNames || []).join(', ')}`);
    }
    this.logger.info(`  ${parts.join('  |  ')}`);

    // Warn if face names were configured but none could be resolved in Immich.
    if (faceIds.length === 0 && (album.faceNames || []).length > 0) {
      this.logger.warn(`    No faces resolved — check face names match Immich exactly`)
      return
    }

    // Threshold Modification Detection & Historical Resync:
    const albumState = this.syncState[userId]?.[album.name];
    if (albumState && album.minNamedFaces !== albumState.minNamedFaces) {
      this.logger.info(
        `  'minNamedFaces' changed (previous: ` +
        `${albumState.minNamedFaces ?? 'none'}, current: ` +
        `${album.minNamedFaces ?? 'none'}); resetting sync state.`
      );
      delete this.syncState[userId][album.name];
    }

    // Capture start time per-album so that photos uploaded during a long multi-album
    // run are not missed. Using a shared run-level timestamp would make the stored
    // sync date stale for albums processed later in the same run.
    const syncStartTime = dayjs().toISOString()

    try {
      let candidateAssets: Map<string, string>;

      if ((album.faceNames || []).length === 0) {
        // Count-only pipeline: Call fetchAllAssetsForMinFaces directly without fetchExcludedAssetIds
        candidateAssets = await this.fetchAllAssetsForMinFaces(userId, album, excludeFaceIds);
      } else {
        // Person-filtered / hybrid pipeline
        const excludedAssetIds = await this.fetchExcludedAssetIds(excludeFaceIds, getFaceName);
        candidateAssets = await this.collectTargetAssetIds(userId, album, faceIds, excludedAssetIds, getFaceName);
      }

      // Only fetch existing checksums when we have candidates AND multiple users are configured.
      // We query only the face-matched assets already in the album (albumIds + personIds), not all album assets.
      // For a 100k-photo album with 500 Alice photos, this is ~5 API calls instead of ~1000.
      const needsDedup = candidateAssets.size > 0 && this.config.users.length > 1
      const existingChecksums = needsDedup
        ? await this.fetchFaceChecksumsInAlbum(album.albumId)
        : new Set<string>()

      const { added, skipped } = await this.addAssets(album, candidateAssets, existingChecksums)
      const removedCount = await this.removeExcludedAssets(album, excludeFaceIds)

      // Update sync state for this album after successful processing.
      // Keyed by stable userId (UUID) — not display name, which can change in Immich.
      if (!this.syncState[userId]) {
        this.syncState[userId] = {};
      }
      let currentAlbumState = this.syncState[userId][album.name];
      if (!currentAlbumState) {
        currentAlbumState = this.syncState[userId][album.name] = { faces: {} };
      }
      currentAlbumState.minNamedFaces = album.minNamedFaces;

      if ((album.faceNames || []).length === 0) {
        currentAlbumState.lastAlbumSync = syncStartTime;
      } else {
        for (const faceId of faceIds) {
          currentAlbumState.faces[getFaceName(faceId)] = syncStartTime;
        }
      }

      // Save after each successful album so progress is not lost if the process crashes.
      this.saveSyncState()

      // Single compact result line
      const resultParts: string[] = []
      if (added > 0) resultParts.push(`+${added} added`)
      if (removedCount > 0) resultParts.push(`-${removedCount} removed`)
      if (skipped > 0) resultParts.push(`${skipped} duplicate(s) skipped`)
      this.logger.info(`    → ${resultParts.length > 0 ? resultParts.join(', ') : 'nothing to sync'}`)
    } catch (err) {
      this.logger.error(`    → Failed processing "${album.name}":`, err)
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

    const [faceIds, excludeFaceIds] = await Promise.all([
      this.resolveNamesToIds(album.faceNames || [], 'face', faceNameToId),
      this.resolveNamesToIds(album.excludeFaceNames || [], 'exclude face', excludeFaceNameToId),
    ])

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
    const results = await Promise.all(
      names.map(async (name) => {
        try {
          const result = await searchPerson({ name })
          if (result && Array.isArray(result) && result.length > 0) {
            nameToId[name] = result[0].id
            this.logger.debug(`Resolved ${label} name '${name}' to id '${result[0].id}'`)
            return result[0].id as string | null
          }
          this.logger.warn(`    "${name}" not found in Immich — skipping`)
          return null
        } catch (err) {
          this.logger.error(`Error resolving ${label} name '${name}':`, err)
          return null
        }
      })
    )
    return results.filter((id): id is string => id !== null)
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

  private async fetchFaceChecksumsInAlbum(albumId: string): Promise<Set<string>> {
    // Return cached set if this album has already been loaded this run.
    // The Set is shared — addAssets mutates it in-place, so checksums added by
    // earlier users are automatically visible to later users in the same run.
    if (this.runAlbumChecksums.has(albumId)) {
      this.logger.debug(`Using cached album checksums for dedup (${this.runAlbumChecksums.get(albumId)!.size} entries)`)
      return this.runAlbumChecksums.get(albumId)!
    }

    // Full paginated fetch — face-filtered queries can't be used here because other
    // users' photos are tagged with their own person IDs, not the current user's.
    // This is paid once per album per run, not once per user.
    const checksums = new Set<string>()
    let nextPage: any = 1

    do {
      const result = await searchAssets({
        metadataSearchDto: { albumIds: [albumId], page: Number(nextPage), size: PAGE_SIZE }
      })
      const items = result.assets?.items || []
      for (const asset of items) checksums.add(asset.checksum)
      this.logger.debug(`Fetched ${items.length} album assets for dedup cache (page ${nextPage})`)
      nextPage = result.assets?.nextPage ?? null
    } while (nextPage !== null)

    this.logger.debug(`Loaded ${checksums.size} existing album checksums for cross-user dedup`)
    this.runAlbumChecksums.set(albumId, checksums)
    return checksums
  }

  /**
   * Fetches all asset IDs matching the given person IDs across all pages.
   * Assets whose IDs appear in `excludeSet` are omitted from the result.
   *
   * @param personIds  - Immich person IDs to search for.
   * @param label      - Human-readable label used in log messages.
   * @param excludeSet - Optional set of asset IDs to exclude from the result.
   * @param updatedAfter - Optional timestamp to filter assets updated after.
   * @param withPeople - Whether to request person metadata on assets.
   * @returns A Map of matching asset ID to FetchedAssetInfo.
   */
  private async fetchAllAssetIdsForPersons(
    personIds: string[],
    label: string,
    excludeSet: Set<string> = new Set(),
    updatedAfter?: string | null,
    withPeople: boolean = false
  ): Promise<Map<string, FetchedAssetInfo>> {
    const assetMap = new Map<string, FetchedAssetInfo>();
    let nextPage: any = 1

    if (updatedAfter) {
      this.logger.debug(`Incremental fetch for [${label}]: assets updated after ${updatedAfter}`)
    } else {
      this.logger.debug(`Full fetch for [${label}]`)
    }

    do {
      this.logger.debug(`Fetching page ${nextPage} for [${label}]`)
      const dto: any = { personIds, page: Number(nextPage), size: PAGE_SIZE }
      if (updatedAfter) {
        dto.updatedAfter = updatedAfter
      }
      if (withPeople) {
        dto.withPeople = true;
      }
      const result = await searchAssets({ metadataSearchDto: dto })
      const items = result.assets?.items || []

      for (const asset of items) {
        if (!excludeSet.has(asset.id)) {
          assetMap.set(asset.id, { checksum: asset.checksum, people: asset.people });
        }
      }

      this.logger.debug(`Fetched ${items.length} assets for [${label}] (page ${nextPage})`)
      nextPage = result.assets?.nextPage ?? null
    } while (nextPage !== null)

    return assetMap
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

    // Query each excluded face individually and union the results.
    // Passing multiple personIds in one call uses AND semantics in Immich,
    // which would only exclude photos containing ALL excluded people together.
    const combined = new Set<string>()
    for (const faceId of excludeFaceIds) {
      const label = getFaceName(faceId)
      const assetMap = await this.fetchAllAssetIdsForPersons([faceId], `exclude: ${label}`)
      for (const id of assetMap.keys()) combined.add(id)
    }
    return combined
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
    userId: string,
    album: AlbumSettings,
    faceIds: string[],
    excludedAssetIds: Set<string>,
    getFaceName: (id: string) => string
  ): Promise<Map<string, string>> {
    if (faceIds.length === 0) {
      if ((album.faceNames || []).length > 0) {
        this.logger.debug(`No valid faceIds found for album '${album.name}', skipping asset search.`);
      }
      return new Map()
    }

    if (album.logic === 'OR') {
      return this.collectOrAssets(userId, album, faceIds, excludedAssetIds, getFaceName)
    } else {
      return this.collectAndAssets(userId, album, faceIds, excludedAssetIds, getFaceName)
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
    userId: string,
    album: AlbumSettings,
    faceIds: string[],
    excludedAssetIds: Set<string>,
    getFaceName: (id: string) => string
  ): Promise<Map<string, string>> {
    const combined = new Map<string, string>()

    // Each face must be queried individually. Immich's searchAssets treats
    // multiple personIds as AND (all persons must appear in the photo), not OR.
    // We union the per-face results ourselves to achieve OR semantics.
    for (const faceId of faceIds) {
      const label = getFaceName(faceId)
      const syncDate = this.syncState[userId]?.[album.name]?.faces?.[label] || null;
      const assets = await this.fetchAllAssetIdsForPersons(
        [faceId],
        label,
        excludedAssetIds,
        syncDate,
        album.minNamedFaces !== undefined
      );
      for (const [id, info] of assets) {
        if (album.minNamedFaces !== undefined && this.countNamedFaces(info) < album.minNamedFaces) {
          continue;
        }
        combined.set(id, info.checksum);
      }
    }

    this.logger.debug(`OR logic: union count = ${combined.size}`)
    return combined
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
    userId: string,
    album: AlbumSettings,
    faceIds: string[],
    excludedAssetIds: Set<string>,
    getFaceName: (id: string) => string
  ): Promise<Map<string, string>> {
    // For AND logic, if any face is new (no sync date), we must do a full
    // sync for ALL faces — an incremental fetch on old faces would miss
    // historical assets that now match the full intersection.
    const anyNew = faceIds.some(
      id => !this.syncState[userId]?.[album.name]?.faces?.[getFaceName(id)]
    );
    if (anyNew) {
      this.logger.debug('AND logic: new face detected, performing full sync for all faces in this album')
    }

    const perFaceMaps: Map<string, FetchedAssetInfo>[] = []

    for (const faceId of faceIds) {
      const label = getFaceName(faceId)
      const syncDate = anyNew
        ? null
        : (this.syncState[userId]?.[album.name]?.faces?.[label] || null)
      const assetMap = await this.fetchAllAssetIdsForPersons(
        [faceId],
        label,
        excludedAssetIds,
        syncDate,
        album.minNamedFaces !== undefined
      );
      perFaceMaps.push(assetMap)
    }

    const [first, ...rest] = perFaceMaps
    const intersectedIds = [...first.keys()].filter(id => rest.every(m => m.has(id)))
    const result = new Map<string, string>()
    for (const id of intersectedIds) {
      const info = first.get(id)!
      if (album.minNamedFaces !== undefined && this.countNamedFaces(info) < album.minNamedFaces) {
        continue;
      }
      result.set(id, info.checksum);
    }
    this.logger.debug(`AND logic: intersection count = ${result.size}`)
    return result
  }

  /**
   * Fetches assets for count-only albums across all pages, filtering by minNamedFaces
   * and evaluating exclusions directly in-memory against asset.people.
   */
  private async fetchAllAssetsForMinFaces(
    userId: string,
    album: AlbumSettings,
    excludeFaceIds: string[]
  ): Promise<Map<string, string>> {
    const syncDate = this.syncState[userId]?.[album.name]?.lastAlbumSync;
    const candidates = new Map<string, string>();
    let nextPage: any = 1;

    do {
      this.logger.debug(`Fetching page ${nextPage} for count-only album [${album.name}]`);
      const dto: any = {
        page: Number(nextPage),
        size: PAGE_SIZE,
        withPeople: true,
      };
      if (syncDate) {
        dto.updatedAfter = syncDate;
      }
      const result = await searchAssets({ metadataSearchDto: dto });
      const items = result.assets?.items || [];

      for (const asset of items) {
        // In-Memory Exclusion Check:
        const isExcluded = (asset.people || []).some(
          p =>
            excludeFaceIds.includes(p.id) ||
            (p.name && album.excludeFaceNames?.includes(p.name))
        );
        if (isExcluded) {
          continue;
        }        

        // Threshold Evaluation:
        if (this.countNamedFaces(asset) >= (album.minNamedFaces ?? 1)) {
          candidates.set(asset.id, asset.checksum);
        }
      }

      this.logger.debug(`Fetched ${items.length} assets for count-only album [${album.name}] (page ${nextPage})`);
      nextPage = result.assets?.nextPage ?? null;
    } while (nextPage !== null);

    return candidates;
  }

  /**
   * Adds the given assets to the Immich album.
   * Does nothing if `assetIds` is empty.
   *
   * @param album    - The target album.
   * @param assetIds - IDs of assets to add.
   * @returns Number of assets added.
   */
  private async addAssets(
    album: AlbumSettings,
    candidates: Map<string, string>,
    existingChecksums: Set<string>
  ): Promise<{ added: number; skipped: number }> {

    const toAdd: string[] = []
    let skipped = 0

    for (const [id, checksum] of candidates) {
      if (existingChecksums.has(checksum)) {
        skipped++
      } else {
        toAdd.push(id)
        existingChecksums.add(checksum)
      }
    }

    this.logger.debug(`${toAdd.length} new asset(s) to add, ${skipped} cross-user duplicate(s) skipped`)
    this.logger.debug('Asset IDs to add:', toAdd)

    if (toAdd.length === 0) {
      return { added: 0, skipped }
    }

    // Batch to avoid oversized request payloads on large first-run syncs.
    for (let i = 0; i < toAdd.length; i += BATCH_SIZE) {
      await addAssetsToAlbum({ id: album.albumId, bulkIdsDto: { ids: toAdd.slice(i, i + BATCH_SIZE) } })
    }
    return { added: toAdd.length, skipped }
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
    excludeFaceIds: string[]
  ): Promise<number> {
    if (excludeFaceIds.length === 0) return 0

    try {
      // Query each excluded face individually and union results.
      // A single call with multiple personIds uses AND semantics in Immich,
      // which would only find photos where ALL excluded people appear together.
      const toRemove = new Set<string>()

      for (const faceId of excludeFaceIds) {
        let nextPage: any = 1
        do {
          const result = await searchAssets({
            metadataSearchDto: { albumIds: [album.albumId], personIds: [faceId], page: Number(nextPage), size: PAGE_SIZE }
          })
          const items = result.assets?.items || []
          for (const a of items) toRemove.add(a.id)
          this.logger.debug(`Fetched ${items.length} excluded assets in album for [${faceId}] (page ${nextPage})`)
          nextPage = result.assets?.nextPage ?? null
        } while (nextPage !== null)
      }

      if (toRemove.size === 0) return 0

      const ids = [...toRemove]
      // Batch to avoid oversized request payloads.
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        await removeAssetFromAlbum({ id: album.albumId, bulkIdsDto: { ids: ids.slice(i, i + BATCH_SIZE) } })
      }
      this.logger.debug(`Removed ${toRemove.size} excluded asset(s) from album '${album.name}'`)
      return toRemove.size
    } catch (err) {
      this.logger.error('Error removing excluded assets from album:', err)
      throw err
    }
  }

  private loadSyncState(): SmartAlbumSyncState {
    try {
      if (fs.existsSync(this.syncFilePath)) {
        const content = fs.readFileSync(this.syncFilePath, 'utf-8').trim();
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const migrated: SmartAlbumSyncState = {};
          for (const [userId, userState] of Object.entries(parsed)) {
            migrated[userId] = {};
            if (userState && typeof userState === 'object' && !Array.isArray(userState)) {
              for (const [albumName, albumState] of Object.entries(userState as Record<string, any>)) {
                if (albumState && typeof albumState === 'object' && !Array.isArray(albumState)) {
                  if (albumState.faces && typeof albumState.faces === 'object') {
                    migrated[userId][albumName] = albumState as AlbumSyncState;
                  } else {
                    // Migrate legacy flat { [faceName]: timestamp } dictionary
                    migrated[userId][albumName] = {
                      faces: { ...albumState }
                    };
                  }
                }
              }
            }
          }
          this.logger.debug(`Loaded sync state for ${Object.keys(migrated).length} user(s)`);
          return migrated;
        }
        this.logger.warn('Sync state file is invalid — starting fresh (full re-sync)')
      }
    } catch (err) {
      this.logger.error('Error reading sync state:', err)
    }
    return {}
  }

  private saveSyncState(): void {
    try {
      fs.writeFileSync(this.syncFilePath, JSON.stringify(this.syncState, null, 2), 'utf-8')
      this.logger.debug(`Sync state saved`)
    } catch (err) {
      this.logger.error('Error saving sync state:', err)
    }
  }
}
