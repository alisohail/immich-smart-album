/**
 * Top-level configuration for the smart album service.
 * Loaded from `config.json` at startup.
 */
export interface SmartAlbumConfig {
  /** Base URL of the Immich server (e.g. `http://192.168.1.10:2283`). */
  immichServer: string
  /** Cron expression controlling how often albums are synced. Defaults to `'0,30 * * * *'`. */
  schedule?: string
  /** One entry per Immich user whose albums should be managed. */
  users: ImmichClient[]
  /** Optional global settings such as log verbosity. */
  options?: SmartAlbumOptions
}

/**
 * Global runtime options for the smart album manager.
 */
export interface SmartAlbumOptions {
  /**
   * Controls log verbosity.
   * - `'info'`  – standard operational messages (default).
   * - `'debug'` – verbose output including raw API responses and asset ID lists.
   */
  logLevel?: 'debug' | 'info'
}

/**
 * Represents a single Immich user and all albums the service should manage for them.
 */
export interface ImmichClient {
  /** Immich API key used to authenticate requests on behalf of this user. */
  apiKey: string
  /** Albums to create and maintain for this user. */
  albums: AlbumSettings[]
}

/**
 * Configuration for a single smart album.
 */
export interface AlbumSettings {
  /** Human-readable name used in logs and summaries. */
  name: string
  /** Immich album ID to add assets to (must already exist in Immich). */
  albumId: string
  /** Person names whose assets should be included in the album. */
  faceNames: string[]
  /** Person names whose assets should be excluded from the album, even if they match `faceNames`. */
  excludeFaceNames?: string[]
  /**
   * Determines how multiple `faceNames` are combined:
   * - `'OR'`  – include assets containing **any** of the listed persons.
   * - `'AND'` – include only assets containing **all** of the listed persons.
   */
  logic: 'AND' | 'OR'
}
