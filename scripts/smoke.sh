#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:${PORT:-3001}}"
AUTH_TOKEN="${AUTH_TOKEN:-}"
STREAM_TOKEN="${STREAM_TOKEN:-}"

AUTH_HEADER=()
if [[ -n "$AUTH_TOKEN" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer $AUTH_TOKEN")
fi

STREAM_URL="$BASE_URL/api/camera/stream.mjpeg?width=640&height=360&fps=15"
if [[ -n "$STREAM_TOKEN" ]]; then
  STREAM_URL="$STREAM_URL&token=$STREAM_TOKEN"
fi

echo "Starting preview stream..."
curl -s "$STREAM_URL" -o /tmp/hailo_preview.mjpeg &
STREAM_PID=$!

sleep 1

echo "Starting session..."
SESSION_JSON=$(curl -s "${AUTH_HEADER[@]}" -H "Content-Type: application/json" \
  -X POST "$BASE_URL/api/session/start" \
  -d '{"width":1456,"height":1088,"fps":60,"model":"yolov8s","durationSec":0}')
JOB_ID=$(echo "$SESSION_JSON" | sed -n 's/.*"jobId":"\\([^"]*\\)".*/\\1/p')
META_PATH=$(echo "$SESSION_JSON" | sed -n 's/.*"metaPath":"\\([^"]*\\)".*/\\1/p')
VIDEO_URL=$(echo "$SESSION_JSON" | sed -n 's/.*"videoUrl":"\\([^"]*\\)".*/\\1/p')

if [[ -z "$JOB_ID" ]]; then
  echo "Failed to start session: $SESSION_JSON"
  exit 1
fi

echo "Session jobId=$JOB_ID"
sleep 3

echo "Stopping session..."
curl -s "${AUTH_HEADER[@]}" -X POST "$BASE_URL/api/session/$JOB_ID/stop" >/dev/null

echo "Stopping preview stream..."
kill "$STREAM_PID" >/dev/null 2>&1 || true
curl -s "${AUTH_HEADER[@]}" -X POST "$BASE_URL/api/camera/stream/stop" >/dev/null

if [[ -n "$META_PATH" ]]; then
  echo "Meta path: $META_PATH"
fi
if [[ -n "$VIDEO_URL" ]]; then
  echo "Video URL: $VIDEO_URL"
fi

echo "Done."
