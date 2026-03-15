# Remote Storage Manager (RSM)

Two-part project:
- `apps/service`: Remote host file-management service (Fastify + TypeScript)
- `apps/client`: Cross-platform desktop GUI (Electron + React + Vite)

## Core Workflows

- Duplicate detection (size-first, then checksum, with a persistent on-disk hash cache for unchanged files)
- Remote directory browsing from the client to choose duplicate-scan roots
- Archive vs directory duplicate comparison
- File organization by type and date (`/pictures/2015/Jan`)
- Archive creation after organization

## Monorepo Layout

- `apps/service` remote API service
- `apps/client` desktop GUI client
- `packages/shared` shared DTO/types
- `docs` architecture and roadmap
- `scripts` helper scripts

## Quick Start

```bash
npm install
npm run build
```

Run service:

```bash
npm run dev:service
```

The service stores duplicate-scan metadata in `.rsm/file-metadata.db` under its working directory. Cached checksums are reused when file size and timestamps have not changed, stale entries are pruned as scanned roots are revisited, and the service will import the older JSON cache file automatically the first time the SQLite database is created.

Run desktop client:

```bash
npm run dev:client
```

`dev:client` is the development mode and runs both a Vite renderer server and Electron.

Run desktop client as a single app process (no separate renderer server):

```bash
npm run start:client
```

## Deployment Notes

- OpenRC template: `apps/service/deploy/rsm-service.openrc`
- systemd template: `apps/service/deploy/rsm-service.service`

## Status

This is a foundation scaffold with working API/UI shells and job modules.
