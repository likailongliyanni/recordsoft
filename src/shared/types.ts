export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'stopping' | 'error';

export type CaptureMode = 'full' | 'region';
export type FrameRateMode = 'auto' | 'manual';
export type CaptureBackend = 'ddagrab' | 'gdigrab';
export type CaptureBackendPreference = 'auto' | CaptureBackend;

export interface CaptureRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecorderSettings {
  mode: CaptureMode;
  displayIndex: number;
  captureBackendPreference: CaptureBackendPreference;
  frameRateMode: FrameRateMode;
  fps: number;
  includeCursor: boolean;
  showStatusOverlay: boolean;
  audioEnabled: boolean;
  audioDeviceName: string;
  outputDirectory: string;
  region: CaptureRegion;
}

export interface RecorderStats {
  frame: number | null;
  fps: number | null;
  bitrate: string | null;
  speed: string | null;
  dup: number | null;
  drop: number | null;
}

export interface RecorderProbe {
  ffmpegPath: string | null;
  available: boolean;
  captureBackend: 'ddagrab' | 'gdigrab' | 'unavailable';
  captureBackends: CaptureBackend[];
  encoder: string | null;
  hardwareEncoder: boolean;
  displayRefreshRate: number | null;
  encoders: string[];
  filters: string[];
  audioDevices: string[];
  message: string;
}

export interface RecorderRuntime {
  status: RecorderStatus;
  startedAt: number | null;
  outputFile: string | null;
  lastError: string | null;
  activeCaptureBackend: CaptureBackend | null;
  logTail: string[];
  probe: RecorderProbe | null;
  stats: RecorderStats;
}

export interface RecorderStartResult {
  ok: boolean;
  runtime: RecorderRuntime;
}
