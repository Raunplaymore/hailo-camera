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
  lastError: string | null;
}

export interface AutoRecordConfig {
  demoArmingMs: number;
  demoAddressToRecordMs: number;
  demoRecordingMs: number;
  demoFinishMs: number;
}

export interface AutoRecordManagerOptions {
  recorder: RecorderAdapter;
  logger?: (...args: unknown[]) => void;
}

export interface RecorderAdapter {
  startRecording(): Promise<{ filename: string }>;
  stopRecording(): Promise<{ filename: string }>;
  isRecording(): boolean;
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
