export type AutoRecordState =
  | 'idle'
  | 'arming'
  | 'addressLocked'
  | 'recording'
  | 'finishLocked'
  | 'stopping'
  | 'failed';

export interface AutoRecordStatus {
  enabled: boolean;
  state: AutoRecordState;
  startedAt: string | null;
  recordingFilename: string | null;
  lastRecordingFilename?: string | null;
  lastError: string | null;
}

export interface AutoRecordConfig {
  addressStillMs: number;
  addressMaxCenterDeltaPx: number;
  addressMaxAreaDeltaRatio: number;
  minPersonConfidence: number;
  swingEndMissingFrames: number;
  pollIntervalMs: number;
}

export interface AutoRecordManagerOptions {
  recorder: RecorderAdapter;
  detector: DetectorAdapter;
  config?: Partial<AutoRecordConfig>;
  pauseDetectorDuringRecording?: boolean;
  logger?: (...args: unknown[]) => void;
}

export interface RecorderAdapter {
  startRecording(): Promise<{ filename: string }>;
  stopRecording(): Promise<{ filename: string }>;
  isRecording(): boolean;
}

export type DetectionBox = {
  label?: string | null;
  classId?: number | null;
  conf?: number | null;
  bbox: [number, number, number, number];
};

export type AutoRecordFrame = {
  t?: number | null;
  detections: DetectionBox[];
};

export interface DetectorAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  getLatestFrame(): Promise<AutoRecordFrame | null>;
}

export interface RecorderControllerOptions {
  uploadDir: string;
  width: number;
  height: number;
  fps: number;
  videoCommands: string[];
  acquireLock: (expectedMs: number) => Promise<boolean>;
  releaseLock: () => Promise<void>;
  ensureUploadsDir: () => Promise<void>;
  buildFilename: () => string;
  libavCodec?: string;
  lockTimeoutMs?: number;
  logger?: (...args: unknown[]) => void;
}
