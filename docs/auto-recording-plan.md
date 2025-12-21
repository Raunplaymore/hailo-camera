# Auto Recording Architecture Plan

## Modules

### AutoRecorder (src/auto/AutoRecorder.ts)
State machine that consumes motion events and emits transitions.

States:
- idle
- arming
- addressLocked
- recording
- finishLocked
- stopping
- failed

Events:
- START (user HTTP call)
- MOTION (motionScore, stability information)
- STOP (user stop or internal finish)
- ERROR

Transitions:
1. idle -> arming on START (valid only if camera available and not busy)
2. arming -> addressLocked when motion stable below threshold for `addressStableMs`
3. addressLocked -> recording when motion rises (`motionUpThreshold`) for N consecutive ticks
4. recording -> finishLocked once minRecordMs elapsed and motion drops below `motionDownThreshold`
5. finishLocked -> stopping when finish stable for `finishStableMs`
6. stopping -> idle after recorder stop success; trigger analyze call
7. Any state -> failed on recorder error; provide errorReason
8. STOP command from user interrupts: addressLocked/arming -> idle, recording -> stopping (force stop)

Config (default values):
- tickIntervalMs: 100
- addressStableMs: 1200
- finishStableMs: 1500
- minRecordMs: 3000
- motionUpThreshold: 0.35
- motionDownThreshold: 0.15
- motionSamplesForRise: 4
- motionSamplesForStability: 12

Outputs:
- status snapshot: { state, motionScore, lastEvent, recordingFilename, startedAt, debug }
- events: onStartRecord(filename), onStopRecord(filename), onError(error)

### MotionEstimator (src/auto/motion/MotionEstimator.ts)
Abstraction for calculating motionScore from preview frames.

Responsibilities:
- Receive resized preview frames (e.g., 320x180)
- Compute frame difference and produce `motionScore` (0~1)
- Provide stability metrics: moving average, variance
- Interface to allow easy swap with future Hailo detector

Implementation idea:
- Use Node.js with `child_process` to tap MJPEG stream (or future pipe)
- For now, expect frames delivered externally via `feedFrame(buffer, timestamp)`
- Returns { motionScore, stable: boolean, debug } to AutoRecorder

### RecorderController (src/auto/RecorderController.ts)
Wrapper around existing capture pipeline.

API:
- `startRecording(options): Promise<{ filename, tempPath }>`
- `stopRecording(): Promise<{ filename }>`
- `isRecording()` to coordinate with manual captures

Responsibilities:
- Interact with lock file logic already in server.js
- Manage `.mp4.part` and rename
- Communicate with AutoRecorder via events

### AutoRecordService (src/auto/service.ts)
High-level orchestrator used by Express routes.

- Holds AutoRecorder instance, MotionEstimator, RecorderController
- Routes feed preview frames or subscribe to existing preview pipeline
- Provides HTTP status data
- Handles analyze trigger after recording completes (POST to ANALYZE_URL/back-end)

## APIs

### POST /api/camera/auto-record/start
Body options:
```json
{
  "preset": "default",
  "minRecordMs": 3000,
  "addressStableMs": 1200,
  "finishStableMs": 1500,
  "motionUpThreshold": 0.35,
  "motionDownThreshold": 0.15,
  "backBaseUrl": "http://127.0.0.1:3000"
}
```
Response:
`{ ok: true, state, startedAt }`

Errors:
- 409 if already running or camera busy
- 503 if stream not available
- 500 on internal failure

### POST /api/camera/auto-record/stop
Force stop or cancel.
Response `{ ok: true, stopped: true }`

### GET /api/camera/auto-record/status
Returns:
```json
{
  "ok": true,
  "enabled": true/false,
  "state": "idle|arming|...|failed",
  "motionScore": 0.12,
  "lastEvent": "ADDRESS_LOCKED",
  "recordingFilename": "ray_golf_*.mp4",
  "startedAt": "...",
  "errorMessage": null,
  "debug": {
    "motionAverage": 0.08,
    "recentScores": [],
    "ticksInState": 42
  }
}
```

## Flow

1. Client hits `/auto-record/start`
2. Service ensures preview is connected, AutoRecorder enters arming
3. MotionEstimator feeds ticks to AutoRecorder (interval scheduler)
4. AutoRecorder transitions through states; when recording, RecorderController.start invoked
5. After finish detection AutoRecorder stops recording, triggers analyze call. Response stored.
6. Status endpoint polls from AutoRecordService to inform UI.

## TODO / Next Steps

- Implement TypeScript configuration (tsconfig, build step or ts-node register)
- Decide on MJPEG frame tapping strategy (maybe hooking into existing stream pipeline)
- Add minimal unit tests for AutoRecorder transitions (jest or vitest)
