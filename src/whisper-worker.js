/**
 * whisper-worker.js — Web Worker
 *
 * Runs @xenova/transformers Whisper entirely in a background thread so the
 * UI never freezes during model loading or transcription.
 *
 * WHY dynamic importScripts?
 *   When the app is packaged with electron-builder (asar), relative paths
 *   in importScripts() resolve inside the asar archive where WASM files
 *   cannot be directly fetched by onnxruntime-web.  The renderer computes
 *   the correct absolute file:// URL for both dev and packaged modes and
 *   passes it here on the first 'load-model' message.
 *
 * Messages IN  (from renderer):
 *   { type: 'load-model', data: { modelName, cacheDir,
 *                                 transformersPath, wasmPath } }
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

let isInitialized = false;
let pipeline_fn   = null;
let env_obj       = null;
let transcriber   = null;
let isLoading     = false;

// ─── Initialise transformers.js ───────────────────────────────────────────────
// Called once, with the exact path supplied by the renderer.

function initTransformers(transformersPath, wasmPath) {
  if (isInitialized) return;

  try {
    importScripts(transformersPath);
  } catch (e) {
    self.postMessage({
      type: 'error',
      error: 'Could not load voice recognition library. ' +
             'Please reinstall the app. (' + e.message + ')',
    });
    throw e;
  }

  // After importScripts the UMD bundle exposes window.Transformers / self.Transformers
  pipeline_fn = self.Transformers.pipeline;
  env_obj     = self.Transformers.env;

  // ── WASM path (critical for packaged Electron apps) ──
  // Tell onnxruntime-web exactly where to find the .wasm files so it does
  // not try to derive the location from the script URL (which would point
  // inside the asar and fail).
  if (wasmPath) {
    env_obj.backends.onnx.wasm.wasmPaths = wasmPath;
  }

  // Single-threaded WASM — avoids SharedArrayBuffer requirement and keeps
  // memory usage low on 8 GB machines.
  env_obj.backends.onnx.wasm.numThreads = 1;

  isInitialized = true;
}

// ─── Model loading ────────────────────────────────────────────────────────────

async function loadModel(modelName, cacheDir) {
  if (transcriber) {
    self.postMessage({ type: 'model-ready' });
    return;
  }
  if (isLoading) return;

  isLoading = true;

  try {
    env_obj.cacheDir          = cacheDir;
    env_obj.allowRemoteModels = true;
    env_obj.allowLocalModels  = true;

    transcriber = await pipeline_fn(
      'automatic-speech-recognition',
      modelName,
      {
        progress_callback: (progress) => {
          self.postMessage({ type: 'loading-progress', progress });
        },
        quantized: true, // smaller download & lower RAM
      }
    );

    isLoading = false;
    self.postMessage({ type: 'model-ready' });
  } catch (err) {
    isLoading = false;
    self.postMessage({ type: 'error', error: buildFriendlyError(err) });
  }
}

// ─── Transcription ────────────────────────────────────────────────────────────

async function transcribeAudio(float32Audio) {
  if (!transcriber) {
    self.postMessage({
      type: 'error',
      error: 'Voice recognition is not ready yet. Please wait a moment.',
    });
    return;
  }

  self.postMessage({ type: 'transcribing' });

  try {
    const result = await transcriber(float32Audio, {
      chunk_length_s:    30,
      stride_length_s:   5,
      language:          'english',
      task:              'transcribe',
      return_timestamps: false,
    });

    const text = Array.isArray(result)
      ? result.map((r) => r.text).join(' ')
      : (result.text || '');

    self.postMessage({ type: 'result', text: text.trim() });
  } catch (err) {
    self.postMessage({ type: 'error', error: buildFriendlyError(err) });
  }
}

// ─── Error helper ─────────────────────────────────────────────────────────────

function buildFriendlyError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/network|fetch|internet|failed to fetch/i.test(msg)) {
    return 'Could not download the voice model. Please check your internet connection and restart the app.';
  }
  if (/out of memory|memory/i.test(msg)) {
    return 'Not enough memory. Try closing other programs, then restart Voice Notes.';
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
      // Initialise the library on first call (dynamic path from renderer)
      initTransformers(data.transformersPath, data.wasmPath);
      await loadModel(data.modelName, data.cacheDir);
      break;

    case 'transcribe':
      await transcribeAudio(data.audio);
      break;

    default:
      console.warn('[whisper-worker] Unknown message type:', type);
  }
};
