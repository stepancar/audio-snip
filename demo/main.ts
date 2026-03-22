import { audioSnip } from '../src/core.js';
import { Mp3Plugin } from '../src/plugins/mp3.js';
import { Mp4Plugin } from '../src/plugins/mp4.js';
interface RangeLogEntry {
  type: 'range-request';
  url: string;
  requestedRange: string | null;
  status: number;
  responseBytes: number;
  totalBytes: number | null;
  rangeSupported: boolean;
  timestamp: number;
}

audioSnip.register(new Mp3Plugin({ paddingFrames: 8 }));
audioSnip.register(new Mp4Plugin());

// ─── DOM refs ────────────────────────────────────────────────────────────────

const urlInput = document.getElementById('url') as HTMLInputElement;
const startSlider = document.getElementById('start') as HTMLInputElement;
const endSlider = document.getElementById('end') as HTMLInputElement;
const startVal = document.getElementById('startVal')!;
const endVal = document.getElementById('endVal')!;
const loadBtn = document.getElementById('load') as HTMLButtonElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const stopBtn = document.getElementById('stop') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;
const canvas = document.getElementById('waveform') as HTMLCanvasElement;

const networkLog = document.getElementById('network-log')!;
const networkSummary = document.getElementById('network-summary')!;
const swStatus = document.getElementById('sw-status')!;
const transferBar = document.getElementById('transfer-bar')!;
const transferFill = document.getElementById('transfer-fill')!;
const transferLabel = document.getElementById('transfer-label')!;

// ─── State ───────────────────────────────────────────────────────────────────

let audioBuffer: AudioBuffer | null = null;
let audioCtx: AudioContext | null = null;
let sourceNode: AudioBufferSourceNode | null = null;

let totalBytesTransferred = 0;
let fileTotalSize: number | null = null;
let requestCount = 0;

// ─── Service Worker registration ─────────────────────────────────────────────

async function registerSW(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    swStatus.textContent = 'Service Worker not supported in this browser.';
    return;
  }
  try {
    // In dev, Vite serves sw.js from demo/; in prod, it's in the build output
    const base = import.meta.env.BASE_URL || '/';
    const reg = await navigator.serviceWorker.register(
      base + 'sw.js',
      { scope: base },
    );
    swStatus.textContent = reg.active
      ? 'Service Worker active'
      : 'Service Worker installing...';

    // Wait for the SW to become active
    if (!reg.active) {
      await new Promise<void>((resolve) => {
        const sw = reg.installing || reg.waiting;
        if (!sw) return resolve();
        sw.addEventListener('statechange', () => {
          if (sw.state === 'activated') {
            swStatus.textContent = 'Service Worker active';
            resolve();
          }
        });
      });
    }
  } catch (err) {
    swStatus.textContent = `SW registration failed: ${err}`;
    console.error('SW registration error:', err);
  }
}

// ─── Listen for SW messages ──────────────────────────────────────────────────

navigator.serviceWorker?.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg.type === 'range-request') {
    addLogEntry(msg as RangeLogEntry);
  } else if (msg.type === 'sw-ready') {
    swStatus.textContent = 'Service Worker active';
  }
});

function addLogEntry(entry: RangeLogEntry): void {
  requestCount++;

  // Parse range for display
  const rangeMatch = entry.requestedRange?.match(/bytes=(\d+)-(\d+)/);
  const rangeDisplay = rangeMatch
    ? `${fmtBytes(+rangeMatch[1])}–${fmtBytes(+rangeMatch[2])}`
    : entry.requestedRange || '—';

  const row = document.createElement('div');
  row.className = 'net-row';
  row.innerHTML = `
    <span title="${entry.url}">${entry.url}</span>
    <span>${rangeDisplay}</span>
    <span>${fmtBytes(entry.responseBytes)}</span>
    <span>${entry.totalBytes != null ? fmtBytes(entry.totalBytes) : '?'}</span>
    <span><span class="badge ${entry.rangeSupported ? 'badge-206' : 'badge-200'}">${entry.rangeSupported ? '206' : '200→slice'}</span></span>
  `;
  networkLog.appendChild(row);
  networkLog.scrollTop = networkLog.scrollHeight;

  // Update totals
  totalBytesTransferred += entry.responseBytes;
  if (entry.totalBytes != null && (fileTotalSize === null || entry.totalBytes > fileTotalSize)) {
    fileTotalSize = entry.totalBytes;
  }

  updateTransferBar();
  networkSummary.textContent = `${requestCount} requests, ${fmtBytes(totalBytesTransferred)} transferred`;
}

function updateTransferBar(): void {
  transferBar.hidden = false;

  if (fileTotalSize && fileTotalSize > 0) {
    const pct = Math.min(100, (totalBytesTransferred / fileTotalSize) * 100);
    transferFill.style.width = `${pct}%`;
    transferLabel.textContent = `${fmtBytes(totalBytesTransferred)} / ${fmtBytes(fileTotalSize)} (${pct.toFixed(1)}%)`;
  } else {
    transferFill.style.width = '0%';
    transferLabel.textContent = `${fmtBytes(totalBytesTransferred)} / ?`;
  }
}

function resetNetworkLog(): void {
  // Remove all rows except header
  const rows = networkLog.querySelectorAll('.net-row:not(.net-header)');
  rows.forEach((r) => r.remove());
  totalBytesTransferred = 0;
  fileTotalSize = null;
  requestCount = 0;
  networkSummary.textContent = '0 requests';
  transferBar.hidden = true;
}

// ─── Sliders ─────────────────────────────────────────────────────────────────

startSlider.addEventListener('input', () => {
  startVal.textContent = parseFloat(startSlider.value).toFixed(1);
});
endSlider.addEventListener('input', () => {
  endVal.textContent = parseFloat(endSlider.value).toFixed(1);
});

// ─── Load segment ────────────────────────────────────────────────────────────

loadBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  const start = parseFloat(startSlider.value);
  const end = parseFloat(endSlider.value);

  if (!url || start >= end) {
    statusEl.textContent = 'Invalid input';
    return;
  }

  resetNetworkLog();
  loadBtn.disabled = true;
  playBtn.disabled = true;
  stopBtn.disabled = true;
  statusEl.textContent = 'Loading segment...';

  try {
    audioCtx = audioCtx || new AudioContext();
    audioBuffer = await audioSnip.decodeAudioDataSegment(audioCtx, url, start, end);
    statusEl.textContent = `Loaded: ${audioBuffer.duration.toFixed(2)}s, ${audioBuffer.sampleRate}Hz, ${audioBuffer.numberOfChannels}ch`;
    playBtn.disabled = false;
    drawWaveform(audioBuffer);
  } catch (err) {
    statusEl.textContent = `Error: ${err}`;
    console.error(err);
  } finally {
    loadBtn.disabled = false;
  }
});

// ─── Playback ────────────────────────────────────────────────────────────────

playBtn.addEventListener('click', () => {
  if (!audioCtx || !audioBuffer) return;
  stopPlayback();
  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(audioCtx.destination);
  sourceNode.onended = () => {
    stopBtn.disabled = true;
    playBtn.disabled = false;
  };
  sourceNode.start();
  stopBtn.disabled = false;
});

stopBtn.addEventListener('click', stopPlayback);

function stopPlayback(): void {
  if (sourceNode) {
    try { sourceNode.stop(); } catch { /* already stopped */ }
    sourceNode.disconnect();
    sourceNode = null;
  }
  stopBtn.disabled = true;
}

// ─── Waveform ────────────────────────────────────────────────────────────────

function drawWaveform(buffer: AudioBuffer): void {
  const ctx = canvas.getContext('2d')!;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.scale(dpr, dpr);

  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / w);

  ctx.fillStyle = '#2563eb';
  const mid = h / 2;

  for (let x = 0; x < w; x++) {
    const s = x * step;
    let min = 1, max = -1;
    for (let j = 0; j < step && s + j < data.length; j++) {
      const v = data[s + j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const top = mid + min * mid;
    const bottom = mid + max * mid;
    ctx.fillRect(x, top, 1, bottom - top || 1);
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

// ─── Init ────────────────────────────────────────────────────────────────────

registerSW();
