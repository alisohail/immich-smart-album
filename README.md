# Immich Smart Album (Developer Guide)

## Overview
This project creates smart albums in Immich based on face names (person names) and/or minimum named face thresholds (`minNamedFaces`), with support for AND/OR logic, robust logging, and error handling. You can also exclude people from albums using `excludeFaceNames`. It is written in TypeScript and runs as a Docker container.

### Features
- **Face matching**: Match specific recognized persons using `faceNames` with `logic: "AND"` or `logic: "OR"`.
- **Minimum named faces filter (`minNamedFaces`)**: Filter photos to require at least $N$ recognized/named individuals in the photo. Works as a standalone group photo filter (count-only across library) or combined with `faceNames` (hybrid mode).
- **Face exclusions**: Exclude photos containing any person specified in `excludeFaceNames`.
- **Incremental sync**: Fast recurring syncs using `.sync-state.json` to only inspect newly uploaded or modified assets.


## Prerequisites
- Node.js and npm
- Docker (for building/running the container)
- Immich server running and accessible

## Development Setup
1. Clone this repository.
2. Install dependencies:
   ```
   cd app
   npm install
   ```
3. Build the project:
   ```
   npm run build
   ```
4. Edit `config/config.json` as needed (see the publish guide for config format).

## Running Locally (without Docker)
From the `app` directory:

```
npm run dev
```

## Building and Running with Docker
From the project root:

```
docker build -t immich-smart-album .
docker run --rm -v $(pwd)/config:/config immich-smart-album
```

## Published Latest Docker image
Find latest published docker container at https://hub.docker.com/r/ssultanali/immich-smart-album


**How scheduling works:**

When the Docker container starts, the app processes albums immediately on startup, then waits for the next scheduled run (as set in your config or the default schedule). You do not need to wait for the first scheduled time—the sync happens right away, then repeats on schedule.

Or use Docker Compose (recommended for end users, see the publish guide):

```
docker compose up -d
```

## End User Guide
For instructions on using the published Docker image and configuring the app as an end user, see [README-publish.md](./README-publish.md).

## License
MIT
