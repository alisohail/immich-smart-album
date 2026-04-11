# Immich Smart Album (Docker Image)

## Overview
This guide is for end users who want to use the published Docker image (e.g., from Docker Hub) to run Immich Smart Album without building from source.

## Prerequisites
- Docker and Docker Compose installed
- Immich server running and accessible
- Immich API key(s) for the user(s) you want to manage albums for

## Setup
1. Prepare your `data/config.json` as described below.
2. Place the following `docker-compose.yml` in your working directory:

```yaml
version: '3.8'
services:
  immich-smart-album:
    image: ssultanali/immich-smart-album:latest
    container_name: immich-smart-album
    volumes:
      - ./data:/data
    restart: "always"
```

- Make sure your `data/config.json` is in the same directory as your compose file.

### Example `data/config.json`
```json
{
  "immichServer": "https://your-immich-server",
  "users": [
    {
      "apiKey": "YOUR_API_KEY",
      "albums": [
        {
          "name": "Family Album",
          "albumId": "your-album-id",
          "faceIds": ["face-id-1", "face-id-2"],
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
From the directory containing your `docker-compose.yml` and `data/config.json`:

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
