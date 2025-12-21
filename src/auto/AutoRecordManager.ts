import {
  AutoRecordConfig,
  AutoRecordManagerOptions,
  AutoRecordState,
  AutoRecordStatus,
  RecorderAdapter,
} from './types';

const DEFAULT_CONFIG: AutoRecordConfig = {
  demoArmingMs: 2000,
  demoAddressToRecordMs: 2000,
  demoRecordingMs: 3000,
  demoFinishMs: 1000,
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
  private lastError: string | null = null;
  private config: AutoRecordConfig = { ...DEFAULT_CONFIG };
  private logger?: (...args: unknown[]) => void;
  private recorder: RecorderAdapter;

  constructor(options: AutoRecordManagerOptions) {
    this.recorder = options.recorder;
    this.logger = options.logger;
  }

  isActive() {
    return this.state !== 'idle' && this.state !== 'failed';
  }

  async start(): Promise<AutoRecordStatus> {
    if (this.state !== 'idle' && this.state !== 'failed') {
      throw createError('Auto record already running', 409);
    }
    this.clearTimers();
    this.lastError = null;
    this.startedAt = new Date().toISOString();
    this.transitionTo('arming');
    this.schedule(() => this.enterAddressLocked(), this.config.demoArmingMs);
    return this.getStatus();
  }

  async stop(reason = 'user'): Promise<AutoRecordStatus> {
    this.log('AutoRecord stop requested', reason);
    this.clearTimers();
    if (this.state === 'recording' || this.state === 'finishLocked' || this.state === 'stopping') {
      await this.safeStopRecorder().catch((err) => this.fail(err as Error));
    }
    this.transitionTo('idle');
    this.startedAt = null;
    this.recordingFilename = null;
    return this.getStatus();
  }

  getStatus(): AutoRecordStatus {
    return {
      enabled: this.isActive(),
      state: this.state,
      startedAt: this.startedAt,
      recordingFilename: this.recordingFilename,
      lastError: this.lastError,
    };
  }

  private enterAddressLocked() {
    if (this.state !== 'arming') return;
    this.transitionTo('addressLocked');
    this.schedule(() => {
      this.transitionToRecording().catch((err) => this.fail(err));
    }, this.config.demoAddressToRecordMs);
  }

  private async transitionToRecording() {
    if (this.state !== 'addressLocked') return;
    try {
      const { filename } = await this.recorder.startRecording();
      this.recordingFilename = filename;
      this.transitionTo('recording');
      this.schedule(() => this.enterFinishLocked(), this.config.demoRecordingMs);
    } catch (err) {
      this.fail(err as Error);
    }
  }

  private enterFinishLocked() {
    if (this.state !== 'recording') return;
    this.transitionTo('finishLocked');
    this.schedule(() => {
      this.handleStopSequence().catch((err) => this.fail(err));
    }, this.config.demoFinishMs);
  }

  private async handleStopSequence() {
    if (this.state !== 'finishLocked' && this.state !== 'recording') return;
    this.transitionTo('stopping');
    await this.safeStopRecorder().catch((err) => this.fail(err as Error));
    this.transitionTo('idle');
    this.startedAt = null;
    this.recordingFilename = null;
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
  }

  private log(...args: unknown[]) {
    if (this.logger) {
      this.logger('[auto-record]', ...args);
    }
  }
}
