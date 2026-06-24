import { contextBridge, ipcRenderer } from 'electron';
import type { RecorderRuntime, RecorderSettings, RecorderStartResult } from '../shared/types';

const api = {
  getInitialState: (): Promise<RecorderRuntime> => ipcRenderer.invoke('recorder:get-state'),
  chooseOutputDirectory: (): Promise<string | null> => ipcRenderer.invoke('recorder:choose-output-directory'),
  probe: (): Promise<RecorderRuntime> => ipcRenderer.invoke('recorder:probe'),
  updateSettings: (settings: RecorderSettings): Promise<RecorderRuntime> => ipcRenderer.invoke('recorder:update-settings', settings),
  start: (settings: RecorderSettings): Promise<RecorderStartResult> => ipcRenderer.invoke('recorder:start', settings),
  stop: (): Promise<RecorderRuntime> => ipcRenderer.invoke('recorder:stop'),
  openOutputFolder: (): Promise<void> => ipcRenderer.invoke('recorder:open-output-folder'),
  onRuntimeUpdate: (callback: (runtime: RecorderRuntime) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, runtime: RecorderRuntime): void => callback(runtime);
    ipcRenderer.on('recorder:runtime-update', listener);
    return () => ipcRenderer.removeListener('recorder:runtime-update', listener);
  }
};

contextBridge.exposeInMainWorld('projetX', api);

export type ProjetXApi = typeof api;
