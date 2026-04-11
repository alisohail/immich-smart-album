import { ImmichClient, AlbumLogic, SmartAlbumConfig } from './types'
import { createLogger } from './utils'
import { init, addAssetsToAlbum, searchAssets } from '@immich/sdk'

export class SmartAlbumManager {
  private config: SmartAlbumConfig
  private logger: ReturnType<typeof createLogger>

  constructor(config: SmartAlbumConfig) {
    this.config = config
    const logLevel = config.options?.logLevel || 'info'
    this.logger = createLogger(logLevel)
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

  async processAlbum(album: AlbumLogic, apiKey: string) {
    this.logger.info(`Processing album: ${album.name}`)
    this.logger.debug('Album details:', album)
    try {
      const assetResults: any[][] = []
      const PAGE_SIZE = 10
      if (album.logic === 'OR') {
        // OR: Query all faceIds together in one paginated loop
        let allAssets: any[] = []
        let nextPage: string | null = '1'
        while (nextPage !== null) {
          this.logger.info(`Fetching page ${nextPage} for faceIds [${album.faceIds.join(', ')}]`)
          const params: any = { metadataSearchDto: { personIds: album.faceIds, page: parseInt(nextPage, 10), size: PAGE_SIZE } }
          const result = await searchAssets(params)
          const items = result.assets?.items || []
          allAssets = allAssets.concat(items)
          this.logger.debug(`Fetched ${items.length} assets for faceIds [${album.faceIds.join(', ')}] (page ${nextPage})`)
          nextPage = result.assets?.nextPage ?? null
        }
        this.logger.info(`FaceIds [${album.faceIds.join(', ')}]: fetched=${allAssets.length}`)
        assetResults.push(allAssets)
      } else {
        // AND: Query each faceId separately, then intersect
        for (const faceId of album.faceIds) {
          this.logger.debug(`Searching assets for faceId: ${faceId}`)
          let allAssets: any[] = []
          let nextPage: string | null = '1'
          while (nextPage !== null) {
            this.logger.info(`Fetching page ${nextPage} for faceId ${faceId}`)
            const params: any = { metadataSearchDto: { personIds: [faceId], page: parseInt(nextPage, 10), size: PAGE_SIZE } }
            const result = await searchAssets(params)
            const items = result.assets?.items || []
            allAssets = allAssets.concat(items)
            this.logger.debug(`Fetched ${items.length} assets for faceId ${faceId} (page ${nextPage})`)
            nextPage = result.assets?.nextPage ?? null
          }
          this.logger.info(`FaceId ${faceId}: fetched=${allAssets.length}`)
          assetResults.push(allAssets)
        }
      }

      let finalAssets: any[] = []
      if (album.logic === 'AND') {
        // Intersection: assets that appear for all faceIds
        if (assetResults.length > 0) {
          finalAssets = assetResults.reduce((acc, curr) =>
            acc.filter(a => curr.some(b => b.id === a.id))
          )
        }
        this.logger.info(`AND logic: intersection count = ${finalAssets.length}`)
      } else {
        // OR: Union of all assets
        const assetMap = new Map<string, any>()
        for (const arr of assetResults) {
          for (const asset of arr) {
            assetMap.set(asset.id, asset)
          }
        }
        finalAssets = Array.from(assetMap.values())
        this.logger.info(`OR logic: union count = ${finalAssets.length}`)
      }

      this.logger.info(`Found ${finalAssets.length} assets to add to album ${album.albumId}`)
      this.logger.debug('Asset IDs:', finalAssets.map(a => a.id))

      if (finalAssets.length > 0) {
        // Latest Immich SDK expects: { id: albumId, bulkIdsDto: { ids: [...] } }
        await addAssetsToAlbum({ id: album.albumId, bulkIdsDto: { ids: finalAssets.map(a => a.id) } })
        this.logger.info(`Added assets to album ${album.albumId}`)
      } else {
        this.logger.info('No assets found to add.')
      }
    } catch (err) {
      this.logger.error('Error processing album', err)
    }
  }
}
