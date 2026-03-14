/**
 * whisper-worker.js — Web Worker
 *
 * Runs @xenova/transformers Whisper entirely in a background thread so the
 * UI never freezes during model loading or transcription.
 *
 * Messages IN  (from renderer):
 *   { type: 'load-model', data: { modelName, cacheDir } }
 *   { type: 'transcribe',  data: { audio: Float32Array } }
 *
 * Messages OUT (to renderer):
 *   { type: 'loading-progress', progress }
 *   { type: 'model-ready' }
 *   { type: 'transcribing' }
 *   { type: 'result', text }
 *   { type: 'error',  error }
 */

'use strict';

// ─── Load @xenova/transformers UMD build via importScripts ────────────────────
// The path is relative to this worker file (src/whisper-worker.js),
// so ../node_modules/... resolves to the project root node_modules.
try {
  importScripts('../node_modules/@xenova/transformers/dist/transformers.min.js');
} catch (e) {
  self.postMessage({ type: 'error', error: 'Could not load voice recognition library. Please reinstall the app. (' + e.message + ')' });
  throw e;
}

// After importScripts, @xenova/transformers exposes `Transformers` globally.
const { pipeline, env } = self.Transformers;

// ─── State ───────────────────────────────────────────────────────────────────

let transcriber = null;
let isLoading   = false;

// ─── Model loading ────────────────────────────────────────────────────────────

async function loadModel(modelName, cacheDir) {
  if (transcriber) {
    self.postMessage({ type: 'model-ready' });
    return;
  }
  if (isLoading) return;

  isLoading = true;

  try {
    // Configure cache directory (persists model after first download)
    env.cacheDir        = cacheDir;
    env.allowRemoteModels = true;
    env.allowLocalModels  = true;

    // Disable multi-threading to avoid SharedArrayBuffer requirements in Electron
    env.backends.onnx.wasm.numThreads = 1;

    transcriber = await pipeline(
      'automatic-speech-recognition',
      modelName,
      {
        // Relay download progress back to the renderer
        progress_callback: (progress) => {
          self.postMessage({ type: 'loading-progress', progress });
        },
        // Use the quantised model for smaller download & faster inference
        quantized: true,
      }
    );

    isLoading = false;
    self.postMessage({ type: 'model-ready' });
  } catch (err) {
    isLoading = false;
    self.postMessage({
      type: 'error',
      error: buildFriendlyError(err),
    });
  }
}

// ─── Transcription ────────────────────────────────────────────────────────────

async function transcribeAudio(float32Audio) {
  if (!transcriber) {
    self.postMessage({ type: 'error', error: 'Voice recognition is not ready yet. Please wait a moment.' });
    return;
  }

  self.postMessage({ type: 'transcribing' });

  try {
    const result = await transcriber(float32Audio, {
      // Handle recordings longer than ~30 s with sliding-window chunking
      chunk_length_s: 30,
      stride_length_s: 5,
      language: 'english',
      task: 'transcribe',
      // Return timestamps (useful for future features) but just use text for now
      return_timestamps: false,
    });

    const text = Array.isArray(result)
      ? result.map((r) => r.text).join(' ')
      : result.text || '';

    self.postMessage({ type: 'result', text: text.trim() });
  } catch (err) {
    self.postMessage({
      type: 'error',
      error: buildFriendlyError(err),
    });
  }
}

// ─── Error helper ─────────────────────────────────────────────────────────────

function buildFriendlyError(err) {
  const msg = (err && err.message) ? err.message : String(err);

  if (/network|fetch|internet|failed to fetch/i.test(msg)) {
    return 'Could not download the voice model. Please check your internet connection and restart the app.';
  }
  if (/out of memory|memory/i.test(msg)) {
    return 'Not enough memory to run voice recognition. Try closing other programs.';
  }
  if (/wasm|onnx/i.test(msg)) {
    return 'Voice recognition engine failed to start. Please restart the app.';
  }
  return msg;
}

// ─── Message router ───────────────────────────────────────────────────────────

self.onmessage = async (event) => {
  const { type, data } = event.data;

  switch (type) {
    case 'load-model':
      await loadModel(data.modelName, data.cacheDir);
      break;

    case 'transcribe':
      await transcribeAudio(data.audio);
      break;

    default:
      console.warn('[whisper-worker] Unknown message type:', type);
  }
};
