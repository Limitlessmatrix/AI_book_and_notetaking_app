/**
 * renderer.js — Voice Notes
 *
 * Responsibilities:
 *  • UI state management (recording, processing, idle, error)
 *  • Microphone capture via MediaRecorder + Web Audio API resampling
 *  • Routes audio to:
 *      – Offline: Web Worker running @xenova/transformers Whisper
 *      – Online:  OpenAI /v1/audio/transcriptions API
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
};

let appReady      = false;  // model loaded
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
  errorTitle.textContent  = title || 'Something went wrong';
  errorMsg.textContent    = message || 'An unexpected error occurred.';
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
  const text = notesArea.value.trim();
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
  // Font size
  document.body.className = `font-${settings.fontSize || 'large'}`;

  // Mode radio
  if (settings.useOnlineMode) {
    modeOnline.checked  = true;
    modeOffline.checked = false;
  } else {
    modeOffline.checked = true;
    modeOnline.checked  = false;
  }

  // API key
  apiKeyInput.value = settings.apiKey || '';

  // Append toggle
  toggleAppend.checked = !!settings.appendMode;

  // Active size button
  sizeBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.size === (settings.fontSize || 'large'));
  });
}

btnOpenSettings.addEventListener('click', () => {
  applySettings();
  settingsPanel.classList.remove('hidden');
});
btnCloseSettings.addEventListener('click', () => settingsPanel.classList.add('hidden'));
btnCancelSettings.addEventListener('click', () => settingsPanel.classList.add('hidden'));

// Show/hide API key
btnToggleKey.addEventListener('click', () => {
  const isHidden = apiKeyInput.type === 'password';
  apiKeyInput.type      = isHidden ? 'text' : 'password';
  btnToggleKey.textContent = isHidden ? '🙈' : '👁';
});

// Text size buttons
sizeBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    sizeBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const size = btn.dataset.size;
    document.body.className = `font-${size}`;
  });
});

btnSaveSettings.addEventListener('click', async () => {
  const activeSize = document.querySelector('.size-btn.active');
  const newSettings = {
    apiKey:        apiKeyInput.value.trim(),
    useOnlineMode: modeOnline.checked,
    fontSize:      activeSize ? activeSize.dataset.size : 'large',
    appendMode:    toggleAppend.checked,
  };

  // Validate: if online mode but no API key, warn
  if (newSettings.useOnlineMode && !newSettings.apiKey) {
    showError(
      'API Key Required',
      'You selected "Better Quality Mode" but didn\'t enter an API key.\n\nPlease enter your OpenAI API key, or switch back to Offline Mode.'
    );
    return;
  }

  await window.api.saveSettings(newSettings);
  settings = newSettings;
  applySettings();
  settingsPanel.classList.add('hidden');
  setStatus('ready');
});

// ─── Whisper Worker setup ─────────────────────────────────────────────────────

async function initWhisperWorker() {
  return new Promise(async (resolve, reject) => {
    // Path to worker relative to src/index.html
    whisperWorker = new Worker('./whisper-worker.js');

    const userDataPath = await window.api.getUserDataPath();

    whisperWorker.onmessage = (event) => {
      const { type, progress, error, text } = event.data;

      switch (type) {
        case 'loading-progress': {
          // progress can be an object with { status, name, file, progress, loaded, total }
          // or a simple number
          let pct = 0;
          if (typeof progress === 'number') {
            pct = Math.round(progress * 100);
          } else if (progress && typeof progress.progress === 'number') {
            pct = Math.round(progress.progress * 100);
          }

          // Only show setup overlay for the initial download (not cache hits)
          if (progress && progress.status === 'download') {
            setupOverlay.classList.remove('hidden');
            setStatus('setup');
            setupProgressBar.style.width = `${pct}%`;
            setupProgressLbl.textContent = `Downloading voice recognition… ${pct}%`;
          } else if (progress && progress.status === 'initiate') {
            setupOverlay.classList.remove('hidden');
            setStatus('setup');
            setupProgressLbl.textContent = 'Preparing offline model…';
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

        case 'transcribing':
          // Worker started transcribing (after audio received)
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

    // Kick off model loading inside the worker
    whisperWorker.postMessage({
      type: 'load-model',
      data: {
        modelName: 'Xenova/whisper-base.en',
        cacheDir: userDataPath + '/models',
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

    // Use webm/opus for broad Chromium support
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      // Stop all tracks so the mic indicator goes away
      stream.getTracks().forEach((t) => t.stop());
      processAudio();
    };

    mediaRecorder.start(250); // collect in 250ms chunks
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
    // Auto-stop after 5 minutes to avoid huge files
    if (timerSeconds >= 300) {
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
    showError('No Audio Recorded', 'It seems nothing was recorded. Please try again and speak into your microphone.');
    return;
  }

  if (settings.useOnlineMode && settings.apiKey) {
    await transcribeOnline();
  } else {
    await transcribeOffline();
  }
}

/** Offline: resample to 16kHz Float32 and send to Whisper worker */
async function transcribeOffline() {
  try {
    const blob        = new Blob(audioChunks, { type: audioChunks[0].type || 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();

    // Decode to AudioBuffer (any sample rate)
    const audioCtx    = new AudioContext();
    const decoded     = await audioCtx.decodeAudioData(arrayBuffer);
    await audioCtx.close();

    // Resample to 16 000 Hz mono (required by Whisper)
    const targetRate    = 16000;
    const offlineCtx    = new OfflineAudioContext(1, Math.ceil(decoded.duration * targetRate), targetRate);
    const source        = offlineCtx.createBufferSource();
    source.buffer       = decoded;
    source.connect(offlineCtx.destination);
    source.start(0);
    const resampled     = await offlineCtx.startRendering();
    const float32Audio  = resampled.getChannelData(0);

    // Send to worker (transfer the buffer to avoid copying)
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

/** Online: send audio blob to OpenAI Whisper API */
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
    // Fall back to offline automatically
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
    // Append with a blank line separator
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
  const ok = await showConfirm('Clear all notes?', 'This will delete everything in the notes area. This cannot be undone.');
  if (ok) {
    notesArea.value = '';
    updateWordCount();
    setStatus('ready', 'Notes cleared.');
  }
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
  // Space or Enter on the record button when focused
  if (document.activeElement === btnRecord && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    btnRecord.click();
  }
  // Escape closes panels / modals
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

  // Show help on very first run (no notes, no settings file)
  const isFirstRun = !settings.apiKey && !settings._hasRun;
  if (isFirstRun) {
    helpModal.classList.remove('hidden');
    await window.api.saveSettings({ ...settings, _hasRun: true });
  }

  // Initialise offline Whisper worker (always — even in online mode, as fallback)
  try {
    await initWhisperWorker();
  } catch (err) {
    // If model fails to init, still allow online mode if key present
    if (settings.useOnlineMode && settings.apiKey) {
      appReady = true;
      btnRecord.disabled = false;
      setStatus('ready', '⚠️ Offline model unavailable — using online mode only.');
    } else {
      setStatus(
        'error',
        'Could not set up voice recognition. Make sure you have internet for the first-time download.'
      );
    }
  }

  updateWordCount();
})();
