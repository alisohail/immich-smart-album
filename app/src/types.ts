
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
  albums: AlbumLogic[]
}

export interface AlbumLogic {
  name: string
  albumId: string
  faceIds: string[]
  logic: 'AND' | 'OR'
}
