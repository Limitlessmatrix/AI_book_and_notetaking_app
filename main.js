const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

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
      // Allow WASM and local file access needed for offline Whisper
      webSecurity: true,
    },
  });

  // Grant microphone permission automatically
  mainWindow.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      if (permission === 'media') {
        callback(true);
      } else {
        callback(false);
      }
    }
  );

  // Also handle permission checks (for newer Electron versions)
  mainWindow.webContents.session.setPermissionCheckHandler(
    (webContents, permission) => {
      if (permission === 'media') return true;
      return false;
    }
  );

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Build a simple native menu
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow.webContents.send('menu-new'),
        },
        {
          label: 'Open...',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow.webContents.send('menu-open'),
        },
        {
          label: 'Save...',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow.webContents.send('menu-save'),
        },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom', label: 'Normal Text Size' },
        { role: 'zoomIn', label: 'Larger Text' },
        { role: 'zoomOut', label: 'Smaller Text' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Full Screen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'How to Use',
          click: () => mainWindow.webContents.send('menu-help'),
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ──────────────────────────────────────────────
// Settings helpers
// ──────────────────────────────────────────────

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

const DEFAULT_SETTINGS = {
  apiKey: '',
  useOnlineMode: false,
  fontSize: 'large',  // small | medium | large | xlarge
  appendMode: true,   // append new transcriptions vs replace
  autoSave: false,
  model: 'Xenova/whisper-tiny.en', // lightweight default for 8 GB machines
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
    // Never write the API key in plaintext; store it obfuscated (base64)
    // This is not encryption but keeps it out of plain sight in the file.
    const toWrite = { ...settings };
    if (toWrite.apiKey) {
      toWrite.apiKey = Buffer.from(toWrite.apiKey).toString('base64');
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

// ──────────────────────────────────────────────
// IPC handlers
// ──────────────────────────────────────────────

ipcMain.handle('get-user-data-path', () => app.getPath('userData'));

// Expose packaging info so the renderer can compute correct WASM paths
ipcMain.handle('get-app-info', () => ({
  isPackaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
}));

ipcMain.handle('get-settings', () => decodeSettings(loadSettings()));

ipcMain.handle('save-settings', (_event, settings) => saveSettingsToFile(settings));

ipcMain.handle('save-note', async (_event, { content, suggestedName }) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: suggestedName || `notes-${todayDateString()}.txt`,
    filters: [
      { name: 'Text Files', extensions: ['txt'] },
      { name: 'All Files', extensions: ['*'] },
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
      { name: 'All Files', extensions: ['*'] },
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

function todayDateString() {
  return new Date().toISOString().split('T')[0];
}

// ──────────────────────────────────────────────
// App lifecycle
// ──────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
