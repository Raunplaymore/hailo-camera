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

### Raspberry Pi 경로

현재 운영 장비(`ray@raunplaymore`) 기준으로 카메라 서버 루트는 `/home/ray/hailo-camera`가 기본 후보입니다. `/home/ray/pi-cam`은 Next.js 프론트 컨트롤러 후보이므로 Hailo postprocess config 경로로 쓰지 않습니다.

실제 PM2 실행 경로는 배포 전 아래 명령으로 확인합니다.

```bash
pm2 list
pm2 describe hailo-camera
pwdx $(pgrep -f "node.*server.js" | head -1)
```

`pwdx` 결과가 다르면 `AI_POSTPROCESS_CONFIG`만 실제 `config/` 폴더가 있는 camera root에 맞춥니다.

### 주요 환경변수

| 변수 | 설명 |
| --- | --- |
| `PORT` | 기본 3001 |
| `AUTH_TOKEN` | `/api/*` Bearer 인증 |
| `CORS_ALLOW_ALL` / `CORS_ORIGIN` | CORS 제어 |
| `UPLOAD_DIR` | 캡처 저장 경로 (default `/home/ray/uploads`) |
| `STREAM_TOKEN` | `/api/camera/stream.mjpeg` 접근 토큰 (`?token=` / `X-Stream-Token`) |
| `ANALYZE_URL` | 코칭 분석 트리거 API (default `http://127.0.0.1:3000/api/analyze/from-file`) |
| `DEFAULT_WIDTH` / `DEFAULT_HEIGHT` | 캡처 기본 해상도 (default 1920×1080) |
| `DEFAULT_FPS` | JPG/영상 기본 FPS (default 30) |
| `DEFAULT_STILL_DURATION_SEC` | JPG 캡처 기본 길이 (default 1초) |
| `DEFAULT_VIDEO_DURATION_SEC` | h264/mp4 기본 길이 (default 3초) |
| `CAMERA_*_CMDS` | rpicam/libcamera 실행 우선순위 |
| `GST_LAUNCH_CMD` | GStreamer 실행 명령 (default `gst-launch-1.0`) |
| `META_DIR` | 메타 json 경로 (default `/tmp`) |
| `SESSION_LABEL_MAP` | classId→label 매핑 override. 보통 config의 `labels`를 자동 사용하므로 비워둡니다. |
| `HAILO_MODEL_NAME` / `HAILO_MODEL` | 기본 Hailo 모델명 (default `yolov8s`) |
| `HAILO_MODEL_ALIASES` | 추가 허용 모델명 CSV. `yolov8s`, `yolov8n_service7`은 항상 허용 |
| `HAILO_HEF_PATH` | Hailo HEF 경로 (default `/usr/share/hailo-models/yolov8s.hef`) |
| `HAILO_INFERENCE_WIDTH` / `HAILO_INFERENCE_HEIGHT` | Hailo 입력 크기 (default 640×640) |
| `HAILO_POSTPROCESS_LIB` | Hailo postprocess 공유 라이브러리 (default `libyolo_hailortpp_post.so`) |
| `HAILO_POSTPROCESS_FUNC` | 기본 세션/파일 추론용 postprocess 함수명 (default `yolov8s`) |
| `HAILO_PREVIEW_POSTPROCESS_FUNC` | AI 프리뷰용 postprocess 함수명 (default `filter`) |
| `AI_POSTPROCESS_CONFIG` | Hailo postprocess config 경로 (default `config/yolov8s_nms_golf.json`) |
| `SERVICE7_FILE_NORMALIZE` | service7 파일 분석에서 회전 감지·YOLO 114-gray letterbox 적용 여부 (default `true`) |
| `SERVICE7_NMS_SCORE_THRESHOLD` / `SERVICE7_NMS_IOU_THRESHOLD` | 구형 HEF에만 적용할 hailonet runtime NMS override. v7처럼 HEF에 이미 설정됐으면 비워 둔다. |
| `SERVICE7_POST_NMS_THRESHOLDS` | 선택적 class별 후처리 confidence JSON. 예: `{"golf_ball":0.03,"club_head":0.03}` |
| `AUTO_ADDRESS_STILL_MS` | 자동 촬영: 어드레스 안정 지속 시간(ms, default `2000`) |
| `AUTO_ADDRESS_MAX_CENTER_PX` | 자동 촬영: 중심 이동 허용(px, default `14`) |
| `AUTO_ADDRESS_MAX_AREA_RATIO` | 자동 촬영: bbox 면적 변화 허용 비율(default `0.12`) |
| `AUTO_PERSON_CONF` | 자동 촬영: person 최소 confidence(default `0.2`) |
| `AUTO_SWING_END_MISSING_FRAMES` | 자동 촬영: person 미검출 연속 프레임(default `12`) |
| `AUTO_POLL_MS` | 자동 촬영: 메타 폴링 간격(ms, default `200`) |
| `LIBAV_VIDEO_CODEC` | rpicam-vid libav 코덱 (default `libx264`) |
| `VITE_API_BASE_LOCAL / PI` | 프런트 앱 참고 용도 |

mp4 캡처는 항상 `filename.mp4.part`로 쓰고 완료 후 `.mp4`로 rename합니다. `.part` 파일은 미완성으로 간주하세요.

`ANALYZE_URL`은 캡처+메타 생성 또는 세션 종료 후 **코칭 분석**을 트리거하는 용도로 사용됩니다.
카메라 서버의 `analyze`는 **Hailo 메타 생성**을 의미하며, 스윙 이벤트/코칭 해석은 `ANALYZE_URL` 대상입니다.
분석 트리거는 **mp4 finalize(.mp4.part → .mp4 rename) 이후**에만 호출됩니다.

service7의 파일 분석(`POST /api/meta/from-file`, capture-and-analyze)은 입력 영상의 display rotation을
`ffprobe`로 읽고, `ffmpeg -noautorotate`로 화면 방향을 바로잡은 뒤 모델 입력 크기에 맞춰 RGB
`(114,114,114)` letterbox를 적용합니다. Hailo 메타 bbox는 다시 회전된 원본 화면 좌표로 역변환됩니다.
이는 정사각형으로 단순 stretch하는 것과 다르며, 학습·ONNX 검증 전처리와 일치합니다.

기본 Service7 운영 모델은 `yolov8n_service7_960_v7.hef`이며, 960×960 입력과 HEF 내부 NMS
`score=0.01`, `IoU=0.70`을 사용합니다. `SERVICE7_POST_NMS_THRESHOLDS`는 메타 단계에서만
적용되는 class별 균형 정책이므로 HEF의 약한 ball/head 후보 자체를 버리지는 않습니다.

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
- 완료 후(메타 생성 + 파일 확정) `ANALYZE_URL`로 `{ jobId:<base>, filename, metaPath, force:false }` 전송 (실패해도 캡처 결과는 유지)
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

`GET /api/camera/stream.ai.mjpeg`

- 쿼리: `width`, `height`, `fps` (기본 640×360 @ 15fps)
- Hailo 추론 결과를 오버레이한 MJPEG 스트림입니다.
- 기본 모델: `HAILO_MODEL_NAME` (Hailo HEF: `HAILO_HEF_PATH`)
- 골프 분석 모델 프리뷰: `?model=yolov8n_service7`
- 필요 플러그인: `hailonet`, `hailofilter`, `hailooverlay`
- 토큰이 설정되면 `?token=` 또는 `X-Stream-Token` 필요

`GET /api/camera/calibration/list`

- `calibration/` 폴더의 보정 파일 목록을 반환합니다.

`GET /api/camera/calibration/:name`

- 렌즈 보정 JSON을 반환합니다. (예: `lens_8mm_intrinsics.json`)

### 2.3 세션(녹화 + Hailo 추론)

`POST /api/session/start`

```json
{
  "width": 1456,
  "height": 1088,
  "fps": 60,
  "model": "yolov8n_service7",
  "durationSec": 0
}
```

- `durationSec=0` 이면 `stop` 호출 전까지 계속 진행합니다.
- `jobId`는 서버에서 생성됩니다.
- 녹화 파일: `/home/ray/uploads/<jobId>.mp4` (기본값, `UPLOAD_DIR` 설정 시 변경)
- 메타 파일: `META_DIR/<jobId>.meta.json` (default `/tmp`, 세션 종료 시 프레임 배열로 정규화됨)
- GStreamer 파이프라인:
  - 공유 소스: `libcamerasrc → NV12 → shmsink`
  - 추론 브랜치: `shmsrc → NV12 → videoconvert → videoscale → RGB(HAILO_INFERENCE_WIDTH×HAILO_INFERENCE_HEIGHT) → hailonet → hailofilter → hailoexportfile → fakesink`
  - 녹화 브랜치: `shmsrc → NV12 → videoconvert → H.264 encoder → h264parse → mp4mux → filesink(.part)`
  - `hailonet`: `HAILO_HEF_PATH` (default `/usr/share/hailo-models/yolov8s.hef`)
  - `hailofilter`: `HAILO_POSTPROCESS_LIB`, function `HAILO_POSTPROCESS_FUNC`

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
- 분석 트리거는 파일 확정 이후에만 호출됩니다.

`POST /api/session/:jobId/timelapse`

```json
{
  "sampleEverySec": 10,
  "outputFps": 10
}
```

- 종료된 원본 MP4에서 일정 간격의 프레임을 추출해 `<jobId>_timelapse.mp4`를 생성합니다.
- 원본 녹화는 유지되므로, 세부 작업은 원본으로 확인하고 전체 과정은 타임랩스로 빠르게 볼 수 있습니다.
- 기본값은 10초당 1프레임, 결과 영상 10 FPS입니다. `TIMELAPSE_TIMEOUT_MS`로 긴 영상의 변환 제한 시간을 조정할 수 있습니다.

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

통합 메모: 세션 종료 시 서버가 `ANALYZE_URL`에 `{ jobId, filename: "<jobId>.mp4", metaPath, force:false }` 를 전송합니다. (필요 시 백엔드에서 동일 포맷으로 재시도 가능)

`DELETE /api/session/:jobId`

- 세션 비디오/메타/상태를 함께 삭제합니다.

### 2.4 Auto Record (Ready 기반)

`src/auto/*` 의 `AutoRecordManager`는 **Ready 상태에서 사람 안정(어드레스) 감지 후 자동 녹화**를 수행합니다. 서버 시작 시 `ts-node`로 로드되어 있을 때만 활성화되며, 락/스트림 상태를 공유하므로 다른 캡처와 동시에 실행되지 않습니다.

- 어드레스 완료: person bbox가 설정 시간 동안 안정적일 때
- 종료: person 미검출 연속 프레임 또는 UI Stop

- `GET /api/camera/auto-record/status` : `{ ok, status }` 로 현재 state, `startedAt`, `recordingFilename`, `lastRecordingFilename`, `lastRecordingMetaPath`, `lastError` 를 확인합니다.
- `POST /api/camera/auto-record/start` : 스트림/캡처가 진행 중이면 `409` 를 반환합니다. 성공 시 상태머신이 순차적으로 mp4 녹화를 수행합니다.
- `POST /api/camera/auto-record/stop` : 진행 중인 녹화를 중단하고 세션을 종료합니다.

오토 녹화 실패 시 `status.lastError`에 에러 메시지가 들어가며 state가 `failed` 로 고정됩니다. 이때 `start` 를 다시 호출하면 세션이 초기화됩니다.

### 2.5 AI postprocess config

- `GET /api/camera/ai-config` : 현재 적용 중인 config와 옵션 목록
- `POST /api/camera/ai-config` : `{ name: "yolov8s_nms_golf.json" }` 형태로 전환
- `config/` 아래 json 파일이 옵션 목록에 포함됩니다.
- 기본 골프 라벨 구성: `config/yolov8s_nms_golf.json`
- service7 골프 모델 라벨 구성: `config/yolov8n_service7_nms.json`
- 3클래스 골프 모델 라벨 구성: `config/yolov8n_golf3_nms.json`

### 2.6 커스텀 service7 HEF 배포

`golf_swingfeed_yolov8n_service7_960` 모델을 HEF로 변환한 뒤에는 HEF만 설치합니다. 기본 pi_cam은 `yolov8s`를 계속 쓰고, 골프 분석 요청에서만 `model: "yolov8n_service7"`을 보냅니다.

```bash
sudo cp yolov8n_service7_960.hef /usr/share/hailo-models/
```

서버는 `model: "yolov8n_service7"` 요청을 받으면 자동으로 `/usr/share/hailo-models/yolov8n_service7_960.hef`, 960×960 입력, `filter`, `config/yolov8n_service7_nms.json`을 사용합니다. HEF는 7개 클래스를 내보내지만 TAPPAS `filter`는 NMS class ID를 1부터 라벨 배열에 매핑하므로, config의 첫 항목은 `__background__` 더미이고 이후에 7개 실제 라벨을 둡니다. `filter` 함수는 config의 `output_layer` 값을 사용하므로, DFC compile 시 `net_name`을 바꾸면 config의 `output_layer`도 같은 이름으로 맞춰야 합니다.

3클래스 MVP 모델을 fallback으로 쓸 때만 `yolov8n_golf3_960.hef`, `config/yolov8n_golf3_nms.json`, `SESSION_LABEL_MAP=0:person,1:golf_ball,2:club_head` 조합으로 바꿉니다.

### 2.7 watchcat 사진 추론

watchcat은 XIAO ESP32S3 Sense가 촬영한 JPEG를 별도 watchcat 게이트웨이에 업로드하고,
게이트웨이가 이 서버의 파일 추론 API를 호출하는 방식이다. 기존 골프 캡처, 세션, 프리뷰와
전역 `AI_POSTPROCESS_CONFIG`를 바꾸지 않는다.

- `model: "watchcat-cat"`은 `/usr/share/hailo-models/yolov8s.hef`와
  `config/yolov8s_nms.json`을 사용하고 `cat` 라벨만 반환한다.
- watchcat 사진은 `UPLOAD_DIR` 아래의 별도 `watchcat/` 경로에 저장한다.
- 게이트웨이는 `POST /api/meta/from-file`에 `model: "watchcat-cat"`을 명시한다.
- 메타는 `GET /api/session/:jobId/meta?model=watchcat-cat`으로 조회한다. 이 쿼리가
  없으면 기존 기본 모델의 라벨 필터가 적용될 수 있다.
- Hailo 가속기 동시 점유를 피하기 위해 이 서버의 기존 파일 추론 큐를 사용한다.

이 서버는 원격 JPEG 업로드 API를 제공하지 않는다. XIAO의 업로드 수신·최근 이미지·웹 화면은
별도 `watchcat` 게이트웨이 서비스가 담당한다.

### 2.7 기타

- `GET /uploads/:name` : 저장 파일 정적 서빙
- `GET /api/uploads?ext=jpg&limit=200&offset=0&sort=desc` : 업로드된 파일 목록(앨범용)
- 응답 형식: `{ ok, total, items:[{ name, size, mtimeMs, url }] }`
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
  -d '{"width":1456,"height":1088,"fps":60,"model":"yolov8n_service7","durationSec":0}'

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

---

## 6. 렌즈별 캘리브레이션 기록

ChArUco 보드로 캘리브레이션한 카메라 내부 파라미터(JSON)는 `calibration/`에 렌즈별로 보관합니다.

- 경로 규칙: `calibration/lens_<focal>_intrinsics.json`
- 예시: `calibration/lens_8mm_intrinsics.json`
- 필드: `cameraMatrix`, `distCoeffs`, `fx`, `fy`, `h_fov_deg`, `v_fov_deg` 등
