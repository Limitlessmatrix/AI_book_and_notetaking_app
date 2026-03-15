/**
 * node-whisper-worker.mjs  ← MUST be .mjs (ES Module)
 *
 * The .mjs extension forces Node.js to treat this as a native ES Module.
 * This is critical because @xenova/transformers is an ESM-only package.
 * A .js file with require() would try to CJS-require the ESM package and
 * throw "Unexpected token 'export'" — the exact error we are fixing here.
 *
 * Runs inside a Node.js worker_thread spawned from main.js.
 *
 * Messages IN  (from main.js via parentPort):
 *   { type: 'load-model',  modelName, cacheDir }
 *   { type: 'transcribe',  audio: ArrayBuffer   }   ← transferred, not copied
 *
 * Messages OUT (to main.js via parentPort):
 *   { type: 'progress',    progress }
 *   { type: 'model-ready' }
 *   { type: 'transcribing' }
 *   { type: 'result',      text }
 *   { type: 'error',       error }
 */

import { parentPort } from 'worker_threads';
import { pipeline, env } from '@xenova/transformers';

let transcriber = null;
let isLoading   = false;

// ─── Model loading ────────────────────────────────────────────────────────────

async function loadModel(modelName, cacheDir) {
  if (transcriber) {
    parentPort.postMessage({ type: 'model-ready' });
    return;
  }
  if (isLoading) {
    // A load is already in progress — notify caller so it isn't left waiting silently
    parentPort.postMessage({ type: 'error', error: 'Model is already loading. Please wait.' });
    return;
  }
  isLoading = true;

  try {
    env.cacheDir          = cacheDir;
    env.allowRemoteModels = true;
    env.allowLocalModels  = true;

    // Single WASM thread keeps memory low on typical laptops
    env.backends.onnx.wasm.numThreads = 1;

    transcriber = await pipeline(
      'automatic-speech-recognition',
      modelName,
      {
        quantized: true,
        progress_callback: (progress) => {
          parentPort.postMessage({ type: 'progress', progress });
        },
      }
    );

    isLoading = false;
    parentPort.postMessage({ type: 'model-ready' });
  } catch (err) {
    isLoading = false;
    parentPort.postMessage({ type: 'error', error: friendlyError(err) });
  }
}

// ─── Transcription ────────────────────────────────────────────────────────────

async function transcribeAudio(audioBuffer) {
  if (!transcriber) {
    parentPort.postMessage({ type: 'error', error: 'Voice recognition is not ready yet.' });
    return;
  }

  parentPort.postMessage({ type: 'transcribing' });

  try {
    // audioBuffer arrives as ArrayBuffer (transferred from main.js)
    const float32 = audioBuffer instanceof Float32Array
      ? audioBuffer
      : new Float32Array(audioBuffer);

    const result = await transcriber(float32, {
      chunk_length_s:    30,
      stride_length_s:   5,
      language:          'english',
      task:              'transcribe',
      return_timestamps: false,
    });

    const text = Array.isArray(result)
      ? result.map((r) => r.text).join(' ')
      : (result.text || '');

    parentPort.postMessage({ type: 'result', text: text.trim() });
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: friendlyError(err) });
  }
}

// ─── Friendly error messages ──────────────────────────────────────────────────

function friendlyError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/network|fetch|internet|failed to fetch/i.test(msg)) {
    return 'Could not download the voice model. Check your internet connection and restart the app.';
  }
  if (/out of memory|memory/i.test(msg)) {
    return 'Not enough memory to run voice recognition. Close other programs and try again.';
  }
  if (/wasm|onnx/i.test(msg)) {
    return 'Voice recognition engine failed to start. Please restart the app.';
  }
  return msg;
}

// ─── Message router ───────────────────────────────────────────────────────────

parentPort.on('message', async (msg) => {
  switch (msg.type) {
    case 'load-model':
      await loadModel(msg.modelName, msg.cacheDir);
      break;
    case 'transcribe':
      // msg.audio is an ArrayBuffer (transferred — zero-copy)
      await transcribeAudio(msg.audio);
      break;
    default:
      console.warn('[whisper-worker] Unknown message type:', msg.type);
  }
});
