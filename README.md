# camera-capture-server

Node.js/Express capture server for Raspberry Pi with libcamera. Saves captures to `/uploads`, exposes REST APIs, and protects concurrent access with a dual lock (memory + `/tmp/camera.lock`).

## Requirements
- Raspberry Pi OS with libcamera installed (`libcamera-still`, `libcamera-vid`, `libcamera-hello`).
- ffmpeg (for mp4 remux).
- Node.js 18+.

## Install & Run
```bash
npm install
npm start        # starts on PORT (default 3000)
```

### Environment options
- `PORT`: HTTP port (default 3000)
- `AUTH_TOKEN`: Bearer token required for all `/api/*` routes when set.
- `CORS_ALLOW_ALL=true`: enable permissive CORS. Alternatively set `CORS_ORIGIN` to a comma list of allowed origins.
- `DEFAULT_WIDTH`, `DEFAULT_HEIGHT`, `DEFAULT_FPS`, `DEFAULT_STILL_DURATION_SEC`, `DEFAULT_VIDEO_DURATION_SEC`: override defaults.
- `ANALYZE_URL`: override analyze target (default `http://127.0.0.1:PORT/api/analyze`).

Uploads are served statically from `/uploads`. The directory is created automatically on boot.

## API
### POST /api/camera/capture
Body JSON:
```json
{ "filename": "optional", "format": "h264|mp4|jpg", "width": 1920, "height": 1080, "fps": 30, "durationSec": 3 }
```
- `format` default: `jpg`. For `mp4`, video is recorded as `.h264` via `libcamera-vid` then remuxed to `.mp4` with `ffmpeg -c copy`.
- `filename` is sanitized; if omitted: `YYYYMMDD_HHMMSS_{w}x{h}_{fps}fps_{dur}s.{ext}`.

Success:
```json
{ "ok": true, "filename": "20240101_120000_1920x1080_30fps_3s.mp4", "url": "/uploads/20240101_120000_1920x1080_30fps_3s.mp4" }
```

### POST /api/camera/capture-and-analyze
Same body as `/capture`. After capture, forwards `{ filename, path: "/uploads/<file>" }` to `ANALYZE_URL` (or `http://127.0.0.1:PORT/api/analyze`).
Returns `{ ok: true, jobId, filename, status: "queued" }` on success.

### GET /api/camera/status
Returns `{ ok: true, cameraDetected, busy, lastCaptureAt?, lastError? }`. Camera detection uses `libcamera-hello --list-cameras` (falls back to `libcamera-still --list-cameras`).

### GET /uploads/:name
Static file serving for captured assets.

## Locking & timeouts
- Dual lock: in-memory flag plus `/tmp/camera.lock` file with expiry cleanup to avoid stale locks after crashes.
- Concurrent capture requests return HTTP 409.
- Each command uses a timeout of `durationSec * 1000 + 3s` (plus remux time for mp4). Timeouts return HTTP 504.

## Logging
- Logs each request, executed commands, and truncated stdout/stderr to the console.
- `lastError` is exposed via the status endpoint.

## Smoke test
Requires a running server and camera hardware.
```bash
npm test                # runs scripts/smoke_test.js
PORT=3000 node scripts/smoke_test.js
```
Optional: set `SMOKE_TOKEN` or `AUTH_TOKEN` if auth is enabled.

## Example curl commands
```bash
# Status
curl -s http://localhost:3000/api/camera/status

# JPG capture (1s)
curl -X POST http://localhost:3000/api/camera/capture \
  -H "Content-Type: application/json" \
  -d '{"format":"jpg","durationSec":1,"width":1280,"height":720}'

# H264 capture
curl -X POST http://localhost:3000/api/camera/capture \
  -H "Content-Type: application/json" \
  -d '{"format":"h264","durationSec":3,"fps":30}'

# MP4 capture with default name
curl -X POST http://localhost:3000/api/camera/capture \
  -H "Content-Type: application/json" \
  -d '{"format":"mp4","durationSec":3,"fps":30}'

# Capture then analyze
curl -X POST http://localhost:3000/api/camera/capture-and-analyze \
  -H "Content-Type: application/json" \
  -d '{"format":"jpg","durationSec":1}'
```
Add `-H "Authorization: Bearer $AUTH_TOKEN"` when auth is enabled.

## Error codes
- `400` invalid parameters
- `401` unauthorized (AUTH_TOKEN set but missing/invalid)
- `409` camera busy (lock held)
- `500` capture/ffmpeg/analyze failure
- `504` command timeout
