const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Paths & settings
  getUserDataPath: () => ipcRenderer.invoke('get-user-data-path'),
  getSettings:    () => ipcRenderer.invoke('get-settings'),
  saveSettings:   (s) => ipcRenderer.invoke('save-settings', s),

  // File operations
  saveNote: (content, suggestedName) =>
    ipcRenderer.invoke('save-note', { content, suggestedName }),
  openFile: () => ipcRenderer.invoke('open-file'),

  // Main-process → renderer events (from native menu)
  onMenuNew:  (cb) => ipcRenderer.on('menu-new',  cb),
  onMenuOpen: (cb) => ipcRenderer.on('menu-open', cb),
  onMenuSave: (cb) => ipcRenderer.on('menu-save', cb),
  onMenuHelp: (cb) => ipcRenderer.on('menu-help', cb),
});
