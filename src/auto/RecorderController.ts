import { ChildProcess, spawn } from 'child_process';
import { promises as fsp } from 'fs';
import path from 'path';
import { RecorderAdapter, RecorderControllerOptions } from './types';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildGstShmRecordArgs } = require('../session/gstPipeline');

const createError = (message: string, status = 500) => {
  const err = new Error(message) as Error & { status?: number };
  err.status = status;
  return err;
};

export class RecorderController implements RecorderAdapter {
  private process: ChildProcess | null = null;
  private currentFile: { filename: string; tempPath: string; finalPath: string } | null = null;
  private lockHeld = false;
  private stopping = false;
  private options: RecorderControllerOptions;

  constructor(options: RecorderControllerOptions) {
    this.options = options;
  }

  isRecording() {
    return Boolean(this.process);
  }

  async startRecording() {
    if (this.process) {
      throw createError('Recording already in progress', 409);
    }
    const expectedMs = this.options.lockTimeoutMs ?? 10 * 60 * 1000;
    const acquired = await this.options.acquireLock(expectedMs);
    if (!acquired) {
      throw createError('Camera busy', 409);
    }
    this.lockHeld = true;
    await this.options.ensureUploadsDir();
    const filename = this.ensureMp4Extension(this.options.buildFilename());
    const finalPath = path.join(this.options.uploadDir, filename);
    const tempPath = `${finalPath}.part`;
    await fsp.mkdir(path.dirname(finalPath), { recursive: true });
    await fsp.unlink(tempPath).catch(() => undefined);
    const mode = this.options.mode || 'camera';
    const args = mode === 'shm' ? this.buildShmArgs(tempPath) : this.buildArgs(tempPath);
    const child = mode === 'shm' ? await this.spawnGstRecorder(args) : await this.spawnRecorder(args);
    const stderrLabel = mode === 'shm' ? '[gst-launch]' : '[libcamera-vid]';
    child.stderr?.on('data', (data) => this.log(stderrLabel, data.toString().trim()));
    child.on('close', (code, signal) => {
      this.log('Recorder closed', code, signal || '');
      this.process = null;
      this.stopping = false;
      if (this.lockHeld) {
        this.options.releaseLock().catch((err) => this.log('releaseLock failed', err));
        this.lockHeld = false;
      }
      if (code !== 0 && !this.stopping) {
        this.log('Recorder exited unexpectedly', code);
      }
    });
    child.on('error', (err) => {
      this.log('Recorder process error', err.message);
    });
    this.process = child;
    this.currentFile = { filename, finalPath, tempPath };
    return { filename };
  }

  async stopRecording() {
    if (!this.process || !this.currentFile) {
      throw createError('Recorder not running', 400);
    }
    if (this.stopping) {
      return { filename: this.currentFile.filename };
    }
    this.stopping = true;
    const child = this.process;
    child.kill('SIGINT');
    setTimeout(() => {
      if (child.killed) return;
      child.kill('SIGTERM');
    }, 1500);
    await new Promise<void>((resolve, reject) => {
      const onClose = (code: number | null) => {
        if (code !== 0) {
          reject(createError('Recorder stopped with error'));
        } else {
          resolve();
        }
      };
      child.once('close', onClose);
      child.once('error', (err) => reject(err));
    });
    const { filename } = this.currentFile;
    await this.finalizeFile();
    return { filename };
  }

  private async finalizeFile() {
    if (!this.currentFile) return;
    const { tempPath, finalPath } = this.currentFile;
    try {
      await fsp.rename(tempPath, finalPath);
    } catch (err) {
      this.log('Failed to finalize recording', err);
      throw createError('Failed to finalize recording');
    } finally {
      this.currentFile = null;
    }
  }

  private buildArgs(outputPath: string) {
    const codec = this.options.libavCodec || 'libx264';
    return [
      '--codec',
      'libav',
      '--libav-format',
      'mp4',
      '--libav-video-codec',
      codec,
      '--width',
      String(this.options.width),
      '--height',
      String(this.options.height),
      '--framerate',
      String(this.options.fps),
      '-t',
      '0',
      '-o',
      outputPath,
      '-n',
      '--inline',
    ];
  }

  private buildShmArgs(outputPath: string) {
    const socketPath = this.options.socketPath;
    const srcWidth = this.options.sourceWidth ?? this.options.width;
    const srcHeight = this.options.sourceHeight ?? this.options.height;
    const srcFps = this.options.sourceFps ?? this.options.fps;
    if (!socketPath) {
      throw createError('socketPath is required for shm recording');
    }
    return buildGstShmRecordArgs({
      socketPath,
      width: srcWidth,
      height: srcHeight,
      fps: srcFps,
      outputPath,
      encoder: this.options.encoder,
    });
  }

  private ensureMp4Extension(filename: string) {
    if (filename.endsWith('.mp4')) return filename;
    return `${filename}.mp4`;
  }

  private async spawnRecorder(args: string[]) {
    const commands = this.options.videoCommands?.length
      ? this.options.videoCommands
      : ['rpicam-vid', 'libcamera-vid'];
    let lastErr: Error | null = null;
    for (const command of commands) {
      try {
        this.log('Spawning recorder', command, args.join(' '));
        const child = await new Promise<ChildProcess>((resolve, reject) => {
          const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
          const onError = (err: Error) => {
            proc.removeListener('spawn', onSpawn);
            reject(err);
          };
          const onSpawn = () => {
            proc.removeListener('error', onError);
            resolve(proc);
          };
          proc.once('error', onError);
          proc.once('spawn', onSpawn);
        });
        return child;
      } catch (err) {
        lastErr = err as Error;
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          this.log(`Recorder command ${command} not found, trying next`);
          continue;
        }
        break;
      }
    }
    throw lastErr || createError('No recording command available');
  }

  private async spawnGstRecorder(args: string[]) {
    const command = this.options.gstCmd || 'gst-launch-1.0';
    this.log('Spawning recorder', command, args.join(' '));
    return new Promise<ChildProcess>((resolve, reject) => {
      const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const onError = (err: Error) => {
        proc.removeListener('spawn', onSpawn);
        reject(err);
      };
      const onSpawn = () => {
        proc.removeListener('error', onError);
        resolve(proc);
      };
      proc.once('error', onError);
      proc.once('spawn', onSpawn);
    });
  }

  private log(...args: unknown[]) {
    if (this.options.logger) {
      this.options.logger('[Recorder]', ...args);
    }
  }
}
