# Hailo Camera Capture Server

rpicam 기반 Raspberry Pi 단일 카메라에서 MJPEG 프리뷰·사진·영상 촬영·분석 연동을 담당합니다. 모든 파일은 기본적으로 `/home/ray/uploads`에 저장되며 `/uploads` 라우트로 정적 서빙됩니다.

> **원칙**: 스트리밍/캡처 안정성, 단일 카메라 자원 보호(락), 분석 연동 시 파일 핸들링을 일관되게 유지합니다.

---

## 1. 환경 & 설치

- Raspberry Pi OS + `rpicam-still`, `rpicam-vid`, `rpicam-hello`
- ffmpeg, Node.js 18+

```bash
npm install
npm start            # PORT=3001 default
```

### 주요 환경변수

| 변수 | 설명 |
| --- | --- |
| `PORT` | 기본 3001 |
| `AUTH_TOKEN` | `/api/*` Bearer 인증 |
| `CORS_ALLOW_ALL` / `CORS_ORIGIN` | CORS 제어 |
| `UPLOAD_DIR` | 캡처 저장 경로 (default `/home/ray/uploads`) |
| `STREAM_TOKEN` | `/api/camera/stream.mjpeg` 접근 토큰 (`?token=` / `X-Stream-Token`) |
| `ANALYZE_URL` | 분석 API (default `http://127.0.0.1:3000/api/analyze/from-file`) |
| `DEFAULT_*` | 캡처 기본 해상도/FPS/길이 |
| `CAMERA_*_CMDS` | rpicam/libcamera 실행 우선순위 |
| `LIBAV_VIDEO_CODEC` | rpicam-vid libav 코덱 (default `libx264`) |
| `VITE_API_BASE_LOCAL / PI` | 프런트 앱 참고 용도 |

mp4 캡처는 항상 `filename.mp4.part`로 쓰고 완료 후 `.mp4`로 rename합니다. `.part` 파일은 미완성으로 간주하세요.

---

## 2. API 개요

### 2.1 캡처

`POST /api/camera/capture`

```json
{
  "format": "jpg|h264|mp4",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "durationSec": 3,
  "filename": "optional"
}
```

- 기본 파일명 패턴: `ray_golf_YYYYMMDD_HHMMSS_mmm_swing.<ext>`
- mp4: rpicam-vid libav 모드 사용, 폴백 시 h264 → ffmpeg remux

`POST /api/camera/capture-and-analyze`

- 캡처 후 `ANALYZE_URL`로 `{ filename, force? }` 전송
- 성공 시 `{ ok:true, jobId, filename, status:"queued" }`

### 2.2 상태 및 스트림

`GET /api/camera/status`

```json
{
  "ok": true,
  "cameraDetected": true,
  "busy": false,
  "streaming": false,
  "streamClients": 0,
  "lastCaptureAt": "...",
  "lastStreamAt": "...",
  "lastError": null
}
```

`GET /api/camera/stream.mjpeg`

- 쿼리: `width`, `height`, `fps` (기본 640×360 @ 15fps)
- 한 번에 1명만 허용, 토큰이 설정되면 `?token=` 필수
- `POST /api/camera/stream/stop` 로 강제 종료 가능

### 2.3 기타

- `GET /uploads/:name` : 저장 파일 정적 서빙
- 스모크 테스트: `npm test` 또는 `PORT=3001 node scripts/smoke_test.js`

---

## 3. 운용 특징

- 인메모리 플래그 + `/tmp/camera.lock` 이중 락으로 동시 캡처 차단
- 명령 타임아웃 = `durationSec*1000 + 3s`
- 모든 요청·명령 stdout/stderr·에러를 콘솔 로그
- 스트림 상태(`streamingActive`, `streamClients`, `lastStreamAt`)를 즉시 갱신

---

## 4. Curl 예시

```bash
# 상태
curl -s http://localhost:3001/api/camera/status

# JPG 1초 캡처
curl -X POST http://localhost:3001/api/camera/capture \
  -H "Content-Type: application/json" \
  -d '{"format":"jpg","durationSec":1,"width":1280,"height":720}'

# MP4 5초 캡처
curl -X POST http://localhost:3001/api/camera/capture \
  -H "Content-Type: application/json" \
  -d '{"format":"mp4","durationSec":5,"fps":30}'

# 캡처 + 분석(force)
curl -X POST http://localhost:3001/api/camera/capture-and-analyze \
  -H "Content-Type: application/json" \
  -d '{"format":"mp4","durationSec":5,"force":true}'

# 스트림 (토큰 필요 시)
curl -o stream.mjpeg "http://localhost:3001/api/camera/stream.mjpeg?token=$STREAM_TOKEN"

# 스트림 강제 종료
curl -X POST http://localhost:3001/api/camera/stream/stop
```

Bearer 인증이 설정되어 있으면 `-H "Authorization: Bearer $AUTH_TOKEN"` 을 추가하세요.

---

## 5. 오류 코드

- `400` 잘못된 파라미터
- `401` 인증 실패
- `409` 카메라 사용 중(캡처 락/스트림)
- `500` 캡처/ffmpeg/분석 실패
- `504` 캡처/분석 타임아웃
