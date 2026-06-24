# ProjetX Recorder

Electron UI for a Windows-first screen recorder. Electron controls the workflow; the video frames stay in an external FFmpeg process.

## Development

```powershell
npm install
npm run dev
```

The recorder probes FFmpeg in this order:

1. `PROJETX_FFMPEG_PATH`
2. packaged `resources/ffmpeg/ffmpeg.exe`
3. `ffmpeg` on `PATH`
4. `ffmpeg-static`
5. `@ffmpeg-installer/ffmpeg`

The app prefers `ddagrab` plus hardware encoders such as `h264_nvenc`, `h264_qsv`, or `h264_amf`. It falls back to `gdigrab` and `libx264` if needed. For smooth 2K/high-refresh recording, keep the in-video status overlay off unless you need diagnostic burn-in.
