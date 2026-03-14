/**
 * node-whisper-worker.js
 *
 * Runs inside a Node.js worker_thread (spawned from main.js).
 * Uses dynamic import() so @xenova/transformers ES-module loads cleanly
 * in Node.js — this avoids the "Unexpected token 'export'" error that
 * occurs when trying to load it via browser importScripts().
 *
 * Messages IN  (from main.js via parentPort):
 *   { type: 'load-model',  modelName, cacheDir }
 *   { type: 'transcribe',  audio: Float32Array }
 *
 * Messages OUT (to main.js via parentPort):
 *   { type: 'progress',    progress }
 *   { type: 'model-ready' }
 *   { type: 'transcribing' }
 *   { type: 'result',      text }
 *   { type: 'error',       error }
 */

'use strict';

const { parentPort } = require('worker_threads');

let transcriber = null;
let isLoading   = false;

// ─── Model loading ────────────────────────────────────────────────────────────

async function loadModel(modelName, cacheDir) {
  if (transcriber) {
    parentPort.postMessage({ type: 'model-ready' });
    return;
  }
  if (isLoading) return;
  isLoading = true;

  try {
    // Dynamic import works in Node.js v18+ with ES modules
    const { pipeline, env } = await import('@xenova/transformers');

    env.cacheDir          = cacheDir;
    env.allowRemoteModels = true;
    env.allowLocalModels  = true;

    // Single-threaded WASM keeps RAM low on 8 GB machines
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

async function transcribeAudio(audioData) {
  if (!transcriber) {
    parentPort.postMessage({ type: 'error', error: 'Voice recognition is not ready yet.' });
    return;
  }

  parentPort.postMessage({ type: 'transcribing' });

  try {
    // audioData arrives as a plain object from structured clone — rebuild it
    const float32 = audioData instanceof Float32Array
      ? audioData
      : new Float32Array(Object.values(audioData));

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

parentPort.on('message', async (msg) => {
  switch (msg.type) {
    case 'load-model':
      await loadModel(msg.modelName, msg.cacheDir);
      break;
    case 'transcribe':
      await transcribeAudio(msg.audio);
      break;
    default:
      console.warn('[node-whisper-worker] Unknown message type:', msg.type);
  }
});
