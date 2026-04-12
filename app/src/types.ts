
export interface SmartAlbumConfig {
  immichServer: string
  schedule?: string
  users: ImmichClient[]
  options?: SmartAlbumOptions
}

export interface SmartAlbumOptions {
  logLevel?: 'debug' | 'info'
}

export interface ImmichClient {
  apiKey: string
  albums: AlbumSettings[]
}

export interface AlbumSettings {
  name: string
  albumId: string
  faceNames: string[]
  excludeFaceNames?: string[]
  logic: 'AND' | 'OR'
}
