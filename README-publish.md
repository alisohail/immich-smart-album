# Immich Smart Album (Docker Image)

## Overview
This guide is for end users who want to use the published Docker image (e.g., from Docker Hub) to run Immich Smart Album without building from source.

## GitHub Repository
Find the source code and contribute at: [Immich Smart Album GitHub Repository](https://github.com/alisohail/immich-smart-album)

## Prerequisites
- Docker and Docker Compose installed
- Immich server running and accessible
- Immich API key(s) for the user(s) you want to manage albums for

## Setup
1. Prepare your `config/config.json` as described below.
2. Place the following `docker-compose.yml` in your working directory:

```yaml
version: '3.8'
services:
  immich-smart-album:
    image: ssultanali/immich-smart-album:latest
    container_name: immich-smart-album
    volumes:
      - ./config:/config
    restart: "always"
```

- Make sure your `config/config.json` is in the same directory as your compose file.

### Configuration Key Explanations

- `immichServer`: The base URL of your Immich server (e.g., `http://your-immich-server:port`).
- `schedule`: (optional, string) A cron expression for how often to sync albums (e.g., `"0,30 * * * *"` for every 30 minutes). If omitted, the default is every 30 minutes. On container start, the app will always run once immediately, then follow the schedule.
- `users`: An array of user objects, each with:
  - `apiKey`: The Immich API key for this user.
  - `albums`: An array of album objects, each with:
    - `name`: (string) For your reference only; not used as the Immich album title.
    - `albumId`: (string) The Immich album UUID to manage.
    - `faceNames`: (array of strings, optional) Only faceNames are supported; these people must be present in the photo.
    - `excludeFaceNames`: (array of strings, optional) If any of these people are present in a photo, it will be excluded from the album.
    - `minNamedFaces`: (integer >= 1, optional) Minimum number of distinct recognized/named persons required in the photo.
    - `logic`: ("AND" or "OR", optional)
      - "AND": Only photos containing all listed `faceNames` are included.
      - "OR": Photos containing any of the listed `faceNames` are included.
      - *Note:* Required if `faceNames` contains 2 or more names; optional when 0 or 1 names are configured.
- `options`: (object)
  - `logLevel`: ("info" or "debug") Controls the verbosity of log output.

### Config Validation Rules

- **`name` must be unique** across all users and albums. It is used as the sync state key — two entries sharing the same name would overwrite each other's incremental sync dates.
- **`albumId` must be unique** within each user's album list. Pointing two entries within the same user at the same Immich album would cause duplicate processing.
- **`faceNames` or `minNamedFaces` required**: Every album must specify at least one of non-empty `faceNames` or `minNamedFaces >= 1`.
- **`minNamedFaces` must be a positive integer** (>= 1) when configured.
- **`logic` operator**: If specified, must strictly be `"AND"` or `"OR"`. It is required whenever `faceNames` contains 2 or more names.

All rules are validated on startup. The container will exit with a clear error message if any rule is violated.

### Incremental Sync

A `.sync-state.json` file is written to the `/config` directory after each successful sync. It tracks structured timestamps (`faces` for person-based searches, `lastAlbumSync` for count-only albums) and recorded thresholds (`minNamedFaces`):

- **First run:** all matching photos are fetched and added.
- **Subsequent runs:** only photos updated since the last sync are fetched, keeping API calls minimal.
- **New face added to an existing album:** the new face triggers a full re-scan of all faces in that album (required for AND logic correctness) or only that face (OR logic).
- **Threshold modifications:** changing `minNamedFaces` (increased, decreased, added, or removed) automatically invalidates the album's sync state to force a full re-evaluation.
- **Additive synchronization:** Synchronization is strictly additive (except for explicit exclusions in `excludeFaceNames`). Increasing `minNamedFaces` applies to subsequent syncs but does not prune existing lower-count photos.
- **Late naming limitation:** If people in older photos are named in Immich long after upload, Immich may not advance `updatedAt`. Photos uploaded prior to being named will not be discovered incrementally unless a full resync is triggered.
- **Sync state is only updated after a fully successful album sync.** If any step fails, the album will be fully re-evaluated on the next run.

> Do not edit `.sync-state.json` manually unless you want to force a full re-sync. To reset a specific album, delete its entry from the file or delete the file entirely.

### Example config/config.json
```json
{
  "immichServer": "https://your-immich-server",
  "schedule": "0,30 * * * *",
  "users": [
    {
      "apiKey": "YOUR_API_KEY",
      "albums": [
        {
          "name": "Family Album",
          "albumId": "your-album-id-1",
          "faceNames": ["Alice", "Bob"],
          "excludeFaceNames": ["Eve", "Mallory"],
          "logic": "OR"
        },
        {
          "name": "Group Photos",
          "albumId": "your-album-id-2",
          "minNamedFaces": 3
        },
        {
          "name": "Alice with Friends",
          "albumId": "your-album-id-3",
          "faceNames": ["Alice"],
          "minNamedFaces": 2
        }
      ]
    }
  ],
  "options": {
    "logLevel": "info"
  }
}
```

## Running
From the directory containing your `docker-compose.yml` and `config/config.json`:

```
docker compose up -d
```

- The container will start, process albums, and exit when done.
- Logs will be available via `docker logs immich-smart-album`.

## Updating
To update, pull the latest image and re-run:
```
docker compose pull
```

## Troubleshooting
- Ensure your Immich server and API key are correct.
- Check logs for errors or warnings.
- Set `logLevel` to `debug` or `info` for more details.


## License
MIT