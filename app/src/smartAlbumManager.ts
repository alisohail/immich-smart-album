import { ImmichClient, AlbumSettings, SmartAlbumConfig } from './types'
import { createLogger } from './utils'
import { init, addAssetsToAlbum, searchAssets, searchPerson, removeAssetFromAlbum } from '@immich/sdk'

export class SmartAlbumManager {
  private config: SmartAlbumConfig
  private logger: ReturnType<typeof createLogger>
  private logLevel: 'debug' | 'info'

  constructor(config: SmartAlbumConfig) {
    this.config = config
    this.logLevel = config.options?.logLevel || 'info'
    this.logger = createLogger(this.logLevel)
  }

  async run() {
    for (const user of this.config.users) {
      try {
        init({ baseUrl: this.config.immichServer + '/api', apiKey: user.apiKey })
        for (const album of user.albums) {
          await this.processAlbum(album, user.apiKey)
        }
      } catch (err) {
        this.logger.error('User processing failed', err)
      }
    }
  }

  async processAlbum(album: AlbumSettings, apiKey: string) {
    // Helper to resolve names to IDs
    const resolveNames = async (names: string[] = [], label = 'face') => {
      const ids: string[] = []
      for (const name of names) {
        try {
          const result = await searchPerson({ name })
          if (result && Array.isArray(result) && result.length > 0) {
            ids.push(result[0].id)
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

    // Map faceNames to IDs and keep a reverse map for logging
    const faceNameToId: Record<string, string> = {}
    const excludeFaceNameToId: Record<string, string> = {}
    const faceIds: string[] = []
    for (const name of album.faceNames || []) {
      const ids = await resolveNames([name], 'face')
      if (ids[0]) {
        faceIds.push(ids[0])
        faceNameToId[name] = ids[0]
      }
    }
    const excludeFaceIds: string[] = []
    for (const name of album.excludeFaceNames || []) {
      const ids = await resolveNames([name], 'exclude face')
      if (ids[0]) {
        excludeFaceIds.push(ids[0])
        excludeFaceNameToId[name] = ids[0]
      }
    }

    // Helper to get face name from id for logging
    const getFaceName = (id: string) => {
      for (const [name, fid] of Object.entries(faceNameToId)) if (fid === id) return name
      for (const [name, fid] of Object.entries(excludeFaceNameToId)) if (fid === id) return name
      return id
    }

    if (this.logLevel === 'info') {
      this.logger.info(`Processing album: ${album.name}`)
      this.logger.info(`Logic: ${album.logic}`)
      this.logger.info(`faceNames: ${album.faceNames?.join(', ') || ''}`)
      this.logger.info(`excludeFaceNames: ${album.excludeFaceNames?.join(', ') || ''}`)
    } else {
      this.logger.info(`Processing album: ${album.name}`)
      this.logger.debug('Album details:', album)
    }
    try {
      const PAGE_SIZE = 100
      // For OR: collect all asset IDs in a Set (union)
      // For AND: collect asset IDs per face, then intersect
      let assetIdSets: Array<Set<string>> = []

      // Helper to check if asset should be excluded
      const isExcluded = (asset: any) => {
        if (!excludeFaceIds.length) return false
        const people = Array.isArray(asset.people)
          ? asset.people.map((p: any) => typeof p === 'string' ? p : p.id)
          : []
        return people.some((id: string) => excludeFaceIds.indexOf(id) !== -1)
      }

      if (album.logic === 'OR') {
        // Fetch all assets for all faceIds, page by page, add to a Set
        let assetIdSet = new Set<string>()
        let nextPage: string | null = '1'
        do {
          const faceNamesForLog = faceIds.map(getFaceName)
          this.logger.info(`Fetching page ${nextPage} for faceNames [${faceNamesForLog.join(', ')}]`)
          const params: any = { metadataSearchDto: { personIds: faceIds, page: parseInt(nextPage, 10), size: PAGE_SIZE } }
          const result = await searchAssets(params)
          const items = result.assets?.items || []
          for (const asset of items) {
            if (!isExcluded(asset)) assetIdSet.add(asset.id)
          }
          this.logger.debug(`Fetched ${items.length} assets for faceNames [${faceNamesForLog.join(', ')}] (page ${nextPage})`)
          nextPage = result.assets?.nextPage ?? null
        } while (nextPage !== null)
        assetIdSets.push(assetIdSet)
      } else {
        // AND: For each faceId, fetch all assets, collect IDs in a Set
        for (const faceId of faceIds) {
          let assetIdSet = new Set<string>()
          let nextPage: string | null = '1'
          const faceNameForLog = getFaceName(faceId)
          do {
            this.logger.info(`Fetching page ${nextPage} for faceName [${faceNameForLog}]`)
            const params: any = { metadataSearchDto: { personIds: [faceId], page: parseInt(nextPage, 10), size: PAGE_SIZE } }
            const result = await searchAssets(params)
            const items = result.assets?.items || []
            for (const asset of items) {
              if (!isExcluded(asset)) assetIdSet.add(asset.id)
            }
            this.logger.debug(`Fetched ${items.length} assets for faceName [${faceNameForLog}] (page ${nextPage})`)
            nextPage = result.assets?.nextPage ?? null
          } while (nextPage !== null)
          assetIdSets.push(assetIdSet)
        }
      }

      // Merge/intersect results
      let finalAssetIds: string[] = []
      if (album.logic === 'AND') {
        if (assetIdSets.length > 0) {
          // Intersect all sets
          finalAssetIds = Array.from(assetIdSets.reduce((acc, curr) => new Set([...acc].filter(x => curr.has(x)))))
        }
        this.logger.info(`AND logic: intersection count = ${finalAssetIds.length}`)
      } else {
        // Union
        finalAssetIds = Array.from(assetIdSets[0] || [])
        this.logger.info(`OR logic: union count = ${finalAssetIds.length}`)
      }

      this.logger.info(`Found ${finalAssetIds.length} assets to add to album ${album.name}`)
      this.logger.debug('Asset IDs:', finalAssetIds)

      let addedCount = 0
      if (finalAssetIds.length > 0) {
        await addAssetsToAlbum({ id: album.albumId, bulkIdsDto: { ids: finalAssetIds } })
        this.logger.info(`Added assets to album ${album.name}`)
        addedCount = finalAssetIds.length
      } else {
        this.logger.info('No assets found to add.')
      }

      // Remove excluded assets already in the album
      let removedCount = 0
      if (excludeFaceIds.length > 0) {
        try {
          const albumInfo = await (await import('@immich/sdk')).getAlbumInfo({ id: album.albumId })
          const albumAssets = albumInfo?.assets || []
          const toRemove = albumAssets.filter(asset => {
            const people = Array.isArray(asset.people)
              ? asset.people.map((p: any) => typeof p === 'string' ? p : p.id)
              : []
            return people.some((id: string) => excludeFaceIds.indexOf(id) !== -1)
          })
          if (toRemove.length > 0) {
            await removeAssetFromAlbum({ id: album.albumId, bulkIdsDto: { ids: toRemove.map(a => a.id) } })
            this.logger.info(`Removed ${toRemove.length} excluded assets from album ${album.name}`)
            removedCount = toRemove.length
          }
        } catch (err) {
          this.logger.error('Error removing excluded assets from album:', err)
        }
      }

      // --- Summary Output ---
      const summary = {
        album: album.name,
        albumId: album.albumId,
        logic: album.logic,
        faceNames: album.faceNames,
        excludeFaceNames: album.excludeFaceNames,
        addedCount,
        removedCount
      }
      this.logger.info('--- Album Processing Summary ---')
      this.logger.info(`Album: ${summary.album}`)
      this.logger.info(`Logic: ${summary.logic}`)
      this.logger.info(`faceNames: ${summary.faceNames?.join(', ') || ''}`)
      this.logger.info(`excludeFaceNames: ${summary.excludeFaceNames?.join(', ') || ''}`)
      this.logger.info(`Assets added: ${summary.addedCount}`)
      this.logger.info(`Assets removed: ${summary.removedCount}`)
      this.logger.info('------------------------------')
      this.logger.debug('Summary object:', summary)
    } catch (err) {
      this.logger.error('Error processing album', err)
    }
  }
}
