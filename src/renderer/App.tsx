import { Activity, BadgeInfo, Cpu, FolderOpen, Gauge, Mic, Monitor, MousePointer2, Play, Square, TimerReset } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { RecorderRuntime, RecorderSettings } from '../shared/types';

const initialSettings: RecorderSettings = {
  mode: 'full',
  displayIndex: 0,
  captureBackendPreference: 'auto',
  frameRateMode: 'auto',
  fps: 60,
  includeCursor: true,
  showStatusOverlay: true,
  audioEnabled: false,
  audioDeviceName: '',
  outputDirectory: '',
  region: {
    x: 0,
    y: 0,
    width: 1280,
    height: 720
  }
};

export function App(): JSX.Element {
  const [runtime, setRuntime] = useState<RecorderRuntime | null>(null);
  const [settings, setSettings] = useState<RecorderSettings>(initialSettings);
  const [elapsed, setElapsed] = useState('00:00');
  const [bridgeError, setBridgeError] = useState<string | null>(null);

  const isRecording = runtime?.status === 'recording' || runtime?.status === 'starting';
  const probe = runtime?.probe;
  const stats = runtime?.stats;
  const lastLogs = runtime?.logTail.slice(-12) ?? [];

  useEffect(() => {
    if (!window.projetX) {
      setBridgeError('Recorder bridge is not available. Restart the app after the preload build completes.');
      return undefined;
    }

    window.projetX.getInitialState().then(setRuntime).catch((error: Error) => setBridgeError(error.message));
    window.projetX.probe().then(setRuntime).catch((error: Error) => setBridgeError(error.message));
    const unsubscribe = window.projetX.onRuntimeUpdate(setRuntime);
    return unsubscribe;
  }, []);

  useEffect(() => {
    window.projetX?.updateSettings(settings).catch((error: Error) => setBridgeError(error.message));
  }, [settings]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!runtime?.startedAt) {
        setElapsed('00:00');
        return;
      }

      const seconds = Math.max(0, Math.floor((Date.now() - runtime.startedAt) / 1000));
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
      const ss = String(seconds % 60).padStart(2, '0');
      setElapsed(`${mm}:${ss}`);
    }, 500);

    return () => window.clearInterval(timer);
  }, [runtime?.startedAt]);

  const engineLabel = useMemo(() => {
    if (!probe) return '检测中';
    if (!probe.available) return '不可用';
    return `${(runtime?.activeCaptureBackend ?? probe.captureBackend).toUpperCase()} / ${probe.encoder}`;
  }, [probe, runtime?.activeCaptureBackend]);

  async function toggleRecording(): Promise<void> {
    if (!window.projetX) {
      setBridgeError('Recorder bridge is not available.');
      return;
    }

    try {
      setBridgeError(null);

      if (isRecording) {
        setRuntime(await window.projetX.stop());
        return;
      }

      const result = await window.projetX.start({
        ...settings,
        outputDirectory: settings.outputDirectory.trim()
      });
      setRuntime(result.runtime);
    } catch (error) {
      setBridgeError(error instanceof Error ? error.message : String(error));
    }
  }

  async function chooseOutputDirectory(): Promise<void> {
    if (!window.projetX) {
      setBridgeError('Recorder bridge is not available.');
      return;
    }

    const directory = await window.projetX.chooseOutputDirectory();
    if (directory) {
      setSettings((current) => ({ ...current, outputDirectory: directory }));
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">ProjetX Recorder</p>
          <h1>低负担录屏控制台</h1>
          <p className="subtitle">Electron 只负责界面和控制，视频帧交给独立录制进程处理。</p>
        </div>
        <div className="recordActions">
          <button className={isRecording ? 'recordButton stop' : 'recordButton'} onClick={toggleRecording}>
            {isRecording ? <Square size={22} /> : <Play size={24} />}
            <span>{isRecording ? '停止录制' : '开始录制'}</span>
          </button>
          <span className="hotkeyHint">Ctrl + Shift + R</span>
        </div>
      </section>

      <section className="statusStrip">
        <Metric icon={<Activity size={18} />} label="状态" value={runtime?.status ?? 'loading'} />
        <Metric icon={<TimerReset size={18} />} label="时长" value={elapsed} />
        <Metric icon={<Cpu size={18} />} label="引擎" value={engineLabel} />
        <Metric icon={<Monitor size={18} />} label="屏幕 Hz" value={probe?.displayRefreshRate ? `${probe.displayRefreshRate} Hz` : '--'} />
        <Metric icon={<Gauge size={18} />} label="实时 FPS" value={stats?.fps == null ? `${settings.frameRateMode === 'auto' ? 'auto' : settings.fps}` : `${stats.fps}`} />
        <Metric icon={<BadgeInfo size={18} />} label="码率 / 丢帧" value={`${stats?.bitrate ?? '--'} / ${stats?.drop ?? 0}`} />
      </section>

      <section className="workspace">
        <div className="panel">
          <div className="panelHeader">
            <Monitor size={18} />
            <h2>录制范围</h2>
          </div>

          <div className="segmented">
            <button className={settings.mode === 'full' ? 'active' : ''} onClick={() => setSettings({ ...settings, mode: 'full' })}>
              整屏
            </button>
            <button className={settings.mode === 'region' ? 'active' : ''} onClick={() => setSettings({ ...settings, mode: 'region' })}>
              区域
            </button>
          </div>

          <label className="field">
            <span>显示器序号</span>
            <input
              type="number"
              min={0}
              value={settings.displayIndex}
              onChange={(event) => setSettings({ ...settings, displayIndex: Number(event.target.value) })}
            />
          </label>

          <label className="field">
            <span>捕获模式</span>
            <select
              value={settings.captureBackendPreference}
              onChange={(event) =>
                setSettings({ ...settings, captureBackendPreference: event.target.value as RecorderSettings['captureBackendPreference'] })
              }
            >
              <option value="auto">自动：优先高性能</option>
              <option value="ddagrab">高性能：DDAGRAB</option>
              <option value="gdigrab">兼容：GDIGRAB</option>
            </select>
          </label>

          <p className="hintText">游戏建议使用无边框窗口。独占全屏或反作弊保护的游戏需要专门的 Game Capture/native 捕获。</p>

          <label className="field">
            <span>帧率</span>
            <div className="inlineControls">
              <select
                value={settings.frameRateMode}
                onChange={(event) => setSettings({ ...settings, frameRateMode: event.target.value as RecorderSettings['frameRateMode'] })}
              >
                <option value="auto">自动</option>
                <option value="manual">手动</option>
              </select>
              <input
                type="number"
                min={10}
                max={120}
                disabled={settings.frameRateMode === 'auto'}
                value={settings.fps}
                onChange={(event) => setSettings({ ...settings, fps: Number(event.target.value) })}
              />
            </div>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.includeCursor}
              onChange={(event) => setSettings({ ...settings, includeCursor: event.target.checked })}
            />
            <MousePointer2 size={18} />
            <span>录制鼠标指针</span>
          </label>

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.showStatusOverlay}
              onChange={(event) => setSettings({ ...settings, showStatusOverlay: event.target.checked })}
            />
            <BadgeInfo size={18} />
            <span>屏幕右上角显示状态</span>
          </label>

          <div className={settings.mode === 'region' ? 'regionGrid enabled' : 'regionGrid'}>
            <NumberField label="X" value={settings.region.x} onChange={(x) => setRegion({ x })} />
            <NumberField label="Y" value={settings.region.y} onChange={(y) => setRegion({ y })} />
            <NumberField label="宽" value={settings.region.width} onChange={(width) => setRegion({ width })} />
            <NumberField label="高" value={settings.region.height} onChange={(height) => setRegion({ height })} />
          </div>
        </div>

        <div className="panel">
          <div className="panelHeader">
            <FolderOpen size={18} />
            <h2>输出</h2>
          </div>

          <div className="pathRow">
            <input
              value={settings.outputDirectory}
              placeholder="默认保存到系统 Videos/projetX"
              onChange={(event) => setSettings({ ...settings, outputDirectory: event.target.value })}
            />
            <button className="iconButton" aria-label="选择保存目录" title="选择保存目录" onClick={chooseOutputDirectory}>
              <FolderOpen size={18} />
            </button>
          </div>

          <button
            className="secondaryButton"
            onClick={() => window.projetX.openOutputFolder().catch((error: Error) => setBridgeError(error.message))}
          >
            打开输出目录
          </button>

          {bridgeError ? <p className="errorText">{bridgeError}</p> : null}

          <div className={probe?.available ? 'engine good' : 'engine bad'}>
            <strong>{probe?.message ?? '正在检测录制引擎'}</strong>
            <span>{probe?.ffmpegPath ?? 'FFmpeg 路径未确定'}</span>
          </div>

          {runtime?.lastError ? <p className="errorText">{runtime.lastError}</p> : null}
        </div>

        <div className="panel">
          <div className="panelHeader">
            <Mic size={18} />
            <h2>声音</h2>
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={settings.audioEnabled}
              onChange={(event) => setSettings({ ...settings, audioEnabled: event.target.checked })}
            />
            <Mic size={18} />
            <span>同步录入音频</span>
          </label>

          <label className="field">
            <span>输入设备</span>
            <select
              value={settings.audioDeviceName}
              disabled={!settings.audioEnabled}
              onChange={(event) => setSettings({ ...settings, audioDeviceName: event.target.value })}
            >
              <option value="">选择 DirectShow 音频设备</option>
              {(probe?.audioDevices ?? []).map((device) => (
                <option key={device} value={device}>
                  {device}
                </option>
              ))}
            </select>
          </label>

          {!probe?.audioDevices.length ? <p className="hintText">当前环境没有枚举到 DirectShow 音频设备。实体 Windows 桌面通常会显示麦克风或 Stereo Mix。</p> : null}
        </div>

        <div className="panel logPanel">
          <div className="panelHeader">
            <Activity size={18} />
            <h2>录制日志</h2>
          </div>
          <pre>{lastLogs.length ? lastLogs.join('\n') : '等待录制进程输出...'}</pre>
        </div>
      </section>
    </main>
  );

  function setRegion(patch: Partial<RecorderSettings['region']>): void {
    setSettings((current) => ({
      ...current,
      region: {
        ...current.region,
        ...patch
      }
    }));
  }
}

function Metric(props: { icon: JSX.Element; label: string; value: string }): JSX.Element {
  return (
    <div className="metric">
      {props.icon}
      <div>
        <span>{props.label}</span>
        <strong>{props.value}</strong>
      </div>
    </div>
  );
}

function NumberField(props: { label: string; value: number; onChange: (value: number) => void }): JSX.Element {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input type="number" value={props.value} onChange={(event) => props.onChange(Number(event.target.value))} />
    </label>
  );
}
