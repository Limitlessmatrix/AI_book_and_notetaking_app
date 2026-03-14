/**
 * renderer.js — Voice Notes
 *
 * Responsibilities:
 *  • UI state management (recording, processing, idle, error)
 *  • Microphone capture via MediaRecorder + Web Audio API resampling
 *  • Routes audio to:
 *      – Offline: Web Worker running @xenova/transformers Whisper
 *      – Online:  OpenAI /v1/audio/transcriptions API (fallback)
 *  • Settings load/save
 *  • File open / save
 *  • Word/char count
 */

'use strict';

// ─── DOM refs ────────────────────────────────────────────────────────────────

const statusBar        = document.getElementById('status-bar');
const statusIcon       = document.getElementById('status-icon');
const statusText       = document.getElementById('status-text');

const setupOverlay     = document.getElementById('setup-overlay');
const setupProgressBar = document.getElementById('setup-progress-bar');
const setupProgressLbl = document.getElementById('setup-progress-label');

const settingsPanel    = document.getElementById('settings-panel');
const btnOpenSettings  = document.getElementById('btn-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnCancelSettings= document.getElementById('btn-cancel-settings');
const btnSaveSettings  = document.getElementById('btn-save-settings');
const modeOffline      = document.getElementById('mode-offline');
const modeOnline       = document.getElementById('mode-online');
const apiKeyInput      = document.getElementById('api-key-input');
const btnToggleKey     = document.getElementById('btn-toggle-key');
const sizeBtns         = document.querySelectorAll('.size-btn');
const toggleAppend     = document.getElementById('toggle-append');
const modelSelect      = document.getElementById('model-select');
const modelRadios      = document.querySelectorAll('input[name="model-pick"]');

const btnOpen          = document.getElementById('btn-open');
const btnRecord        = document.getElementById('btn-record');
const recordBtnIcon    = document.getElementById('record-btn-icon');
const recordBtnLabel   = document.getElementById('record-btn-label');
const recordTimer      = document.getElementById('record-timer');
const timerDisplay     = document.getElementById('timer-display');
const soundWave        = document.getElementById('sound-wave');

const btnCopy          = document.getElementById('btn-copy');
const btnClear         = document.getElementById('btn-clear');
const btnSave          = document.getElementById('btn-save');
const notesArea        = document.getElementById('notes-area');
const wordCountEl      = document.getElementById('word-count');
const charCountEl      = document.getElementById('char-count');

const helpModal        = document.getElementById('help-modal');
const btnCloseHelp     = document.getElementById('btn-close-help');

const errorModal       = document.getElementById('error-modal');
const errorTitle       = document.getElementById('error-title');
const errorMsg         = document.getElementById('error-message');
const btnCloseError    = document.getElementById('btn-close-error');

const confirmModal     = document.getElementById('confirm-modal');
const confirmTitle     = document.getElementById('confirm-title');
const confirmMsg       = document.getElementById('confirm-message');
const btnConfirmYes    = document.getElementById('btn-confirm-yes');
const btnConfirmNo     = document.getElementById('btn-confirm-no');

// ─── App state ────────────────────────────────────────────────────────────────

let settings = {
  apiKey: '',
  useOnlineMode: false,
  fontSize: 'large',
  appendMode: true,
  model: 'Xenova/whisper-tiny.en',
};

let appReady      = false;
let isRecording   = false;
let isProcessing  = false;
let mediaRecorder = null;
let audioChunks   = [];
let timerInterval = null;
let timerSeconds  = 0;
let whisperWorker = null;

// ─── Status helpers ───────────────────────────────────────────────────────────

const STATUS = {
  loading:    { cls: 'status-loading',    icon: '⏳', text: 'Starting up voice recognition… please wait.' },
  setup:      { cls: 'status-loading',    icon: '⬇️',  text: 'Downloading offline model for the first time… please wait.' },
  ready:      { cls: 'status-ready',      icon: '✅', text: 'Ready! Click the button to start speaking.' },
  recording:  { cls: 'status-recording',  icon: '🔴', text: 'Recording… speak clearly. Click the button again to stop.' },
  processing: { cls: 'status-processing', icon: '✨', text: 'Converting your speech to text… almost done!' },
  error:      { cls: 'status-error',      icon: '⚠️', text: '' },
  saved:      { cls: 'status-saved',      icon: '💾', text: 'Notes saved!' },
};

function setStatus(key, customText) {
  const s = STATUS[key] || STATUS.ready;
  statusBar.className = `status-bar ${s.cls}`;
  statusIcon.textContent = s.icon;
  statusText.textContent = customText || s.text;
}

// ─── Error / confirm helpers ──────────────────────────────────────────────────

function showError(title, message) {
  errorTitle.textContent = title || 'Something went wrong';
  errorMsg.textContent   = message || 'An unexpected error occurred.';
  errorModal.classList.remove('hidden');
}

function showConfirm(title, message) {
  return new Promise((resolve) => {
    confirmTitle.textContent = title;
    confirmMsg.textContent   = message;
    confirmModal.classList.remove('hidden');

    const yes = () => { confirmModal.classList.add('hidden'); cleanup(); resolve(true);  };
    const no  = () => { confirmModal.classList.add('hidden'); cleanup(); resolve(false); };
    function cleanup() {
      btnConfirmYes.removeEventListener('click', yes);
      btnConfirmNo .removeEventListener('click', no);
    }
    btnConfirmYes.addEventListener('click', yes);
    btnConfirmNo .addEventListener('click', no);
  });
}

btnCloseError.addEventListener('click', () => errorModal.classList.add('hidden'));
btnConfirmNo .addEventListener('click', () => confirmModal.classList.add('hidden'));

// ─── Word / char count ────────────────────────────────────────────────────────

function updateWordCount() {
  const text  = notesArea.value.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const chars = notesArea.value.length;
  wordCountEl.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  charCountEl.textContent = `${chars} character${chars !== 1 ? 's' : ''}`;
}
notesArea.addEventListener('input', updateWordCount);

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  try {
    settings = await window.api.getSettings();
  } catch (e) {
    console.warn('Could not load settings, using defaults.', e);
  }
  applySettings();
}

function applySettings() {
  document.body.className = `font-${settings.fontSize || 'large'}`;

  if (settings.useOnlineMode) {
    modeOnline.checked  = true;
    modeOffline.checked = false;
  } else {
    modeOffline.checked = true;
    modeOnline.checked  = false;
  }

  apiKeyInput.value = settings.apiKey || '';
  toggleAppend.checked = !!settings.appendMode;

  sizeBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.size === (settings.fontSize || 'large'));
  });

  const currentModel = settings.model || 'Xenova/whisper-tiny.en';
  if (modelSelect) modelSelect.value = currentModel;
  // Sync radio buttons
  modelRadios.forEach((r) => { r.checked = (r.value === currentModel); });
}

btnOpenSettings.addEventListener('click', () => {
  applySettings();
  settingsPanel.classList.remove('hidden');
});
btnCloseSettings.addEventListener('click', () => settingsPanel.classList.add('hidden'));
btnCancelSettings.addEventListener('click', () => settingsPanel.classList.add('hidden'));

btnToggleKey.addEventListener('click', () => {
  const isHidden       = apiKeyInput.type === 'password';
  apiKeyInput.type     = isHidden ? 'text' : 'password';
  btnToggleKey.textContent = isHidden ? '🙈' : '👁';
});

sizeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    sizeBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.body.className = `font-${btn.dataset.size}`;
  });
});

btnSaveSettings.addEventListener('click', async () => {
  const activeSize  = document.querySelector('.size-btn.active');
  // Read selected radio (falls back to hidden select)
  const checkedRadio = document.querySelector('input[name="model-pick"]:checked');
  const chosenModel  = checkedRadio ? checkedRadio.value
                     : (modelSelect ? modelSelect.value : 'Xenova/whisper-tiny.en');

  const newSettings = {
    apiKey:        apiKeyInput.value.trim(),
    useOnlineMode: modeOnline.checked,
    fontSize:      activeSize ? activeSize.dataset.size : 'large',
    appendMode:    toggleAppend.checked,
    model:         chosenModel,
    _hasRun:       true,
  };

  if (newSettings.useOnlineMode && !newSettings.apiKey) {
    showError(
      'API Key Required',
      'You selected "Better Quality Mode" but didn\'t enter an API key.\n\n' +
      'Please enter your OpenAI API key, or switch back to Offline Mode.'
    );
    return;
  }

  // If the model changed, the worker must be reloaded on next use
  const modelChanged = chosenModel !== settings.model;
  await window.api.saveSettings(newSettings);
  settings = newSettings;
  applySettings();
  settingsPanel.classList.add('hidden');

  if (modelChanged) {
    // Restart the worker with the new model
    setStatus('loading', 'Loading new voice recognition model…');
    appReady = false;
    btnRecord.disabled = true;
    if (whisperWorker) { whisperWorker.terminate(); whisperWorker = null; }
    initWhisperWorker().catch(() => {});
  } else {
    setStatus('ready');
  }
});

// ─── Compute worker paths (dev vs packaged) ───────────────────────────────────
// In a packaged Electron app the @xenova files are extracted alongside the asar
// at  resources/app.asar.unpacked/node_modules/@xenova/…
// In dev they sit at  node_modules/@xenova/… relative to the project root,
// which is two levels up from the worker file (src/whisper-worker.js).

async function computeWorkerPaths() {
  const { isPackaged, resourcesPath } = await window.api.getAppInfo();

  let transformersPath;
  let wasmPath;

  if (isPackaged) {
    // Windows paths use backslashes — convert to forward-slashes for file:// URLs
    const base = resourcesPath.replace(/\\/g, '/');
    const unpacked = `${base}/app.asar.unpacked/node_modules/@xenova/transformers/dist`;
    transformersPath = `file:///${unpacked}/transformers.min.js`;
    wasmPath         = `file:///${unpacked}/`;
  } else {
    // Dev mode: relative to the worker file (src/whisper-worker.js)
    transformersPath = '../node_modules/@xenova/transformers/dist/transformers.min.js';
    wasmPath         = '../node_modules/@xenova/transformers/dist/';
  }

  return { transformersPath, wasmPath };
}

// ─── Whisper Worker setup ─────────────────────────────────────────────────────

async function initWhisperWorker() {
  return new Promise(async (resolve, reject) => {
    whisperWorker = new Worker('./whisper-worker.js');

    const [userDataPath, { transformersPath, wasmPath }] = await Promise.all([
      window.api.getUserDataPath(),
      computeWorkerPaths(),
    ]);

    const modelName = settings.model || 'Xenova/whisper-tiny.en';

    whisperWorker.onmessage = (event) => {
      const { type, progress, error, text } = event.data;

      switch (type) {
        case 'loading-progress': {
          let pct = 0;
          if (typeof progress === 'number') {
            pct = Math.round(progress * 100);
          } else if (progress && typeof progress.progress === 'number') {
            pct = Math.round(progress.progress * 100);
          }

          if (progress && (progress.status === 'download' || progress.status === 'initiate')) {
            setupOverlay.classList.remove('hidden');
            setStatus('setup');
            if (progress.status === 'download') {
              setupProgressBar.style.width   = `${pct}%`;
              setupProgressLbl.textContent   = `Downloading voice recognition… ${pct}%`;
            } else {
              setupProgressLbl.textContent = 'Preparing offline model…';
            }
          } else if (progress && progress.status === 'done') {
            setupProgressBar.style.width = '100%';
          }
          break;
        }

        case 'model-ready':
          setupOverlay.classList.add('hidden');
          appReady = true;
          btnRecord.disabled = false;
          setStatus('ready');
          resolve();
          break;

        case 'result':
          handleTranscriptionResult(text);
          break;

        case 'error':
          setupOverlay.classList.add('hidden');
          setStatus('error', `Error: ${error}`);
          showError('Voice Recognition Error', error);
          setProcessing(false);
          reject(new Error(error));
          break;
      }
    };

    whisperWorker.onerror = (err) => {
      setupOverlay.classList.add('hidden');
      const msg = err.message || 'Worker failed to start';
      setStatus('error', msg);
      showError('Setup Failed', msg);
      reject(err);
    };

    // Send paths + model name to the worker
    whisperWorker.postMessage({
      type: 'load-model',
      data: {
        modelName,
        cacheDir:        userDataPath + '/models',
        transformersPath,
        wasmPath,
      },
    });
  });
}

// ─── Recording ────────────────────────────────────────────────────────────────

async function startRecording() {
  if (!appReady || isProcessing) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioChunks  = [];

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      processAudio();
    };

    mediaRecorder.start(250);
    isRecording = true;
    setRecordingUI(true);
    setStatus('recording');
    startTimer();
  } catch (err) {
    let msg = 'Could not access your microphone.';
    if (err.name === 'NotAllowedError') {
      msg = 'Microphone access was denied. Please allow microphone access and try again.';
    } else if (err.name === 'NotFoundError') {
      msg = 'No microphone was found. Please connect a microphone and try again.';
    }
    showError('Microphone Problem', msg);
    setStatus('error', msg);
  }
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  mediaRecorder.stop();
  isRecording = false;
  stopTimer();
  setRecordingUI(false);
  setProcessing(true);
}

function setRecordingUI(recording) {
  if (recording) {
    btnRecord.classList.add('is-recording');
    btnRecord.classList.remove('is-processing');
    recordBtnIcon.textContent  = '⏹';
    recordBtnLabel.textContent = 'Click here to stop recording';
    soundWave.classList.remove('hidden');
    recordTimer.classList.remove('hidden');
  } else {
    btnRecord.classList.remove('is-recording');
    soundWave.classList.add('hidden');
    recordTimer.classList.add('hidden');
  }
}

function setProcessing(on) {
  isProcessing = on;
  if (on) {
    btnRecord.classList.add('is-processing');
    btnRecord.disabled         = true;
    recordBtnIcon.textContent  = '⏳';
    recordBtnLabel.textContent = 'Converting your speech… please wait';
    setStatus('processing');
  } else {
    btnRecord.classList.remove('is-processing');
    btnRecord.disabled         = false;
    recordBtnIcon.textContent  = '🎤';
    recordBtnLabel.textContent = 'Click here to start speaking';
    setStatus('ready');
  }
}

btnRecord.addEventListener('click', () => {
  if (!appReady) return;
  if (isRecording) {
    stopRecording();
  } else if (!isProcessing) {
    startRecording();
  }
});

// ─── Timer ───────────────────────────────────────────────────────────────────

function startTimer() {
  timerSeconds = 0;
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    timerSeconds++;
    updateTimerDisplay();
    // Auto-stop after 3 minutes to keep memory usage low on 8 GB machines
    if (timerSeconds >= 180) {
      stopRecording();
    }
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function updateTimerDisplay() {
  const m = Math.floor(timerSeconds / 60);
  const s = timerSeconds % 60;
  timerDisplay.textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Audio processing ─────────────────────────────────────────────────────────

async function processAudio() {
  if (audioChunks.length === 0) {
    setProcessing(false);
    showError('No Audio Recorded', 'Nothing was recorded. Please try again and speak into your microphone.');
    return;
  }

  if (settings.useOnlineMode && settings.apiKey) {
    await transcribeOnline();
  } else {
    await transcribeOffline();
  }
}

async function transcribeOffline() {
  try {
    const blob        = new Blob(audioChunks, { type: audioChunks[0].type || 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();

    const audioCtx = new AudioContext();
    const decoded  = await audioCtx.decodeAudioData(arrayBuffer);
    await audioCtx.close();

    // Resample to 16 kHz mono — required by Whisper
    const targetRate   = 16000;
    const offlineCtx   = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
    const source       = offlineCtx.createBufferSource();
    source.buffer      = decoded;
    source.connect(offlineCtx.destination);
    source.start(0);
    const resampled    = await offlineCtx.startRendering();
    const float32Audio = resampled.getChannelData(0);

    // Transfer the buffer (zero-copy) to the worker
    whisperWorker.postMessage(
      { type: 'transcribe', data: { audio: float32Audio } },
      [float32Audio.buffer]
    );
  } catch (err) {
    console.error('Offline transcription error:', err);
    showError('Transcription Failed', `Could not process your audio: ${err.message}`);
    setProcessing(false);
  }
}

async function transcribeOnline() {
  try {
    const blob     = new Blob(audioChunks, { type: 'audio/webm' });
    const formData = new FormData();
    formData.append('file', blob, 'recording.webm');
    formData.append('model', 'whisper-1');
    formData.append('language', 'en');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${settings.apiKey}` },
      body: formData,
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `Server error ${response.status}`);
    }

    const result = await response.json();
    handleTranscriptionResult(result.text);
  } catch (err) {
    console.error('Online transcription error:', err);
    setStatus('processing', 'Online failed — switching to offline mode…');
    await transcribeOffline();
  }
}

// ─── Handle transcription result ─────────────────────────────────────────────

function handleTranscriptionResult(text) {
  setProcessing(false);

  if (!text || text.trim() === '') {
    setStatus('ready', 'No speech detected. Please try again and speak clearly.');
    return;
  }

  const cleaned = text.trim();

  if (settings.appendMode && notesArea.value.trim()) {
    notesArea.value += '\n\n' + cleaned;
  } else {
    notesArea.value = cleaned;
  }

  notesArea.scrollTop = notesArea.scrollHeight;
  updateWordCount();
  setStatus('ready', '✅ Speech converted! You can keep talking or edit the text below.');
}

// ─── File operations ──────────────────────────────────────────────────────────

btnOpen.addEventListener('click', openFile);
async function openFile() {
  if (notesArea.value.trim()) {
    const ok = await showConfirm(
      'Open a file?',
      'Opening a file will replace your current notes. Do you want to continue?'
    );
    if (!ok) return;
  }
  const result = await window.api.openFile();
  if (result.success) {
    notesArea.value = result.content;
    updateWordCount();
    setStatus('ready', `📂 Opened: ${result.filePath}`);
  } else if (!result.canceled) {
    showError('Could Not Open File', result.error || 'Unknown error');
  }
}

btnSave.addEventListener('click', saveFile);
async function saveFile() {
  const content = notesArea.value;
  if (!content.trim()) {
    showError('Nothing to Save', 'Your notes are empty. Please type or speak something first.');
    return;
  }
  const result = await window.api.saveNote(content);
  if (result.success) {
    setStatus('saved', `💾 Saved to: ${result.filePath}`);
    setTimeout(() => setStatus('ready'), 4000);
  } else if (!result.canceled) {
    showError('Could Not Save', result.error || 'Unknown error');
  }
}

btnCopy.addEventListener('click', () => {
  if (!notesArea.value.trim()) return;
  navigator.clipboard.writeText(notesArea.value)
    .then(() => {
      setStatus('saved', '📋 Copied to clipboard!');
      setTimeout(() => setStatus('ready'), 3000);
    })
    .catch(() => showError('Could Not Copy', 'Unable to copy to clipboard.'));
});

btnClear.addEventListener('click', async () => {
  if (!notesArea.value.trim()) return;
  const ok = await showConfirm(
    'Clear all notes?',
    'This will delete everything in the notes area. This cannot be undone.'
  );
  if (ok) { notesArea.value = ''; updateWordCount(); setStatus('ready', 'Notes cleared.'); }
});

// ─── Help modal ───────────────────────────────────────────────────────────────

btnCloseHelp.addEventListener('click', () => helpModal.classList.add('hidden'));

// ─── Native menu events ───────────────────────────────────────────────────────

window.api.onMenuNew(() => {
  showConfirm('Start new notes?', 'This will clear your current notes.').then((ok) => {
    if (ok) { notesArea.value = ''; updateWordCount(); }
  });
});
window.api.onMenuOpen(() => openFile());
window.api.onMenuSave(() => saveFile());
window.api.onMenuHelp(() => helpModal.classList.remove('hidden'));

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (document.activeElement === btnRecord && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    btnRecord.click();
  }
  if (e.key === 'Escape') {
    settingsPanel.classList.add('hidden');
    helpModal.classList.add('hidden');
    errorModal.classList.add('hidden');
    confirmModal.classList.add('hidden');
  }
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

(async function init() {
  setStatus('loading');
  await loadSettings();

  // Show help on very first run
  if (!settings._hasRun) {
    helpModal.classList.remove('hidden');
  }

  // Initialise Whisper worker (offline, always — used as fallback even in online mode)
  try {
    await initWhisperWorker();
  } catch (err) {
    if (settings.useOnlineMode && settings.apiKey) {
      appReady = true;
      btnRecord.disabled = false;
      setStatus('ready', '⚠️ Offline model unavailable — using online mode only.');
    } else {
      setStatus(
        'error',
        'Could not set up voice recognition. Connect to the internet for the first-time setup, then it works offline forever.'
      );
    }
  }

  updateWordCount();
})();
