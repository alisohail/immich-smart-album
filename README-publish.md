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
    - `faceNames`: (array of strings) Only faceNames are supported; these people must be present in the photo.
    - `excludeFaceNames`: (array of strings, optional) If any of these people are present in a photo, it will be excluded from the album.
    - `logic`: ("AND" or "OR")
      - "AND": Only photos containing all listed `faceNames` are included.
      - "OR": Photos containing any of the listed `faceNames` are included.
- `options`: (object)
  - `logLevel`: ("info" or "debug") Controls the verbosity of log output.

### Config Validation Rules

- **`name` must be unique** across all users and albums. It is used as the sync state key — two entries sharing the same name would overwrite each other's incremental sync dates.
- **`albumId` must be unique** across all users and albums. Pointing two entries at the same Immich album would cause it to be processed twice per run and produce incorrect sync state.

Both rules are validated on startup. The container will exit with a clear error message if either is violated.

### Incremental Sync

A `.sync-state.json` file is written to the `/config` directory after each successful sync. It tracks the last successful sync date per album per face name, enabling incremental syncs:

- **First run:** all face photos are fetched and added.
- **Subsequent runs:** only photos updated since the last sync are fetched, keeping API calls minimal.
- **New face added to an existing album:** the new face triggers a full re-scan of all faces in that album (required for AND logic correctness) or only that face (OR logic).
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
          "albumId": "your-album-id",
          "faceNames": ["Alice", "Bob"],
          "excludeFaceNames": ["Eve", "Mallory"],
          "logic": "OR"
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