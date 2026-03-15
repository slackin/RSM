# Architecture

## Components

- Service: Fastify API + WebSocket progress channel + job modules
- Client: Electron shell + React UI calling service API
- Shared package: typed request/response contracts

## Duplicate Strategy

1. Collect files and group by file size.
2. Only for size collisions, compute checksum hash.
3. Report hash collisions as duplicate groups.

## Organization Strategy

1. Detect file type by extension (picture/video/audio/document/archive/other).
2. Read file timestamp (`mtime`).
3. Plan destination: `/<type>/<YYYY>/<Mon>/<filename>`.

## Archive Compare

- Enumerate archive entries
- Enumerate directory files
- Compare by relative path + size first, then checksum when needed
