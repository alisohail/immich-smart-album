# Immich Smart Album (Developer Guide)

## Overview
This project creates smart albums in Immich based on face IDs, with support for AND/OR logic, robust logging, and error handling. It is written in TypeScript and runs as a Docker container.

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
4. Edit `data/config.json` as needed (see the publish guide for config format).

## Running Locally (without Docker)
From the `app` directory:

```
npm run dev
```

## Building and Running with Docker
From the project root:

```
docker build -t immich-smart-album .
docker run --rm -v $(pwd)/data:/data immich-smart-album
```

Or use Docker Compose (recommended for end users, see the publish guide):

```
docker compose up -d
```

## End User Guide
For instructions on using the published Docker image and configuring the app as an end user, see [README-publish.md](./README-publish.md).

## License
MIT
