# pi_camera Context

## 프로젝트 개요
Raspberry Pi 카메라 캡처 서버. rpicam + GStreamer + Hailo NPU 기반 실시간 추론 및 녹화.

## 자주 수정하는 파일

### 핵심 로직
- `server.js` - Express 서버, API 엔드포인트, 락 관리
- `src/session/gstPipeline.js` - GStreamer 파이프라인 빌더
- `src/session/SharedPipeline.js` - 공유 파이프라인 관리
- `src/session/ProcessManager.js` - 프로세스 생명주기 관리

### Auto-Record
- `src/auto/AutoRecordManager.ts` - 자동 녹화 상태 머신
- `src/auto/RecorderController.ts` - 녹화 제어기

### 유틸리티
- `src/session/tailParser.js` - 메타 파일 tail 읽기
- `src/session/metaNormalizer.js` - 메타 정규화

## GStreamer 파이프라인 구조

### 공유 소스 (SharedPipeline)
```
libcamerasrc → videoconvert → NV12 → shmsink (3개 소켓)
  ↓
  ├─ preview.shm  → 프리뷰 브랜치
  ├─ record.shm   → 녹화 브랜치
  └─ infer.shm    → 추론 브랜치
```

### 세션 녹화 파이프라인
```
추론: shmsrc(infer.shm) → RGB → hailonet → hailofilter → hailoexportfile → fakesink
녹화: shmsrc(record.shm) → H.264 encode → h264parse → mp4mux → filesink(.part)
```

### 프리뷰 파이프라인
```
shmsrc(preview.shm) → jpegenc → multipartmux → HTTP (MJPEG)
```

## 주의사항

### 락 메커니즘
- 인메모리 플래그 (`busy`, `streamingActive`)
- 파일 락 (`/tmp/camera.lock`, `/tmp/session.lock`)
- 타임아웃 폴백: `LOCK_FALLBACK_TTL_MS=10분`
- 항상 이중 체크 후 프로세스 시작

### 파일 관리
- mp4는 항상 `.part`로 시작 → 완료 시 rename
- `.part` 파일은 미완성으로 간주
- 메타 파일: `META_DIR/<jobId>.meta.json` (기본 `/tmp`)
- 분석 트리거: mp4 finalize 이후에만 호출

### GStreamer 종료
- `-e` 옵션으로 EOS(End of Stream) 보장
- `SIGINT` 전송 후 대기
- 타임아웃: `durationSec * 1000 + 3s`

## 환경변수

### 필수
- `PORT=3001` - 서버 포트
- `UPLOAD_DIR=/home/ray/uploads` - 파일 저장 경로
- `META_DIR=/tmp` - 메타 파일 경로

### Hailo 설정
- `HAILO_HEF_PATH=/usr/share/hailo-models/yolov8s.hef`
- `AI_POSTPROCESS_CONFIG=config/yolov8s_nms_golf.json`
- `SESSION_LABEL_MAP=0:golf_ball,1:clubhead` 또는 JSON 경로

### Auto-Record 설정
- `AUTO_ADDRESS_STILL_MS=2000` - 어드레스 안정 시간
- `AUTO_ADDRESS_MAX_CENTER_PX=14` - 중심 이동 허용
- `AUTO_ADDRESS_MAX_AREA_RATIO=0.12` - 면적 변화 허용
- `AUTO_SWING_END_MISSING_FRAMES=12` - 종료 감지 프레임

### 인증
- `AUTH_TOKEN` - Bearer 인증 토큰
- `STREAM_TOKEN` - 스트림 접근 토큰

## Auto-Record 상태 머신

```
idle → arming → addressLocked → recording → finishLocked → stopping → idle
                                                                ↓
                                                             failed
```

### 주요 로직
1. **arming**: person bbox 대기
2. **addressLocked**: bbox 안정 감지 (2초 이상 중심/면적 변화 < 임계값)
3. **recording**: 녹화 시작
4. **finishLocked**: person 미검출 연속 12프레임
5. **stopping**: 녹화 종료 + 분석 트리거

## API 주요 엔드포인트

### 상태 확인
- `GET /api/camera/status` - 카메라/스트림/busy 상태

### 스트림
- `GET /api/camera/stream.mjpeg?width=640&height=360&fps=15`
- `GET /api/camera/stream.ai.mjpeg` - AI 오버레이 포함

### 세션
- `POST /api/session/start` - 녹화 시작
- `POST /api/session/:jobId/stop` - 녹화 종료
- `GET /api/session/:jobId/live?tailFrames=30` - 실시간 bbox
- `GET /api/session/:jobId/meta` - 정규화된 메타

### Auto-Record
- `POST /api/camera/auto-record/start`
- `POST /api/camera/auto-record/stop`
- `GET /api/camera/auto-record/status`

## 디버깅 팁

### GStreamer 파이프라인 실패 시
1. 로그에서 `stderr:` 확인
2. `gst-launch-1.0` 수동 실행으로 재현
3. Hailo 플러그인 로드 확인: `gst-inspect-1.0 hailonet`

### 메타 파일 안 생성될 때
1. `hailoexportfile location=<path>` 경로 확인
2. 파일 권한 확인
3. Hailo postprocess config 경로/포맷 확인

### 스트림 끊길 때
1. 공유 파이프라인 상태 확인 (`sharedPipeline.isRunning()`)
2. 클라이언트 카운트 확인 (`streamClients`)
3. shm 소켓 파일 존재 확인: `/tmp/*.shm`

### Auto-Record 실패
1. `status.lastError` 확인
2. 어드레스 감지 로그 (`console.log` in AutoRecordManager)
3. person bbox confidence 확인 (최소 0.2)

## 알려진 제약사항

### Hailo NPU
- 추론 해상도: 고정 640×640 (YOLOv8 모델 요구사항)
- 지원 모델: YOLOv8s (HEF 파일 필요)
- Postprocess config: label mapping 필수

### 동시성
- 프리뷰/세션 동시 가능 (공유 파이프라인)
- 캡처/세션 동시 불가 (락 충돌)
- Auto-record 중에는 모든 수동 캡처 차단

### 메타 형식
```json
{
  "t": 1766000000000,
  "frame": 451,
  "detections": [
    { "label": "golf_ball", "classId": 0, "conf": 0.9, "bbox": [x, y, w, h] }
  ]
}
```

## 코딩 컨벤션

### 에러 처리
- 모든 spawn/exec에 timeout 설정
- stderr/stdout 로그 (최대 4000자)
- 에러 시 락 해제 보장 (try-finally)

### 프로세스 관리
- `ProcessManager`로 통합 관리
- 종료 시 SIGINT → 대기 → SIGKILL fallback
- 좀비 프로세스 방지: `proc.on('close')` 핸들러 필수

### TypeScript 파일
- `ts-node/register`로 런타임 로드
- 미사용 시 빌드: `npm run build:auto`
- CommonJS 모드 (`module: 'commonjs'`)
