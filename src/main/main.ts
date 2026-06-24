import { app, BrowserWindow, globalShortcut, ipcMain, nativeTheme } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RecorderController } from './recorder';
import type { RecorderSettings } from '../shared/types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let recorder: RecorderController;

const isDev = process.env.NODE_ENV === 'development' || Boolean(process.env.ELECTRON_RENDERER_URL);

function createWindow(): void {
  nativeTheme.themeSource = 'dark';

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 920,
    minHeight: 640,
    title: 'ProjetX Recorder',
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.on('console-message', (_event, details) => {
    console.log(`[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('renderer loaded');
  });

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    loadDevRenderer(mainWindow, process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

function loadDevRenderer(window: BrowserWindow, url: string): void {
  let attempts = 0;

  const load = (): void => {
    attempts += 1;
    window.loadURL(url).catch(() => {
      if (attempts < 30 && !window.isDestroyed()) {
        setTimeout(load, 350);
      }
    });
  };

  window.webContents.on('did-fail-load', (_event, _code, _description, failedUrl) => {
    if (failedUrl === url && attempts < 30 && !window.isDestroyed()) {
      setTimeout(load, 350);
    }
  });

  load();
}

app.whenReady().then(() => {
  recorder = new RecorderController(() => mainWindow);
  registerIpc();
  createWindow();

  globalShortcut.register('CommandOrControl+Shift+R', async () => {
    await recorder.toggleRecording();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

function registerIpc(): void {
  ipcMain.handle('recorder:get-state', () => recorder.getState());
  ipcMain.handle('recorder:choose-output-directory', () => recorder.chooseOutputDirectory());
  ipcMain.handle('recorder:probe', () => recorder.probe());
  ipcMain.handle('recorder:update-settings', (_event, settings: RecorderSettings) => recorder.updateSettings(settings));
  ipcMain.handle('recorder:start', async (_event, settings: RecorderSettings) => {
    const runtime = await recorder.start(settings);
    return {
      ok: runtime.status === 'recording',
      runtime
    };
  });
  ipcMain.handle('recorder:stop', () => recorder.stop());
  ipcMain.handle('recorder:open-output-folder', () => recorder.openOutputFolder());
}
