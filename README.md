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
- `ANALYZE_URL`: 분석 요청 대상 URL (기본 `http://127.0.0.1:PORT/api/analyze`)
- `CAMERA_STILL_CMDS`, `CAMERA_VIDEO_CMDS`, `CAMERA_HELLO_CMDS`: 사용할 rpicam/libcamera 명령을 콤마로 지정 (기본은 `rpicam-*` → `libcamera-*` 순서)
- `UPLOAD_DIR`: 캡처 파일 저장 절대경로 (기본 `/home/ray/uploads`)

`/uploads` 라우트는 `UPLOAD_DIR`을 가리키며, 서버 시작 시 해당 디렉터리가 자동 생성됩니다.

## API
### POST /api/camera/capture
요청 JSON:
```json
{ "filename": "optional", "format": "h264|mp4|jpg", "width": 1920, "height": 1080, "fps": 30, "durationSec": 3 }
```
- `format` 기본값은 `jpg`. `mp4`는 `rpicam-vid`(또는 폴백 명령)로 `.h264` 캡처 후 `ffmpeg -c copy`로 mp4 리먹스.
- `filename`은 sanitize 처리되며, 없으면 `YYYYMMDD_HHMMSS_{w}x{h}_{fps}fps_{dur}s.{ext}` 패턴 사용.

성공 응답:
```json
{ "ok": true, "filename": "20240101_120000_1920x1080_30fps_3s.mp4", "url": "/uploads/20240101_120000_1920x1080_30fps_3s.mp4" }
```

### POST /api/camera/capture-and-analyze
`/capture`와 동일한 바디. 캡처 완료 후 `{ filename, path: "/uploads/<file>" }`를 `ANALYZE_URL`(또는 `http://127.0.0.1:PORT/api/analyze`)로 전달. 성공 시 `{ ok: true, jobId, filename, status: "queued" }` 반환.

### GET /api/camera/status
`{ ok: true, cameraDetected, busy, lastCaptureAt?, lastError? }` 반환. 카메라 감지는 `rpicam-hello --list-cameras` → `rpicam-still --list-cameras` (필요 시 libcamera CLI로 폴백) 순으로 시도합니다.

### GET /uploads/:name
캡처된 파일 정적 서빙.

## 락 & 타임아웃
- 인메모리 플래그 + `/tmp/camera.lock` 파일을 사용하며, 만료 검사로 크래시 후 남은 락을 정리.
- 동시 캡처 요청은 HTTP 409 반환.
- 각 명령은 `durationSec * 1000 + 3s` 타임아웃(	mp4 리먹스 시간 추가). 초과 시 HTTP 504.

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
  -d '{"format":"h264","durationSec":3,"fps":30}'

# MP4 capture with default name
# 예상: {"ok":true,"filename":"...mp4","url":"/uploads/....mp4"}
curl -X POST http://localhost:3001/api/camera/capture \
  -H "Content-Type: application/json" \
  -d '{"format":"mp4","durationSec":3,"fps":30}'

# Capture then analyze
# 예상: {"ok":true,"jobId":"...","filename":"...jpg","status":"queued","url":"/uploads/...jpg"}
curl -X POST http://localhost:3001/api/camera/capture-and-analyze \
  -H "Content-Type: application/json" \
  -d '{"format":"jpg","durationSec":1}'
```
인증이 켜져 있으면 `-H "Authorization: Bearer $AUTH_TOKEN"` 추가.

## 오류 코드
- `400` 잘못된 파라미터
- `401` 인증 실패 (AUTH_TOKEN 설정 시 필요)
- `409` 카메라 사용 중 (락 보유)
- `500` 캡처/ffmpeg/분석 실패
- `504` 명령 타임아웃
