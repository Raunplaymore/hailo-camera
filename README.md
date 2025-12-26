# Hailo Camera Capture Server

rpicam 기반 Raspberry Pi 단일 카메라에서 MJPEG 프리뷰·사진·영상 촬영·분석 연동을 담당합니다. 모든 파일은 기본적으로 `/home/ray/uploads`에 저장되며 `/uploads` 라우트로 정적 서빙됩니다.

> **원칙**: 스트리밍/캡처 안정성, 단일 카메라 자원 보호(락), 분석 연동 시 파일 핸들링을 일관되게 유지합니다.

---

## 1. 환경 & 설치

- Raspberry Pi OS + `rpicam-still`, `rpicam-vid`, `rpicam-hello`
- GStreamer 1.0 (`gst-launch-1.0`)
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
| `DEFAULT_WIDTH` / `DEFAULT_HEIGHT` | 캡처 기본 해상도 (default 1920×1080) |
| `DEFAULT_FPS` | JPG/영상 기본 FPS (default 30) |
| `DEFAULT_STILL_DURATION_SEC` | JPG 캡처 기본 길이 (default 1초) |
| `DEFAULT_VIDEO_DURATION_SEC` | h264/mp4 기본 길이 (default 3초) |
| `CAMERA_*_CMDS` | rpicam/libcamera 실행 우선순위 |
| `GST_LAUNCH_CMD` | GStreamer 실행 명령 (default `gst-launch-1.0`) |
| `META_DIR` | 메타 json 경로 (default `/tmp`) |
| `SESSION_LABEL_MAP` | classId→label 매핑 (`0:golf_ball,1:clubhead` 또는 JSON) |
| `HAILO_HEF_PATH` | Hailo HEF 경로 (default `/usr/share/hailo-models/yolov8s_h8.hef`) |
| `LIBAV_VIDEO_CODEC` | rpicam-vid libav 코덱 (default `libx264`) |
| `VITE_API_BASE_LOCAL / PI` | 프런트 앱 참고 용도 |

mp4 캡처는 항상 `filename.mp4.part`로 쓰고 완료 후 `.mp4`로 rename합니다. `.part` 파일은 미완성으로 간주하세요.

`ANALYZE_URL`은 캡처+메타 생성 또는 세션 종료 후 백엔드 후속 분석을 트리거하는 용도로 사용됩니다.

> Auto record 데모 기능은 부팅 시 `ts-node/register` 로 TypeScript 파일을 직접 로드합니다. `ts-node` 사용이 어려우면 `npm run build:auto`로 미리 컴파일하거나 해당 기능을 비활성화하세요.

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

- 캡처 후 Hailo inference를 수행해 `META_DIR/<base>.meta.json` 생성 (`<base>`는 파일명 확장자 제거)
- 완료 후 `ANALYZE_URL`로 `{ jobId:<base>, filename, metaPath, force? }` 전송 (실패해도 캡처 결과는 유지)
- 응답: `{ ok:true, filename, url, metaPath }`
- `analyze`는 메타 생성 의미이며 스윙 이벤트/코칭 해석은 포함하지 않습니다.
- 메타 포맷은 `/api/session/:jobId/meta` 와 동일합니다.

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
- 프리뷰는 세션과 동시에 동작하며, 토큰이 설정되면 `?token=` 필수
- `POST /api/camera/stream/stop` 로 강제 종료 가능
- 프리뷰는 공유 파이프라인을 사용해 세션과 동시에 동작합니다.

### 2.3 세션(녹화 + Hailo 추론)

`POST /api/session/start`

```json
{
  "width": 1456,
  "height": 1088,
  "fps": 60,
  "model": "yolov8s",
  "durationSec": 0
}
```

- `durationSec=0` 이면 `stop` 호출 전까지 계속 진행합니다.
- `jobId`는 서버에서 생성됩니다.
- 녹화 파일: `/home/ray/uploads/<jobId>.mp4` (기본값, `UPLOAD_DIR` 설정 시 변경)
- 메타 파일: `META_DIR/<jobId>.meta.json` (default `/tmp`, 세션 종료 시 프레임 배열로 정규화됨)
- GStreamer 파이프라인:
  - 공유 소스: `libcamerasrc → NV12 → shmsink`
  - 추론 브랜치: `shmsrc → NV12 → videoconvert → videoscale → RGB(640×640) → hailonet → hailofilter → hailoexportfile → fakesink`
  - 녹화 브랜치: `shmsrc → NV12 → videoconvert → H.264 encoder → h264parse → mp4mux → filesink(.part)`
  - `hailonet`: `HAILO_HEF_PATH` (default `/usr/share/hailo-models/yolov8s_h8.hef`)
  - `hailofilter`: `libyolo_hailortpp_post.so`, function `yolov8s`

응답:

```json
{
  "ok": true,
  "jobId": "session_YYYYMMDD_HHMMSS_mmm_xxxxxx",
  "videoFile": "<jobId>.mp4",
  "videoUrl": "/uploads/<jobId>.mp4",
  "metaPath": "/tmp/<jobId>.meta.json"
}
```

`POST /api/session/:jobId/stop`

- gst-launch는 `-e` 옵션으로 EOS를 보장합니다.
- mp4는 `.part`로 기록 후 종료 시 `.mp4`로 rename 됩니다.

`GET /api/session/list?limit=50&offset=0`

- 최근 세션 목록을 반환합니다.

`GET /api/session/:jobId/status`

`GET /api/session/:jobId/live?tailFrames=30`

- 메타 파일의 끝부분을 읽어 마지막 N프레임 탐지 결과를 반환합니다.
- 응답 형식:

```json
{
  "jobId": "...",
  "frames": [
    { "t": 1766..., "frame": 451, "detections":[{"label":"...", "classId":66, "conf":0.87, "bbox":[xmin,ymin,w,h]}] }
  ]
}
```

`GET /api/session/:jobId/meta`

- 정규화된 메타를 `{ frames: [...] }` 형태로 반환합니다.
- 메타 프레임 형식:

```json
{
  "t": 1700000000000,
  "frame": 123,
  "detections": [
    { "label": "golf_ball", "classId": 0, "conf": 0.9, "bbox": [x, y, w, h] }
  ]
}
```

통합 메모: 세션 종료 시 서버가 `ANALYZE_URL`에 `{ jobId, filename: "<jobId>.mp4", metaPath }` 를 전송합니다. (필요 시 백엔드에서 동일 포맷으로 재시도 가능)

### 2.4 Auto Record 데모

`src/auto/*` 에 구현된 `AutoRecordManager`는 데모용 자동 녹화 상태머신(arming → addressLocked → recording → finishLocked → idle)입니다. 서버 시작 시 `ts-node`로 로드되어 있을 때만 활성화되며, 락/스트림 상태를 공유하므로 다른 캡처와 동시에 실행되지 않습니다.

- `GET /api/camera/auto-record/status` : `{ ok, status }` 로 현재 state, `startedAt`, `recordingFilename`, `lastError` 를 확인합니다.
- `POST /api/camera/auto-record/start` : 스트림/캡처가 진행 중이면 `409` 를 반환합니다. 성공 시 상태머신이 순차적으로 mp4 녹화를 수행합니다.
- `POST /api/camera/auto-record/stop` : 진행 중인 녹화를 중단하고 세션을 종료합니다.

오토 녹화 실패 시 `status.lastError`에 에러 메시지가 들어가며 state가 `failed` 로 고정됩니다. 이때 `start` 를 다시 호출하면 세션이 초기화됩니다.

### 2.5 기타

- `GET /uploads/:name` : 저장 파일 정적 서빙
- `DELETE /api/uploads/:name` : 저장 파일 삭제 (AUTH_TOKEN 설정 시 Bearer 필요)
- 스모크 테스트: `npm test` 또는 `PORT=3001 node scripts/smoke_test.js`
- 프리뷰+세션 동시 스모크: `BASE_URL=http://localhost:3001 scripts/smoke.sh`

---

## 3. 운용 특징

- 인메모리 플래그 + `/tmp/camera.lock` 이중 락으로 동시 캡처 차단
- 명령 타임아웃 = `durationSec*1000 + 3s`
- 모든 요청·명령 stdout/stderr·에러를 콘솔 로그
- 스트림 상태(`streamingActive`, `streamClients`, `lastStreamAt`)를 즉시 갱신
- 프리뷰/세션은 공유 파이프라인을 사용해 동시에 동작하며, 외부 프로세스 점유 시에만 409/503을 반환

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

# 세션 시작 (녹화 + Hailo 추론)
curl -X POST http://localhost:3001/api/session/start \
  -H "Content-Type: application/json" \
  -d '{"width":1456,"height":1088,"fps":60,"model":"yolov8s","durationSec":0}'

# 세션 상태
curl -s http://localhost:3001/api/session/<jobId>/status

# 세션 라이브(최근 탐지)
curl -s "http://localhost:3001/api/session/<jobId>/live?tailFrames=30"

# 세션 목록
curl -s "http://localhost:3001/api/session/list?limit=20"

# 세션 메타(정규화)
curl -s http://localhost:3001/api/session/<jobId>/meta

# 세션 종료
curl -X POST http://localhost:3001/api/session/<jobId>/stop

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
