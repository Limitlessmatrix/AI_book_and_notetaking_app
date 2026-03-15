/**
 * renderer.js — Voice Notes
 *
 * All speech-to-text work is now done in the Electron MAIN process via
 * worker_threads (src/node-whisper-worker.js). The renderer communicates
 * through the contextBridge IPC surface defined in preload.js.
 *
 * Flow:
 *   1. init()  → window.api.startModelLoading(model, cacheDir)
 *   2. Main    → 'model-ready' event when loaded
 *   3. Record  → MediaRecorder → resample to 16 kHz Float32
 *   4. Stop    → window.api.transcribe(audioBuffer)  [blocks until done]
 *   5. Result  → append text to notes area
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
const modelRadios      = document.querySelectorAll('input[name="model-pick"]');
const modelSelect      = document.getElementById('model-select');

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
  statusBar.className     = `status-bar ${s.cls}`;
  statusIcon.textContent  = s.icon;
  statusText.textContent  = customText || s.text;
}

// ─── Error / confirm helpers ──────────────────────────────────────────────────

function showError(title, message) {
  errorTitle.textContent = title  || 'Something went wrong';
  errorMsg.textContent   = message|| 'An unexpected error occurred.';
  errorModal.classList.remove('hidden');
}

function showConfirm(title, message) {
  return new Promise((resolve) => {
    confirmTitle.textContent = title;
    confirmMsg.textContent   = message;
    confirmModal.classList.remove('hidden');
    const yes = () => { close(); resolve(true);  };
    const no  = () => { close(); resolve(false); };
    function close() {
      confirmModal.classList.add('hidden');
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
  wordCountEl.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  charCountEl.textContent = `${notesArea.value.length} character${notesArea.value.length !== 1 ? 's' : ''}`;
}
notesArea.addEventListener('input', updateWordCount);

// ─── Settings ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  try { settings = await window.api.getSettings(); }
  catch (e) { console.warn('Could not load settings:', e); }
  applySettings();
}

function applySettings() {
  document.body.className = `font-${settings.fontSize || 'large'}`;
  modeOffline.checked     = !settings.useOnlineMode;
  modeOnline.checked      =  !!settings.useOnlineMode;
  apiKeyInput.value       = settings.apiKey || '';
  toggleAppend.checked    = !!settings.appendMode;

  sizeBtns.forEach((b) => b.classList.toggle('active', b.dataset.size === (settings.fontSize || 'large')));

  const currentModel = settings.model || 'Xenova/whisper-tiny.en';
  if (modelSelect) modelSelect.value = currentModel;
  modelRadios.forEach((r) => { r.checked = r.value === currentModel; });
}

btnOpenSettings.addEventListener('click', () => { applySettings(); settingsPanel.classList.remove('hidden'); });
btnCloseSettings.addEventListener('click',  () => settingsPanel.classList.add('hidden'));
btnCancelSettings.addEventListener('click', () => settingsPanel.classList.add('hidden'));

btnToggleKey.addEventListener('click', () => {
  const isHidden       = apiKeyInput.type === 'password';
  apiKeyInput.type     = isHidden ? 'text' : 'password';
  btnToggleKey.textContent = isHidden ? '🙈' : '👁';
});

sizeBtns.forEach((btn) => btn.addEventListener('click', () => {
  sizeBtns.forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  document.body.className = `font-${btn.dataset.size}`;
}));

btnSaveSettings.addEventListener('click', async () => {
  const activeSize   = document.querySelector('.size-btn.active');
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
    showError('API Key Required',
      'You selected "Better Quality Mode" but didn\'t enter an API key.\n\n' +
      'Please enter your OpenAI API key, or switch back to Offline Mode.');
    return;
  }

  const modelChanged = chosenModel !== settings.model;
  await window.api.saveSettings(newSettings);
  settings = newSettings;
  applySettings();
  settingsPanel.classList.add('hidden');

  if (modelChanged) {
    setStatus('loading', 'Loading new voice recognition model…');
    appReady = false;
    btnRecord.disabled = true;
    const userDataPath = await window.api.getUserDataPath();
    window.api.reloadModel(chosenModel, userDataPath + '/models');
  } else {
    setStatus('ready');
  }
});

// ─── Model loading via IPC ────────────────────────────────────────────────────

function initModelListeners() {
  // Tracks whether every file reported 'done' — used to switch to ONNX-init phase
  let allFilesDownloaded = false;
  // Safety timeout: if model-ready doesn't fire within 5 min, show an error
  let modelReadyTimeout  = null;

  function clearModelTimeout() {
    if (modelReadyTimeout) { clearTimeout(modelReadyTimeout); modelReadyTimeout = null; }
  }

  function startModelTimeout() {
    clearModelTimeout();
    modelReadyTimeout = setTimeout(() => {
      setupProgressBar.classList.remove('indeterminate');
      setupOverlay.classList.add('hidden');
      setStatus('error', 'Voice recognition took too long to start. Please restart the app.');
      showError(
        'Loading Timed Out',
        'The voice recognition engine took too long to start.\n\n' +
        'Try closing other programs to free up memory, then restart Voice Notes.'
      );
    }, 5 * 60 * 1000); // 5 minutes
  }

  window.api.onModelProgress((progress) => {
    if (!progress) return;

    // @xenova/transformers v2 progress object:
    //   { status: 'initiate'|'progress'|'done'|'ready', progress: 0-100, file, ... }
    // Note: progress.progress is already 0–100, NOT 0–1.
    const status = progress.status || '';
    const pct    = typeof progress.progress === 'number'
      ? Math.min(100, Math.round(progress.progress))
      : 0;

    if (status === 'initiate') {
      // A new file is about to start — reset bar for this file
      allFilesDownloaded = false;
      setupProgressBar.classList.remove('indeterminate');
      setupOverlay.classList.remove('hidden');
      setStatus('setup', 'Downloading voice model for the first time…');
      setupProgressBar.style.width = '0%';
      setupProgressLbl.textContent = `Starting download of ${progress.file || 'model'}…`;

    } else if (status === 'progress') {
      // Active download — update bar and label
      setupOverlay.classList.remove('hidden');
      setStatus('setup', 'Downloading voice model for the first time…');
      setupProgressBar.style.width = `${pct}%`;
      setupProgressLbl.textContent = `Downloading voice recognition… ${pct}%`;

    } else if (status === 'done') {
      // A file finished — show 100% briefly, then switch to engine-init phase
      setupProgressBar.style.width = '100%';
      setupProgressLbl.textContent = 'File downloaded. Loading voice engine…';
      allFilesDownloaded = true;

      // After a short pause switch to the indeterminate "engine initialising" animation.
      // The ONNX runtime compiles the model in memory — this takes 30–90 s with no callbacks.
      setTimeout(() => {
        if (!appReady) {
          setupProgressBar.classList.add('indeterminate');
          setupProgressLbl.textContent =
            'Loading voice engine into memory… (this can take up to a minute)';
          startModelTimeout();
        }
      }, 600);

    } else if (status === 'ready') {
      // pipeline() fully resolved — model-ready IPC event will follow immediately
      clearModelTimeout();
      setupProgressBar.classList.remove('indeterminate');
      setupProgressBar.style.width = '100%';
      setupProgressLbl.textContent = 'Voice recognition ready!';
    }
  });

  window.api.onModelReady(() => {
    clearModelTimeout();
    setupProgressBar.classList.remove('indeterminate');
    setupOverlay.classList.add('hidden');
    appReady = true;
    btnRecord.disabled = false;
    setStatus('ready');
  });

  window.api.onModelError((msg) => {
    clearModelTimeout();
    setupProgressBar.classList.remove('indeterminate');
    setupOverlay.classList.add('hidden');
    setStatus('error', msg);
    showError('Voice Recognition Error', msg);
  });
}

async function startModelLoading() {
  const userDataPath = await window.api.getUserDataPath();
  const modelName    = settings.model || 'Xenova/whisper-tiny.en';
  window.api.startModelLoading(modelName, userDataPath + '/models');
}

// ─── Recording ────────────────────────────────────────────────────────────────

async function startRecording() {
  if (!appReady || isProcessing) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioChunks  = [];

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm';

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
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
    if (err.name === 'NotAllowedError') msg = 'Microphone access was denied. Please allow microphone access and try again.';
    if (err.name === 'NotFoundError')   msg = 'No microphone was found. Please connect a microphone and try again.';
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

function setRecordingUI(on) {
  btnRecord.classList.toggle('is-recording', on);
  soundWave.classList.toggle('hidden', !on);
  recordTimer.classList.toggle('hidden', !on);
  if (on) {
    btnRecord.classList.remove('is-processing');
    recordBtnIcon.textContent  = '⏹';
    recordBtnLabel.textContent = 'Click here to stop recording';
  }
}

function setProcessing(on) {
  isProcessing = on;
  btnRecord.classList.toggle('is-processing', on);
  btnRecord.disabled = on;
  if (on) {
    recordBtnIcon.textContent  = '⏳';
    recordBtnLabel.textContent = 'Converting your speech… please wait';
    setStatus('processing');
  } else {
    btnRecord.classList.remove('is-processing');
    recordBtnIcon.textContent  = '🎤';
    recordBtnLabel.textContent = 'Click here to start speaking';
    setStatus('ready');
  }
}

btnRecord.addEventListener('click', () => {
  if (!appReady) return;
  if (isRecording)       stopRecording();
  else if (!isProcessing) startRecording();
});

// ─── Timer ───────────────────────────────────────────────────────────────────

function startTimer() {
  timerSeconds = 0;
  updateTimerDisplay();
  timerInterval = setInterval(() => {
    timerSeconds++;
    updateTimerDisplay();
    if (timerSeconds >= 180) stopRecording(); // auto-stop at 3 min
  }, 1000);
}
function stopTimer() { clearInterval(timerInterval); timerInterval = null; }
function updateTimerDisplay() {
  const m = Math.floor(timerSeconds / 60);
  const s = timerSeconds % 60;
  timerDisplay.textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── Audio processing ─────────────────────────────────────────────────────────

async function processAudio() {
  if (audioChunks.length === 0) {
    setProcessing(false);
    showError('No Audio Recorded', 'Nothing was recorded. Please try again.');
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

    // Decode and resample to 16 kHz mono (required by Whisper)
    const audioCtx   = new AudioContext();
    const decoded    = await audioCtx.decodeAudioData(arrayBuffer);
    await audioCtx.close();

    const targetRate  = 16000;
    const offlineCtx  = new OfflineAudioContext(1, Math.round(decoded.duration * targetRate), targetRate);
    const src         = offlineCtx.createBufferSource();
    src.buffer        = decoded;
    src.connect(offlineCtx.destination);
    src.start(0);
    const resampled   = await offlineCtx.startRendering();
    const float32     = resampled.getChannelData(0);

    // Send as Buffer (Electron IPC serialises it cleanly)
    const result = await window.api.transcribe(float32.buffer);
    handleTranscriptionResult(result);
  } catch (err) {
    console.error('Offline transcription error:', err);
    showError('Transcription Failed', err.message || 'Could not process your audio.');
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

    handleTranscriptionResult((await response.json()).text);
  } catch (err) {
    console.error('Online transcription error:', err);
    setStatus('processing', 'Online failed — switching to offline mode…');
    await transcribeOffline();
  }
}

// ─── Handle result ────────────────────────────────────────────────────────────

function handleTranscriptionResult(text) {
  setProcessing(false);
  if (!text || !text.trim()) {
    setStatus('ready', 'No speech detected. Please try again and speak clearly into your microphone.');
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
    const ok = await showConfirm('Open a file?', 'Opening a file will replace your current notes. Continue?');
    if (!ok) return;
  }
  const r = await window.api.openFile();
  if (r.success) { notesArea.value = r.content; updateWordCount(); setStatus('ready', `📂 Opened: ${r.filePath}`); }
  else if (!r.canceled) showError('Could Not Open File', r.error || 'Unknown error');
}

btnSave.addEventListener('click', saveFile);
async function saveFile() {
  if (!notesArea.value.trim()) { showError('Nothing to Save', 'Your notes are empty.'); return; }
  const r = await window.api.saveNote(notesArea.value);
  if (r.success) { setStatus('saved', `💾 Saved to: ${r.filePath}`); setTimeout(() => setStatus('ready'), 4000); }
  else if (!r.canceled) showError('Could Not Save', r.error || 'Unknown error');
}

btnCopy.addEventListener('click', () => {
  if (!notesArea.value.trim()) return;
  navigator.clipboard.writeText(notesArea.value)
    .then(() => { setStatus('saved', '📋 Copied to clipboard!'); setTimeout(() => setStatus('ready'), 3000); })
    .catch(() => showError('Could Not Copy', 'Unable to copy to clipboard.'));
});

btnClear.addEventListener('click', async () => {
  if (!notesArea.value.trim()) return;
  if (await showConfirm('Clear all notes?', 'This cannot be undone.')) {
    notesArea.value = ''; updateWordCount(); setStatus('ready', 'Notes cleared.');
  }
});

// ─── Help & menus ─────────────────────────────────────────────────────────────

btnCloseHelp.addEventListener('click', () => helpModal.classList.add('hidden'));

window.api.onMenuNew(() => showConfirm('Start new notes?', 'This will clear your current notes.')
  .then((ok) => { if (ok) { notesArea.value = ''; updateWordCount(); } }));
window.api.onMenuOpen(() => openFile());
window.api.onMenuSave(() => saveFile());
window.api.onMenuHelp(() => helpModal.classList.remove('hidden'));

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener('keydown', (e) => {
  if (document.activeElement === btnRecord && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault(); btnRecord.click();
  }
  if (e.key === 'Escape') {
    [settingsPanel, helpModal, errorModal, confirmModal].forEach((el) => el.classList.add('hidden'));
  }
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

(async function init() {
  setStatus('loading');
  await loadSettings();
  initModelListeners();

  if (!settings._hasRun) {
    helpModal.classList.remove('hidden');
  }

  // Start loading the offline Whisper model (runs in main process worker_thread)
  await startModelLoading();

  updateWordCount();
})();
