import {
  AutoRecordConfig,
  AutoRecordManagerOptions,
  AutoRecordState,
  AutoRecordStatus,
  AutoRecordFrame,
  DetectionBox,
  RecorderAdapter,
} from './types';

const DEFAULT_CONFIG: AutoRecordConfig = {
  addressStillMs: 2000,
  addressMaxCenterDeltaPx: 14,
  addressMaxAreaDeltaRatio: 0.12,
  minPersonConfidence: 0.2,
  swingEndMissingFrames: 12,
  pollIntervalMs: 200,
};

const createError = (message: string, status = 500) => {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
};

export class AutoRecordManager {
  private state: AutoRecordState = 'idle';
  private timers: NodeJS.Timeout[] = [];
  private startedAt: string | null = null;
  private recordingFilename: string | null = null;
  private lastRecordingFilename: string | null = null;
  private lastError: string | null = null;
  private config: AutoRecordConfig = { ...DEFAULT_CONFIG };
  private logger?: (...args: unknown[]) => void;
  private recorder: RecorderAdapter;
  private detector: AutoRecordManagerOptions['detector'];
  private pollHandle: NodeJS.Timeout | null = null;
  private lastFrameTs: number | null = null;
  private stableStartTs: number | null = null;
  private stableRefBox: DetectionBox | null = null;
  private missingPersonFrames = 0;
  private pauseDetectorDuringRecording = false;
  private detectorPaused = false;

  constructor(options: AutoRecordManagerOptions) {
    this.recorder = options.recorder;
    this.detector = options.detector;
    this.logger = options.logger;
    if (options.config) {
      this.config = { ...this.config, ...options.config };
    }
    this.pauseDetectorDuringRecording = Boolean(options.pauseDetectorDuringRecording);
  }

  isActive() {
    return this.state !== 'idle' && this.state !== 'failed';
  }

  async start(): Promise<AutoRecordStatus> {
    if (this.state !== 'idle' && this.state !== 'failed') {
      throw createError('Auto record already running', 409);
    }
    this.clearTimers();
    this.detectorPaused = false;
    await this.detector.start();
    this.lastError = null;
    this.startedAt = new Date().toISOString();
    this.recordingFilename = null;
    this.lastRecordingFilename = null;
    this.resetDetectionState();
    this.transitionTo('arming');
    this.startPolling();
    return this.getStatus();
  }

  async stop(reason = 'user'): Promise<AutoRecordStatus> {
    this.log('AutoRecord stop requested', reason);
    this.clearTimers();
    if (this.state === 'recording' || this.state === 'finishLocked' || this.state === 'stopping') {
      await this.safeStopRecorder().catch((err) => this.fail(err as Error));
    }
    await this.detector.stop().catch((err) => this.log('Detector stop failed', err.message));
    this.detectorPaused = false;
    this.resetSession();
    return this.getStatus();
  }

  getStatus(): AutoRecordStatus {
    return {
      enabled: this.isActive(),
      state: this.state,
      startedAt: this.startedAt,
      recordingFilename: this.recordingFilename || null,
      lastRecordingFilename: this.lastRecordingFilename || null,
      lastError: this.lastError || null,
    };
  }

  private enterAddressLocked() {
    if (this.state !== 'arming') return;
    this.transitionTo('addressLocked');
    this.transitionToRecording().catch((err) => this.fail(err));
  }

  private async transitionToRecording() {
    if (this.state !== 'addressLocked') return;
    try {
      if (this.pauseDetectorDuringRecording && !this.detectorPaused) {
        await this.detector.stop().catch((err) => this.log('Detector stop failed', err.message));
        this.detectorPaused = true;
      }
      const { filename } = await this.recorder.startRecording();
      this.recordingFilename = filename;
      this.lastRecordingFilename = filename;
      this.transitionTo('recording');
      this.missingPersonFrames = 0;
    } catch (err) {
      this.fail(err as Error);
    }
  }

  private enterFinishLocked() {
    if (this.state !== 'recording') return;
    this.transitionTo('finishLocked');
    this.handleStopSequence().catch((err) => this.fail(err));
  }

  private async handleStopSequence() {
    if (this.state !== 'finishLocked' && this.state !== 'recording') return;
    this.transitionTo('stopping');
    await this.safeStopRecorder().catch((err) => this.fail(err as Error));
    await this.detector.stop().catch((err) => this.log('Detector stop failed', err.message));
    this.resetSession();
  }

  private async safeStopRecorder() {
    if (this.recorder.isRecording()) {
      await this.recorder.stopRecording();
    }
  }

  private transitionTo(state: AutoRecordState) {
    this.state = state;
    this.log('AutoRecord state ->', state);
  }

  private fail(err: Error) {
    this.clearTimers();
    this.lastError = err.message;
    this.resetSession(false);
    this.transitionTo('failed');
    this.log('AutoRecord failed', err.message);
  }

  private schedule(task: () => void, delay: number) {
    const handle = setTimeout(task, delay);
    this.timers.push(handle);
  }

  private clearTimers() {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    if (this.pollHandle) {
      clearTimeout(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private resetSession(resetState = true) {
    if (resetState) {
      this.transitionTo('idle');
    }
    this.startedAt = null;
    this.recordingFilename = null;
    this.resetDetectionState();
  }

  private resetDetectionState() {
    this.lastFrameTs = null;
    this.stableStartTs = null;
    this.stableRefBox = null;
    this.missingPersonFrames = 0;
  }

  private startPolling() {
    const tick = async () => {
      if (this.state === 'idle' || this.state === 'failed') return;
      try {
        await this.handleDetectionTick();
      } catch (err) {
        this.log('Detection tick failed', (err as Error).message);
      } finally {
        if (this.state !== 'idle' && this.state !== 'failed') {
          this.pollHandle = setTimeout(tick, this.config.pollIntervalMs);
        }
      }
    };
    this.pollHandle = setTimeout(tick, this.config.pollIntervalMs);
  }

  private async handleDetectionTick() {
    if (this.detectorPaused && this.state === 'recording') {
      return;
    }
    const frame = await this.detector.getLatestFrame();
    if (!frame) {
      if (this.state === 'recording') {
        this.missingPersonFrames += 1;
        if (this.missingPersonFrames >= this.config.swingEndMissingFrames) {
          this.enterFinishLocked();
        }
      }
      return;
    }
    const frameTs = frame.t ?? null;
    if (frameTs !== null && this.lastFrameTs === frameTs) {
      return;
    }
    this.lastFrameTs = frameTs;

    const person = this.findPerson(frame);
    if (!person) {
      this.missingPersonFrames += 1;
      this.stableStartTs = null;
      this.stableRefBox = null;
      if (this.state === 'recording' && this.missingPersonFrames >= this.config.swingEndMissingFrames) {
        this.enterFinishLocked();
      }
      return;
    }

    this.missingPersonFrames = 0;
    if (this.state === 'arming') {
      if (this.isStableAddress(person, frameTs)) {
        this.enterAddressLocked();
      }
    }
  }

  private findPerson(frame: AutoRecordFrame) {
    const detections = frame.detections || [];
    const minConf = this.config.minPersonConfidence;
    const person = detections.find((det) => {
      if (!det) return false;
      if (det.conf !== null && det.conf !== undefined && det.conf < minConf) return false;
      if (det.label && det.label.toLowerCase() === 'person') return true;
      if (det.classId !== null && det.classId !== undefined) {
        return Number(det.classId) === 1 || Number(det.classId) === 0;
      }
      return false;
    });
    return person || null;
  }

  private isStableAddress(det: DetectionBox, frameTs: number | null) {
    const [x, y, w, h] = det.bbox;
    const centerX = x + w / 2;
    const centerY = y + h / 2;
    const area = w * h;
    if (!this.stableRefBox) {
      this.stableRefBox = det;
      this.stableStartTs = frameTs ?? Date.now();
      return false;
    }

    const [px, py, pw, ph] = this.stableRefBox.bbox;
    const prevCenterX = px + pw / 2;
    const prevCenterY = py + ph / 2;
    const prevArea = pw * ph;
    const centerDelta = Math.hypot(centerX - prevCenterX, centerY - prevCenterY);
    const areaDeltaRatio = prevArea > 0 ? Math.abs(area - prevArea) / prevArea : 0;
    const isStable =
      centerDelta <= this.config.addressMaxCenterDeltaPx &&
      areaDeltaRatio <= this.config.addressMaxAreaDeltaRatio;
    if (!isStable) {
      this.stableRefBox = det;
      this.stableStartTs = frameTs ?? Date.now();
      return false;
    }
    const startTs = this.stableStartTs ?? (frameTs ?? Date.now());
    const currentTs = frameTs ?? Date.now();
    if (currentTs - startTs >= this.config.addressStillMs) {
      return true;
    }
    return false;
  }

  private log(...args: unknown[]) {
    if (this.logger) {
      this.logger('[auto-record]', ...args);
    }
  }
}
