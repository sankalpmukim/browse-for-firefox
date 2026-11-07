// Tab recording without ffmpeg: Firefox's tabs.captureTab() renders a tab even when it is in the background,
// so frames are painted onto a canvas in this background page and encoded to WebM by MediaRecorder.

import { pin } from "./tabs.js";

const recordings = new Map(); // tabId -> recording

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function frame(tabId, scale) {
  const dataUrl = await browser.tabs.captureTab(tabId, { format: "jpeg", quality: 85, scale });
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

export function isRecording(tabId) {
  return recordings.has(tabId);
}

export async function startRecording({ tabId, fps = 8, maxSeconds = 600, scale = 1 }) {
  if (recordings.has(tabId)) throw new Error(`Tab ${tabId} is already being recorded`);
  fps = Math.min(30, Math.max(1, Number(fps) || 8));
  const first = await frame(tabId, scale);
  const canvas = document.createElement("canvas");
  // VP8/VP9 want even dimensions.
  canvas.width = first.width - (first.width % 2);
  canvas.height = first.height - (first.height % 2);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(first, 0, 0, canvas.width, canvas.height);
  const stream = canvas.captureStream(fps);
  const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5_000_000 });
  const rec = { tabId, fps, canvas, ctx, recorder, chunks: [], startedAt: Date.now(), frames: 1, running: true, errors: 0, mimeType };
  recorder.ondataavailable = (e) => e.data.size && rec.chunks.push(e.data);
  recorder.start(1000);
  recordings.set(tabId, rec);
  pin(tabId, "recording", true);

  (async () => {
    const interval = 1000 / fps;
    while (rec.running) {
      const t0 = performance.now();
      try {
        const bmp = await frame(tabId, scale);
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        bmp.close?.();
        rec.frames++;
      } catch {
        if (++rec.errors > 20) break;
      }
      if (Date.now() - rec.startedAt > maxSeconds * 1000) break;
      await sleep(Math.max(0, interval - (performance.now() - t0)));
    }
    if (rec.running) rec.autoStopped = true;
  })();
  return { recording: true, tabId, fps, size: `${canvas.width}x${canvas.height}`, mimeType };
}

export function recordingStatus(tabId) {
  const rec = recordings.get(tabId);
  if (!rec) return { recording: false, tabId };
  return { recording: true, tabId, seconds: Math.round((Date.now() - rec.startedAt) / 1000), frames: rec.frames, autoStopped: !!rec.autoStopped };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function stopRecording(tabId, { cancel = false } = {}) {
  const rec = recordings.get(tabId);
  if (!rec) throw new Error(`Tab ${tabId} isn't being recorded`);
  rec.running = false;
  recordings.delete(tabId);
  pin(tabId, "recording", false);
  const stopped = new Promise((r) => (rec.recorder.onstop = r));
  rec.recorder.stop();
  await stopped;
  rec.canvas.captureStream && rec.canvas.remove?.();
  const durationMs = Date.now() - rec.startedAt;
  if (cancel) return { cancelled: true, tabId, durationMs };
  const blob = new Blob(rec.chunks, { type: "video/webm" });
  return { tabId, durationMs, frames: rec.frames, bytes: blob.size, mimeType: "video/webm", base64: await blobToBase64(blob) };
}
