const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const { Worker: WorkerThread } = require('worker_threads');
const path = require('path');
const fs   = require('fs');

let mainWindow;
let whisperWorker = null; // Node.js worker_thread running @xenova/transformers

// ─── Window creation ──────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 800,
    minWidth: 700,
    minHeight: 620,
    title: 'Voice Notes',
    backgroundColor: '#f0ede8',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Grant microphone permission automatically
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_wc, permission, callback) => callback(permission === 'media')
  );
  mainWindow.webContents.session.setPermissionCheckHandler(
    (_wc, permission) => permission === 'media'
  );

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Native menu
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'New',    accelerator: 'CmdOrCtrl+N', click: () => mainWindow.webContents.send('menu-new') },
        { label: 'Open…',  accelerator: 'CmdOrCtrl+O', click: () => mainWindow.webContents.send('menu-open') },
        { label: 'Save…',  accelerator: 'CmdOrCtrl+S', click: () => mainWindow.webContents.send('menu-save') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom', label: 'Normal Text Size' },
        { role: 'zoomIn',    label: 'Larger Text' },
        { role: 'zoomOut',   label: 'Smaller Text' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Full Screen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'How to Use', click: () => mainWindow.webContents.send('menu-help') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Whisper worker_thread management ────────────────────────────────────────

function sendToRenderer(channel, ...args) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args);
  }
}

function startWhisperWorker(modelName, cacheDir) {
  // Already loaded — just tell the renderer
  if (whisperWorker) {
    sendToRenderer('model-ready');
    return;
  }

  // .mjs forces Node.js to treat the file as a native ES Module,
  // which is required because @xenova/transformers is ESM-only.
  //
  // When packaged with electron-builder (asar), worker_threads cannot load
  // files from inside the archive. The asarUnpack rule in package.json puts
  // the .mjs file in the app.asar.unpacked directory, and we redirect there.
  let workerPath = path.join(__dirname, 'src', 'node-whisper-worker.mjs');
  if (app.isPackaged) {
    workerPath = workerPath.replace('app.asar', 'app.asar.unpacked');
  }
  whisperWorker = new WorkerThread(workerPath);

  whisperWorker.on('message', (msg) => {
    switch (msg.type) {
      case 'progress':
        sendToRenderer('model-progress', msg.progress);
        break;
      case 'model-ready':
        sendToRenderer('model-ready');
        break;
      case 'transcribing':
        sendToRenderer('transcribing');
        break;
      // 'result' and 'error' during transcription are handled by the
      // per-request handler registered in ipcMain.handle('transcribe')
      default:
        break;
    }
  });

  whisperWorker.on('error', (err) => {
    sendToRenderer('model-error', err.message || 'Worker thread crashed');
    whisperWorker = null;
  });

  whisperWorker.on('exit', (code) => {
    if (code !== 0) {
      sendToRenderer('model-error', `Worker exited unexpectedly (code ${code})`);
      whisperWorker = null;
    }
  });

  whisperWorker.postMessage({ type: 'load-model', modelName, cacheDir });
}

// ─── Settings helpers ─────────────────────────────────────────────────────────

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

const DEFAULT_SETTINGS = {
  apiKey:        '',
  useOnlineMode: false,
  fontSize:      'large',
  appendMode:    true,
  autoSave:      false,
  model:         'Xenova/whisper-tiny.en',
};

function loadSettings() {
  try {
    const p = getSettingsPath();
    if (fs.existsSync(p)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
  return { ...DEFAULT_SETTINGS };
}

function saveSettingsToFile(settings) {
  try {
    const toWrite = { ...settings };
    if (toWrite.apiKey) {
      toWrite.apiKey    = Buffer.from(toWrite.apiKey).toString('base64');
      toWrite._keyEncoded = true;
    }
    fs.writeFileSync(getSettingsPath(), JSON.stringify(toWrite, null, 2));
    return true;
  } catch (e) {
    console.error('Failed to save settings:', e);
    return false;
  }
}

function decodeSettings(raw) {
  if (raw._keyEncoded && raw.apiKey) {
    return { ...raw, apiKey: Buffer.from(raw.apiKey, 'base64').toString('utf8'), _keyEncoded: undefined };
  }
  return raw;
}

// ─── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

ipcMain.handle('get-app-info', () => ({
  isPackaged:    app.isPackaged,
  resourcesPath: process.resourcesPath,
}));

ipcMain.handle('get-settings', () => decodeSettings(loadSettings()));

ipcMain.handle('save-settings', (_e, settings) => saveSettingsToFile(settings));

// Renderer calls this to kick off model loading
ipcMain.on('start-model-loading', (_e, { modelName, cacheDir }) => {
  startWhisperWorker(modelName, cacheDir);
});

// Renderer calls this to reload a different model
ipcMain.on('reload-model', (_e, { modelName, cacheDir }) => {
  if (whisperWorker) {
    whisperWorker.terminate();
    whisperWorker = null;
  }
  startWhisperWorker(modelName, cacheDir);
});

// Blocking transcription call — resolves with text when done
ipcMain.handle('transcribe', async (_e, audioData) => {
  if (!whisperWorker) throw new Error('Voice recognition is not ready yet.');

  return new Promise((resolve, reject) => {
    // 3-minute timeout (max recording length)
    const timeout = setTimeout(() => {
      whisperWorker.off('message', handler);
      reject(new Error('Transcription took too long. Please try a shorter recording.'));
    }, 180_000);

    function handler(msg) {
      if (msg.type === 'result') {
        clearTimeout(timeout);
        whisperWorker.off('message', handler);
        resolve(msg.text);
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        whisperWorker.off('message', handler);
        reject(new Error(msg.error));
      }
      // 'transcribing' is a status update, not final — keep listening
    }

    whisperWorker.on('message', handler);

    // audioData from Electron IPC arrives as a Buffer (Node.js Buffer wraps
    // an ArrayBuffer slice). Reconstruct Float32Array then copy the underlying
    // ArrayBuffer so we can safely transfer it to the worker thread
    // (transferring avoids a full copy inside the worker).
    let srcFloat32;
    if (Buffer.isBuffer(audioData)) {
      srcFloat32 = new Float32Array(
        audioData.buffer,
        audioData.byteOffset,
        audioData.byteLength / 4
      );
    } else {
      srcFloat32 = new Float32Array(audioData);
    }

    // .slice(0) gives us an independent ArrayBuffer we own; safe to transfer.
    const transferBuf = srcFloat32.buffer.slice(
      srcFloat32.byteOffset,
      srcFloat32.byteOffset + srcFloat32.byteLength
    );

    // postMessage with transfer list — zero-copy handoff to the worker
    whisperWorker.postMessage(
      { type: 'transcribe', audio: transferBuf },
      [transferBuf]
    );
  });
});

ipcMain.handle('save-note', async (_e, { content, suggestedName }) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || `notes-${todayDate()}.txt`,
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files',  extensions: ['*'] },
    ],
    title: 'Save Your Notes',
  });
  if (canceled || !filePath) return { success: false, canceled: true };
  try {
    fs.writeFileSync(filePath, content, 'utf8');
    return { success: true, filePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('open-file', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files',  extensions: ['*'] },
    ],
    title: 'Open Notes',
    properties: ['openFile'],
  });
  if (canceled || filePaths.length === 0) return { success: false, canceled: true };
  try {
    const content = fs.readFileSync(filePaths[0], 'utf8');
    return { success: true, content, filePath: filePaths[0] };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

function todayDate() {
  return new Date().toISOString().split('T')[0];
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (whisperWorker) { whisperWorker.terminate(); whisperWorker = null; }
  if (process.platform !== 'darwin') app.quit();
});
