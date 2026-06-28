import { app, BrowserWindow, dialog, screen, shell } from 'electron';
import { ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { CaptureBackend, RecorderProbe, RecorderRuntime, RecorderSettings, RecorderStats } from '../shared/types';

const LOG_TAIL_LIMIT = 80;
const HW_ENCODERS = ['h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf'];
const require = createRequire(import.meta.url);

export class RecorderController {
  private process: ChildProcessWithoutNullStreams | null = null;
  private overlayWindow: BrowserWindow | null = null;
  private lastSettings: RecorderSettings = defaultSettings();
  private effectiveFps: number | null = null;
  private autoRestartCount = 0;
  private runtime: RecorderRuntime = {
    status: 'idle',
    startedAt: null,
    outputFile: null,
    lastError: null,
    activeCaptureBackend: null,
    logTail: [],
    probe: null,
    stats: emptyStats()
  };

  constructor(private readonly windowProvider: () => BrowserWindow | null) {}

  getState(): RecorderRuntime {
    return structuredClone(this.runtime);
  }

  updateSettings(settings: RecorderSettings): RecorderRuntime {
    this.lastSettings = normalizeSettings(settings);
    this.syncOverlay();
    return this.getState();
  }

  async toggleRecording(): Promise<RecorderRuntime> {
    const state = this.getState();
    if (state.status === 'recording' || state.status === 'starting') {
      return this.stop();
    }

    return this.start(this.lastSettings);
  }

  async chooseOutputDirectory(): Promise<string | null> {
    const result = await dialog.showOpenDialog(this.windowProvider() ?? undefined, {
      title: '选择录制保存位置',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: this.defaultOutputDirectory()
    });

    return result.canceled ? null : result.filePaths[0] ?? null;
  }

  async probe(): Promise<RecorderRuntime> {
    this.runtime.probe = probeFfmpeg();
    this.emit();
    return this.getState();
  }

  async start(settings: RecorderSettings): Promise<RecorderRuntime> {
    if (this.process) {
      return this.getState();
    }

    this.autoRestartCount = 0;
    this.lastSettings = normalizeSettings(settings);
    this.runtime.status = 'starting';
    this.runtime.lastError = null;
    this.runtime.logTail = [];
    this.runtime.stats = emptyStats();
    this.runtime.probe = probeFfmpeg();
    this.emit();

    if (!this.runtime.probe.available || !this.runtime.probe.ffmpegPath || !this.runtime.probe.encoder) {
      this.runtime.status = 'error';
      this.runtime.lastError = this.runtime.probe.message;
      this.emit();
      return this.getState();
    }

    if (this.lastSettings.audioEnabled && !this.lastSettings.audioDeviceName.trim()) {
      this.runtime.status = 'error';
      this.runtime.lastError = 'Audio recording is enabled, but no audio input device is selected.';
      this.emit();
      return this.getState();
    }

    const outputDirectory = normalizeOutputDirectory(this.lastSettings.outputDirectory || this.defaultOutputDirectory());
    if (!ensureDirectory(outputDirectory)) {
      this.runtime.status = 'error';
      this.runtime.lastError = `Cannot create or access output directory: ${outputDirectory}`;
      this.emit();
      return this.getState();
    }

    const effectiveSettings = {
      ...this.lastSettings,
      fps: resolveEffectiveFps(this.lastSettings, this.runtime.probe, resolveCaptureBackend(this.runtime.probe, this.lastSettings))
    };
    const activeCaptureBackend = resolveCaptureBackend(this.runtime.probe, effectiveSettings);
    this.effectiveFps = effectiveSettings.fps;
    this.runtime.activeCaptureBackend = activeCaptureBackend;
    const outputFile = path.join(outputDirectory, `projetx-${timestampForFile()}.mp4`);
    const args = buildFfmpegArgs(this.runtime.probe, effectiveSettings, outputFile, activeCaptureBackend);

    this.appendLog(`ffmpeg ${args.map(quoteArg).join(' ')}`);

    this.process = spawn(this.runtime.probe.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'ignore', 'pipe']
    });

    this.runtime.status = 'recording';
    this.runtime.startedAt = Date.now();
    this.runtime.outputFile = outputFile;
    this.syncOverlay();
    this.emit();

    this.process.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const stats = parseStatsLine(line);
        if (stats) {
          this.runtime.stats = stats;
          this.emit();
        } else {
          this.appendLog(line.trim());
        }
      }
    });

    this.process.once('error', (error) => {
      this.runtime.status = 'error';
      this.runtime.lastError = error.message;
      this.process = null;
      this.cleanupFailedOutput();
      this.emit();
    });

    this.process.once('exit', (code) => {
      const wasStopping = this.runtime.status === 'stopping';
      const ok = wasStopping;
      const stoppedBackend = this.runtime.activeCaptureBackend;

      this.process = null;
      this.runtime.status = ok ? 'idle' : 'error';
      this.runtime.startedAt = null;
      this.effectiveFps = null;
      this.runtime.activeCaptureBackend = null;
      if (!ok) {
        const detail = this.runtime.logTail.slice(-4).join('\n');
        this.runtime.lastError = detail || `FFmpeg exited with code ${code ?? 'unknown'}.`;
        this.cleanupFailedOutput();
      }
      this.syncOverlay();
      this.emit();

      if (!ok) {
        this.tryAutoRestart(stoppedBackend, code);
      }
    });

    return this.getState();
  }

  async stop(): Promise<RecorderRuntime> {
    if (!this.process) {
      this.runtime.status = 'idle';
      this.runtime.startedAt = null;
      this.runtime.activeCaptureBackend = null;
      this.emit();
      return this.getState();
    }

    this.runtime.status = 'stopping';
    this.syncOverlay();
    this.emit();

    this.process.stdin.write('q');
    setTimeout(() => {
      if (this.process) {
        this.process.kill();
      }
    }, 3500).unref();

    return this.getState();
  }

  private tryAutoRestart(stoppedBackend: CaptureBackend | null, code: number | null): void {
    if (this.autoRestartCount >= 2) return;

    this.autoRestartCount += 1;
    const nextSettings = { ...this.lastSettings };

    if (stoppedBackend === 'ddagrab' && nextSettings.captureBackendPreference === 'auto') {
      nextSettings.captureBackendPreference = 'gdigrab';
      this.appendLog('Capture interrupted. Retrying with GDIGRAB compatibility mode.');
    } else {
      this.appendLog('Capture interrupted. Restarting recorder.');
    }

    this.runtime.status = 'starting';
    this.runtime.lastError = `Capture process stopped unexpectedly (${code ?? 'unknown'}). Restarting...`;
    this.emit();

    setTimeout(() => {
      if (!this.process && this.runtime.status === 'starting') {
        this.startAutoRestart(nextSettings);
      }
    }, 1200).unref();
  }

  private async startAutoRestart(settings: RecorderSettings): Promise<void> {
    const restartCount = this.autoRestartCount;
    await this.start(settings);
    this.autoRestartCount = restartCount;
  }

  async openOutputFolder(): Promise<void> {
    const target = normalizeOutputDirectory(this.runtime.outputFile ? path.dirname(this.runtime.outputFile) : this.defaultOutputDirectory());
    ensureDirectory(target);
    await shell.openPath(target);
  }

  defaultOutputDirectory(): string {
    return path.join(homedir(), 'Videos', 'projetX');
  }

  private appendLog(line: string): void {
    this.runtime.logTail = [...this.runtime.logTail, line].slice(-LOG_TAIL_LIMIT);
    this.emit();
  }

  private cleanupFailedOutput(): void {
    const outputFile = this.runtime.outputFile;
    if (!outputFile || !existsSync(outputFile)) return;

    try {
      unlinkSync(outputFile);
      this.appendLog(`已删除失败录制产生的空文件：${outputFile}`);
      this.runtime.outputFile = null;
    } catch (error) {
      this.appendLog(`清理失败录制文件时出错：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private emit(): void {
    this.syncOverlay();
    this.windowProvider()?.webContents.send('recorder:runtime-update', this.getState());
  }

  private syncOverlay(): void {
    const shouldShow = this.lastSettings.showStatusOverlay && (this.runtime.status === 'recording' || this.runtime.status === 'starting' || this.runtime.status === 'stopping');

    if (!shouldShow) {
      this.destroyOverlay();
      return;
    }

    if (!this.overlayWindow || this.overlayWindow.isDestroyed()) {
      this.overlayWindow = createOverlayWindow(this.lastSettings.displayIndex);
    } else {
      positionOverlay(this.overlayWindow, this.lastSettings.displayIndex);
    }

    const payload = {
      status: this.runtime.status,
      fps: this.runtime.stats.fps ?? this.effectiveFps ?? this.lastSettings.fps,
      targetFps: this.effectiveFps ?? this.lastSettings.fps,
      bitrate: this.runtime.stats.bitrate ?? '--',
      drop: this.runtime.stats.drop ?? 0
    };

    this.overlayWindow.webContents.executeJavaScript(`window.updateProjetXOverlay(${JSON.stringify(payload)})`).catch(() => undefined);
  }

  private destroyOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.close();
    }
    this.overlayWindow = null;
  }
}

function probeFfmpeg(): RecorderProbe {
  const ffmpegPath = resolveFfmpegPath();

  if (!ffmpegPath) {
    return {
      ffmpegPath: null,
      available: false,
      captureBackend: 'unavailable',
      captureBackends: [],
      encoder: null,
      hardwareEncoder: false,
      displayRefreshRate: null,
      encoders: [],
      filters: [],
      audioDevices: [],
      message: '未找到 FFmpeg。请设置 PROJETX_FFMPEG_PATH，或重新安装软件。'
    };
  }

  const encoderText = runFfmpeg(ffmpegPath, ['-hide_banner', '-encoders']);
  const filterText = runFfmpeg(ffmpegPath, ['-hide_banner', '-filters']);
  const deviceText = runFfmpeg(ffmpegPath, ['-hide_banner', '-devices']);
  const audioDevices = listAudioDevices(ffmpegPath);

  const encoders = parseCapabilities(encoderText, [...HW_ENCODERS, 'libx264']);
  const filters = parseCapabilities(filterText, ['ddagrab']);
  const captureBackends: CaptureBackend[] = [];
  if (filters.includes('ddagrab')) captureBackends.push('ddagrab');
  if (/\bgdigrab\b/.test(deviceText)) captureBackends.push('gdigrab');
  const encoder = chooseEncoder(ffmpegPath, encoders);
  const captureBackend: RecorderProbe['captureBackend'] = captureBackends.includes('ddagrab')
    ? 'ddagrab'
    : (captureBackends.includes('gdigrab') ? 'gdigrab' : 'unavailable');
  const displayRefreshRate = getDisplayRefreshRate(0);
  const available = Boolean(encoder) && captureBackend !== 'unavailable';

  return {
    ffmpegPath,
    available,
    captureBackend,
    captureBackends,
    encoder,
    hardwareEncoder: encoder ? HW_ENCODERS.includes(encoder) : false,
    displayRefreshRate,
    encoders,
    filters,
    audioDevices,
    message: !captureBackends.length
      ? '当前 FFmpeg 不支持 Windows 桌面抓屏，请重新安装最新版软件。'
      : (encoder
          ? `录制引擎可用：${captureBackend} + ${encoder}`
          : 'FFmpeg 存在，但没有发现能在当前电脑上实际工作的 H.264 编码器。')
  };
}

function resolveFfmpegPath(): string | null {
  const candidates = [
    process.env.PROJETX_FFMPEG_PATH,
    path.join(process.resourcesPath ?? '', 'ffmpeg', 'ffmpeg.exe'),
    findPathFfmpeg(),
    loadStaticPath()
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

function findPathFfmpeg(): string | null {
  const command = spawnSync('where.exe', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
  const firstPath = command.stdout.split(/\r?\n/).find(Boolean);
  return firstPath && existsSync(firstPath) ? firstPath : null;
}

function loadStaticPath(): string | null {
  try {
    const ffmpegStatic = require('ffmpeg-static') as string | null;
    return ffmpegStatic ?? null;
  } catch {
    return null;
  }
}

function runFfmpeg(ffmpegPath: string, args: string[]): string {
  const result = spawnSync(ffmpegPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 7000,
    maxBuffer: 8 * 1024 * 1024
  });

  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function parseCapabilities(output: string, names: string[]): string[] {
  return names.filter((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(output));
}

function listAudioDevices(ffmpegPath: string): string[] {
  const result = runFfmpeg(ffmpegPath, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
  const devices: string[] = [];
  let inAudioSection = false;

  for (const line of result.split(/\r?\n/)) {
    // FFmpeg 5/6：设备名后直接标记 (audio)，不再输出旧版的音频分区标题。
    const taggedAudio = line.match(/"([^"]+)"\s+\(audio\)/i);
    if (taggedAudio?.[1]) {
      devices.push(taggedAudio[1]);
      continue;
    }

    // 兼容旧版 FFmpeg 的分区式输出。
    if (line.includes('DirectShow audio devices')) {
      inAudioSection = true;
      continue;
    }
    if (line.includes('DirectShow video devices')) {
      inAudioSection = false;
      continue;
    }

    if (!inAudioSection) continue;

    const match = line.match(/"([^"]+)"/);
    if (match?.[1] && !line.includes('Alternative name')) {
      devices.push(match[1]);
    }
  }

  return Array.from(new Set(devices));
}

function normalizeOutputDirectory(directory: string): string {
  return path.resolve(directory.trim());
}

function ensureDirectory(directory: string): boolean {
  try {
    if (existsSync(directory)) return true;
    mkdirSync(directory, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function chooseEncoder(ffmpegPath: string, encoders: string[]): string | null {
  const gpuHint = detectGpuHint();
  const byGpu: Record<string, string[]> = {
    nvidia: ['h264_nvenc', 'hevc_nvenc'],
    intel: ['h264_qsv', 'hevc_qsv'],
    amd: ['h264_amf', 'hevc_amf']
  };

  for (const encoder of byGpu[gpuHint] ?? []) {
    if (encoders.includes(encoder) && testEncoder(ffmpegPath, encoder)) return encoder;
  }

  if (encoders.includes('libx264') && testEncoder(ffmpegPath, 'libx264')) {
    return 'libx264';
  }

  return null;
}

function testEncoder(ffmpegPath: string, encoder: string): boolean {
  const result = spawnSync(ffmpegPath, [
    '-v', 'error',
    '-f', 'lavfi',
    '-i', 'color=c=black:s=128x72:r=1',
    '-frames:v', '1',
    '-c:v', encoder,
    '-f', 'null', '-'
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 7000
  });

  return result.status === 0;
}

function detectGpuHint(): 'nvidia' | 'intel' | 'amd' | 'unknown' {
  const result = spawnSync('powershell', ['-NoProfile', '-Command', "(Get-CimInstance Win32_VideoController).Name -join ';'"], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3000
  });
  const text = `${result.stdout} ${result.stderr}`.toLowerCase();

  if (text.includes('nvidia')) return 'nvidia';
  if (text.includes('intel')) return 'intel';
  if (text.includes('amd') || text.includes('radeon')) return 'amd';
  return 'unknown';
}

function resolveEffectiveFps(settings: RecorderSettings, probe: RecorderProbe, activeCaptureBackend: CaptureBackend): number {
  if (settings.frameRateMode === 'manual') {
    return clampInteger(settings.fps, 10, 120);
  }

  const area = estimateCaptureArea(settings);
  const megapixels = area / 1_000_000;
  const refreshRate = getDisplayRefreshRate(settings.displayIndex) ?? probe.displayRefreshRate ?? 60;
  const displayFps = normalizeRefreshRate(refreshRate);

  if (!probe.hardwareEncoder) {
    return displayFps > 60 || megapixels > 2.2 ? Math.max(30, Math.round(displayFps / 2)) : displayFps;
  }

  if (settings.includeCursor && activeCaptureBackend === 'ddagrab' && megapixels <= 4) {
    return Math.max(displayFps, Math.min(120, displayFps * 2));
  }

  if (megapixels >= 7.5 && displayFps > 60) {
    return Math.max(30, Math.round(displayFps / 2));
  }

  if (megapixels >= 3.5 && displayFps > 75) {
    return Math.max(60, Math.round(displayFps / 2));
  }

  return displayFps;
}

function resolveCaptureBackend(probe: RecorderProbe, settings: RecorderSettings): CaptureBackend {
  if (!probe.hardwareEncoder && probe.captureBackends.includes('gdigrab')) return 'gdigrab';
  if (settings.captureBackendPreference === 'gdigrab' && probe.captureBackends.includes('gdigrab')) return 'gdigrab';
  if (settings.captureBackendPreference === 'ddagrab' && probe.captureBackends.includes('ddagrab')) return 'ddagrab';
  if (probe.captureBackends.includes('ddagrab')) return 'ddagrab';
  return 'gdigrab';
}

function estimateCaptureArea(settings: RecorderSettings): number {
  if (settings.mode === 'region') {
    const region = sanitizeRegion(settings.region);
    return region.width * region.height;
  }

  const displays = screen.getAllDisplays();
  const display = displays[settings.displayIndex] ?? displays[0];
  if (!display) return 1920 * 1080;

  const scaleFactor = display.scaleFactor || 1;
  return Math.round(display.bounds.width * scaleFactor) * Math.round(display.bounds.height * scaleFactor);
}

function getDisplayRefreshRate(displayIndex: number): number | null {
  const displays = screen.getAllDisplays();
  const display = displays[displayIndex] ?? displays[0];
  const electronRate = Number((display as { displayFrequency?: number } | undefined)?.displayFrequency);

  if (Number.isFinite(electronRate) && electronRate > 0) {
    return normalizeRefreshRate(electronRate);
  }

  const result = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Where-Object CurrentRefreshRate | Select-Object -First 1 -ExpandProperty CurrentRefreshRate)'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 3000
  });
  const wmiRate = Number.parseFloat(result.stdout.trim());

  return Number.isFinite(wmiRate) && wmiRate > 0 ? normalizeRefreshRate(wmiRate) : null;
}

function normalizeRefreshRate(rate: number): number {
  const rounded = Math.round(rate);
  const standards = [24, 25, 30, 48, 50, 59, 60, 72, 74, 75, 90, 100, 120, 144, 165];
  const nearest = standards.reduce((best, current) => (Math.abs(current - rounded) < Math.abs(best - rounded) ? current : best), standards[0]);
  const normalized = Math.abs(nearest - rounded) <= 2 ? nearest : rounded;

  if (normalized === 59) return 60;
  if (normalized === 74) return 75;
  return clampInteger(normalized, 24, 120);
}

function emptyStats(): RecorderStats {
  return {
    frame: null,
    fps: null,
    bitrate: null,
    speed: null,
    dup: null,
    drop: null
  };
}

function parseStatsLine(line: string): RecorderStats | null {
  if (!line.includes('frame=') || !line.includes('fps=')) return null;

  return {
    frame: readNumber(line, /frame=\s*(\d+)/),
    fps: readNumber(line, /fps=\s*([\d.]+)/),
    bitrate: readText(line, /bitrate=\s*([^\s]+)/),
    speed: readText(line, /speed=\s*([^\s]+)/),
    dup: readNumber(line, /dup=\s*(\d+)/),
    drop: readNumber(line, /drop=\s*(\d+)/)
  };
}

function readNumber(line: string, pattern: RegExp): number | null {
  const value = line.match(pattern)?.[1];
  return value == null ? null : Number(value);
}

function readText(line: string, pattern: RegExp): string | null {
  return line.match(pattern)?.[1] ?? null;
}

function normalizeSettings(settings: RecorderSettings): RecorderSettings {
  return {
    ...settings,
    displayIndex: clampInteger(settings.displayIndex, 0, 8),
    fps: clampInteger(settings.fps, 10, 120),
    outputDirectory: settings.outputDirectory.trim(),
    audioDeviceName: settings.audioDeviceName.trim(),
    region: sanitizeRegion(settings.region)
  };
}

function buildFfmpegArgs(probe: RecorderProbe, settings: RecorderSettings, outputFile: string, activeCaptureBackend: CaptureBackend): string[] {
  const args = ['-y'];
  const fps = clampInteger(settings.fps, 10, 120);
  const region = sanitizeRegion(settings.region);
  const bitrate = chooseVideoBitrate(settings, fps);
  const audioDevice = settings.audioDeviceName.trim();
  const hasAudio = settings.audioEnabled && audioDevice.length > 0;

  if (activeCaptureBackend === 'ddagrab') {
    const source = [
      `ddagrab=output_idx=${clampInteger(settings.displayIndex, 0, 8)}`,
      `draw_mouse=${settings.includeCursor ? 1 : 0}`,
      `framerate=${fps}`,
      'output_fmt=bgra',
      settings.mode === 'region' ? `offset_x=${region.x}` : null,
      settings.mode === 'region' ? `offset_y=${region.y}` : null,
      settings.mode === 'region' ? `video_size=${region.width}x${region.height}` : null
    ].filter(Boolean).join(':');

    args.push('-f', 'lavfi', '-i', source);
  } else {
    args.push('-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', settings.includeCursor ? '1' : '0');
    if (settings.mode === 'region') {
      args.push('-offset_x', String(region.x), '-offset_y', String(region.y), '-video_size', `${region.width}x${region.height}`);
    }
    args.push('-i', 'desktop');
  }

  if (hasAudio) {
    args.push('-thread_queue_size', '1024', '-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${audioDevice}`);
  }

  if (probe.encoder?.includes('nvenc')) {
    args.push('-c:v', probe.encoder, '-preset', activeCaptureBackend === 'ddagrab' ? 'p4' : 'fast', '-tune', 'll', '-rc', 'vbr', '-cq', '23', '-b:v', bitrate.target, '-maxrate', bitrate.max);
  } else if (probe.encoder?.includes('qsv')) {
    args.push('-c:v', probe.encoder, '-global_quality', '24');
  } else if (probe.encoder?.includes('amf')) {
    args.push('-c:v', probe.encoder, '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23');
  } else {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
  }

  if (hasAudio) {
    args.push('-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-af', 'aresample=async=1:first_pts=0', '-shortest');
  }

  if (activeCaptureBackend !== 'ddagrab') {
    args.push('-pix_fmt', 'yuv420p');
  }

  args.push('-movflags', '+faststart', outputFile);
  return args;
}

function chooseVideoBitrate(settings: RecorderSettings, fps: number): { target: string; max: string } {
  const area = estimateCaptureArea(settings);
  const megapixels = area / 1_000_000;

  if (megapixels >= 7.5 || fps > 90) {
    return { target: '12M', max: '30M' };
  }

  if (megapixels >= 3.5 || fps > 60) {
    return { target: '10M', max: '24M' };
  }

  return { target: '8M', max: '20M' };
}

function sanitizeRegion(region: RecorderSettings['region']): RecorderSettings['region'] {
  return {
    x: Math.max(0, Math.trunc(region.x)),
    y: Math.max(0, Math.trunc(region.y)),
    width: Math.max(64, Math.trunc(region.width)),
    height: Math.max(64, Math.trunc(region.height))
  };
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

function createOverlayWindow(displayIndex: number): BrowserWindow {
  const overlay = new BrowserWindow({
    width: 292,
    height: 74,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  positionOverlay(overlay, displayIndex);
  overlay.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml())}`);
  return overlay;
}

function positionOverlay(window: BrowserWindow, displayIndex: number): void {
  const displays = screen.getAllDisplays();
  const display = displays[displayIndex] ?? displays[0];
  if (!display) return;

  const width = 292;
  const height = 74;
  const padding = 18;
  window.setBounds({
    x: Math.round(display.bounds.x + display.bounds.width - width - padding),
    y: Math.round(display.bounds.y + padding),
    width,
    height
  });
}

function overlayHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { box-sizing: border-box; }
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
        font-family: "Segoe UI", Arial, sans-serif;
      }
      .overlay {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px 14px;
        align-items: center;
        width: 100%;
        height: 100%;
        padding: 12px 14px;
        border: 1px solid rgba(125, 211, 252, 0.45);
        border-radius: 8px;
        color: #f8fafc;
        background: rgba(7, 10, 16, 0.72);
      }
      .title {
        color: #7dd3fc;
        font-size: 12px;
        font-weight: 800;
      }
      .fps {
        font-size: 22px;
        font-weight: 900;
      }
      .meta {
        color: #cbd5e1;
        font-size: 12px;
        white-space: nowrap;
      }
      .dot {
        display: inline-block;
        width: 8px;
        height: 8px;
        margin-right: 6px;
        border-radius: 999px;
        background: #f43f5e;
      }
    </style>
  </head>
  <body>
    <div class="overlay">
      <div class="title"><span class="dot"></span>REC</div>
      <div class="fps" id="fps">-- fps</div>
      <div class="meta" id="bitrate">--</div>
      <div class="meta" id="drop">drop 0</div>
    </div>
    <script>
      window.updateProjetXOverlay = function (stats) {
        document.getElementById('fps').textContent = Math.round(Number(stats.fps || stats.targetFps || 0)) + ' fps';
        document.getElementById('bitrate').textContent = stats.bitrate || '--';
        document.getElementById('drop').textContent = 'drop ' + (stats.drop || 0);
      };
    </script>
  </body>
</html>`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function defaultSettings(): RecorderSettings {
  return {
    mode: 'full',
    displayIndex: 0,
    captureBackendPreference: 'auto',
    frameRateMode: 'auto',
    fps: 60,
    includeCursor: true,
    showStatusOverlay: true,
    audioEnabled: false,
    audioDeviceName: '',
    outputDirectory: path.join(app.getPath('videos'), 'projetX'),
    region: {
      x: 0,
      y: 0,
      width: 1280,
      height: 720
    }
  };
}
