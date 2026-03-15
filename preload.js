const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ── Paths & settings ──────────────────────────────────────────
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  getAppInfo:      () => ipcRenderer.invoke('get-app-info'),
  getSettings:     () => ipcRenderer.invoke('get-settings'),
  saveSettings:    (s) => ipcRenderer.invoke('save-settings', s),

  // ── Model loading (fire-and-forget; progress comes back as events) ─
  startModelLoading: (modelName, cacheDir) =>
    ipcRenderer.send('start-model-loading', { modelName, cacheDir }),

  reloadModel: (modelName, cacheDir) =>
    ipcRenderer.send('reload-model', { modelName, cacheDir }),

  // ── Transcription (blocking call, returns text) ───────────────
  // audioBuffer must be an ArrayBuffer containing Float32 PCM at 16 kHz
  transcribe: (audioBuffer) => ipcRenderer.invoke('transcribe', audioBuffer),

  // ── File operations ───────────────────────────────────────────
  saveNote: (content, suggestedName) =>
    ipcRenderer.invoke('save-note', { content, suggestedName }),
  openFile: () => ipcRenderer.invoke('open-file'),

  // ── Main → renderer events ────────────────────────────────────
  onModelProgress:      (cb) => ipcRenderer.on('model-progress',  (_e, p)   => cb(p)),
  onModelReady:         (cb) => ipcRenderer.on('model-ready',     ()        => cb()),
  onModelError:         (cb) => ipcRenderer.on('model-error',     (_e, msg) => cb(msg)),
  onTranscribing:       (cb) => ipcRenderer.on('transcribing',    ()        => cb()),

  // Native menu → renderer
  onMenuNew:  (cb) => ipcRenderer.on('menu-new',  () => cb()),
  onMenuOpen: (cb) => ipcRenderer.on('menu-open', () => cb()),
  onMenuSave: (cb) => ipcRenderer.on('menu-save', () => cb()),
  onMenuHelp: (cb) => ipcRenderer.on('menu-help', () => cb()),
});
