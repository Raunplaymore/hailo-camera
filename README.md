# camera-capture-server

rpicam(libcamera 파이프라인) 기반 Raspberry Pi용 Node.js/Express 캡처 서버입니다. 캡처 결과를 기본적으로 `/home/ray/uploads`에 저장하고 REST API를 제공합니다. 인메모리 플래그와 `/tmp/camera.lock` 파일로 동시 요청을 막습니다.

## 요구사항

- Raspberry Pi OS + rpicam 앱 (`rpicam-still`, `rpicam-vid`, `rpicam-hello`) — 구 버전 libcamera CLI도 자동 폴백
- ffmpeg (mp4 리먹스 용)
- Node.js 18+

## 설치 및 실행

```bash
npm install
npm start        # PORT에서 시작 (기본 3001)
```

### 환경 변수 옵션

- `PORT`: HTTP 포트 (기본 3001)
- `AUTH_TOKEN`: 설정 시 모든 `/api/*` 라우트에 Bearer 토큰 필요
- `CORS_ALLOW_ALL=true`: 전역 CORS 허용. 또는 `CORS_ORIGIN`에 허용 origin을 콤마로 나열
- `DEFAULT_WIDTH`, `DEFAULT_HEIGHT`, `DEFAULT_FPS`, `DEFAULT_STILL_DURATION_SEC`, `DEFAULT_VIDEO_DURATION_SEC`: 기본값 재정의
- `ANALYZE_URL`: 분석 요청 대상 URL (기본 `http://127.0.0.1:3000/api/analyze/from-file`)
- `CAMERA_STILL_CMDS`, `CAMERA_VIDEO_CMDS`, `CAMERA_HELLO_CMDS`: 사용할 rpicam/libcamera 명령을 콤마로 지정 (기본은 `rpicam-*` → `libcamera-*` 순서)
- `LIBAV_VIDEO_CODEC`: rpicam-vid `--codec libav` 사용 시 비디오 코덱(기본 `libx264`)
- `UPLOAD_DIR`: 캡처 파일 저장 절대경로 (기본 `/home/ray/uploads`)
- `STREAM_TOKEN`: `/api/camera/stream.mjpeg` 접근에 필요한 토큰. 설정 시 `?token=` 또는 `X-Stream-Token` 헤더와 일치해야 함
- `VITE_API_BASE_LOCAL`, `VITE_API_BASE_PI`: 프런트엔드에서 사용할 API 주소를 저장. 상황에 맞게 `VITE_API_BASE`에 복사해 사용

`/uploads` 라우트는 `UPLOAD_DIR`을 가리키며, 서버 시작 시 해당 디렉터리가 자동 생성됩니다.

## API

### POST /api/camera/capture

요청 JSON:

```json
{
  "filename": "optional",
  "format": "h264|mp4|jpg",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "durationSec": 3
}
```

- `format` 기본값은 `jpg`. `mp4`는 rpicam-vid가 설치된 경우 `--codec libav --libav-format mp4`를 이용해 직접 mp4를 생성하며, rpicam이 없을 때만 h264 + ffmpeg 리먹스 방식을 폴백으로 사용합니다.
- `filename`은 sanitize 처리되며, 없으면 `ray_golf_YYYYMMDD_HHMMSS_mmm_swing.<ext>` 패턴으로 생성됩니다.

성공 응답:

> NOTE: `mp4` 녹화는 `/home/ray/uploads/<filename>.mp4.part`로 먼저 기록한 뒤 완료 시 `.mp4`로 atomic rename 합니다. `.part`는 미완성 파일이므로 백엔드에서는 `.mp4`만 사용하세요.

```json
{
  "ok": true,
  "filename": "20240101_120000_1920x1080_30fps_3s.mp4",
  "url": "/uploads/20240101_120000_1920x1080_30fps_3s.mp4"
}
```

### POST /api/camera/capture-and-analyze

`/capture`와 동일한 바디. 캡처 완료 후 `{ filename }`(필요 시 `force` 플래그)만 `ANALYZE_URL`(기본 `http://127.0.0.1:3000/api/analyze/from-file`)로 전달해 기존 `.mp4` 분석을 트리거합니다. 성공 시 `{ ok: true, jobId, filename, status: "queued" }` 반환. 녹화는 먼저 `.mp4.part`로 저장한 뒤 완료 시 `.mp4`로 rename되므로, 백엔드는 `.mp4` 파일만 처리하면 됩니다.

### GET /api/camera/status

`{ ok: true, cameraDetected, busy, streaming, streamClients, lastCaptureAt?, lastError? }` 반환. 카메라 감지는 `rpicam-hello --list-cameras` → `rpicam-still --list-cameras` (필요 시 libcamera CLI로 폴백) 순으로 시도합니다. `busy`는 캡처 또는 스트리밍 중임을 의미하며, `streaming`/`streamClients`로 상세 상태를 확인할 수 있습니다.

### GET /uploads/:name

캡처된 파일 정적 서빙.

### GET /api/camera/stream.mjpeg

실시간 MJPEG 스트림. 쿼리 파라미터로 `width`, `height`, `fps`를 받을 수 있으며 기본값은 `640x360 @ 15fps`입니다. 내부적으로 `rpicam-vid --codec yuv420 -o - | ffmpeg -f mpjpeg -q:v 5 -` 파이프라인을 실행하고, 응답은 `multipart/x-mixed-replace` 포맷으로 전송됩니다. 동시 스트림은 1개만 허용되며, `STREAM_TOKEN`이 설정되어 있으면 `?token=<TOKEN>`(또는 `X-Stream-Token` 헤더)로 전달해야 합니다. 클라이언트 종료 시 상태가 즉시 반영되고, 필요 시 `POST /api/camera/stream/stop`으로 관리자 강제 종료가 가능합니다.

### POST /api/camera/stream/stop

관리자용 스트림 강제 종료. 활성 스트림이 있다면 정리 후 `{ ok:true, stopped:true }`, 없으면 `{ ok:true, stopped:false }`를 반환합니다.

## 락 & 타임아웃

- 인메모리 플래그 + `/tmp/camera.lock` 파일을 사용하며, 만료 검사로 크래시 후 남은 락을 정리.
- 동시 캡처 요청은 HTTP 409 반환.
- 각 명령은 `durationSec * 1000 + 3s` 타임아웃( mp4 리먹스 시간 추가). 초과 시 HTTP 504.

## 로깅

- 요청, 실행 명령, stdout/stderr(일부만) 콘솔 출력.
- `lastError`는 상태 엔드포인트에 노출.

## 스모크 테스트

서버 실행 상태와 카메라 하드웨어가 필요합니다.

```bash
npm test                # runs scripts/smoke_test.js
PORT=3001 node scripts/smoke_test.js
```

인증이 켜져 있으면 `SMOKE_TOKEN` 또는 `AUTH_TOKEN`을 설정하세요.

## curl 예시

```bash
# Status
# 예상: {"ok":true,"cameraDetected":true/false,"busy":false,...}
curl -s http://localhost:3001/api/camera/status

# JPG capture (1s)
# 예상: {"ok":true,"filename":"...jpg","url":"/uploads/....jpg"}
curl -X POST http://localhost:3001/api/camera/capture \
  -H "Content-Type: application/json" \
  -d '{"format":"jpg","durationSec":1,"width":1280,"height":720}'

# H264 capture
# 예상: {"ok":true,"filename":"...h264","url":"/uploads/....h264"}
curl -X POST http://localhost:3001/api/camera/capture \
  -H "Content-Type: application/json" \
  -d '{"format":"h264","durationSec":5,"fps":30}'

# MP4 capture with default name
# 예상: {"ok":true,"filename":"...mp4","url":"/uploads/....mp4"}
curl -X POST http://localhost:3001/api/camera/capture \
  -H "Content-Type: application/json" \
  -d '{"format":"mp4","durationSec":5,"fps":30}'

# Capture then analyze
# 예상: {"ok":true,"jobId":"...","filename":"...jpg","status":"queued","url":"/uploads/...jpg"}
curl -X POST http://localhost:3001/api/camera/capture-and-analyze \
  -H "Content-Type: application/json" \
  -d '{"format":"jpg","durationSec":1}'

# Live MJPEG stream (token required when `STREAM_TOKEN` set)
curl -o stream.mjpeg "http://localhost:3001/api/camera/stream.mjpeg?token=$STREAM_TOKEN"

# Force stop stream
curl -X POST http://localhost:3001/api/camera/stream/stop
```

인증이 켜져 있으면 `-H "Authorization: Bearer $AUTH_TOKEN"` 추가.

## 오류 코드

- `400` 잘못된 파라미터
- `401` 인증 실패 (AUTH_TOKEN 설정 시 필요)
- `409` 카메라 사용 중 (캡처 락 또는 스트리밍)
- `500` 캡처/ffmpeg/분석 실패
- `504` 명령 타임아웃
