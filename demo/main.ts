import { audioSnip } from '../src/core.js';
import { Mp3Plugin } from '../src/plugins/mp3.js';
import { Mp4Plugin } from '../src/plugins/mp4.js';

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
const serverRangeBadge = document.getElementById('server-range-badge')!;

// ─── State ───────────────────────────────────────────────────────────────────

let audioBuffer: AudioBuffer | null = null;
let audioCtx: AudioContext | null = null;
let sourceNode: AudioBufferSourceNode | null = null;

let totalServerBytes = 0;   // total downloaded from origin
let totalClientBytes = 0;   // total delivered to library
let fileTotalSize: number | null = null;
let requestCount = 0;
let serverSupportsRange: boolean | null = null;

// ─── Fetch wrapper — reads X-SW-* headers for full picture ───────────────────

const originalFetch = window.fetch.bind(window);

window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const rangeHeader = req.headers.get('Range');

  const resp = await originalFetch(input, init);

  // Log Range requests and HEAD requests
  if (rangeHeader || req.method === 'HEAD') {
    // Read SW metadata headers (present when SW is active)
    const swServerStatus = resp.headers.get('X-SW-Server-Status');
    const swServerBytes = resp.headers.get('X-SW-Server-Bytes');
    const swClientBytes = resp.headers.get('X-SW-Client-Bytes');
    const swFileSize = resp.headers.get('X-SW-File-Size');
    const hasSW = swServerStatus !== null;

    // For client bytes: if SW reported, use that; otherwise read body
    let clientBytes = 0;
    if (req.method !== 'HEAD') {
      if (swClientBytes) {
        clientBytes = parseInt(swClientBytes, 10);
      } else {
        // No SW — read clone to measure
        const clone = resp.clone();
        clientBytes = (await clone.arrayBuffer()).byteLength;
      }
    }

    // Server bytes (what SW actually downloaded from origin)
    const serverBytes = swServerBytes ? parseInt(swServerBytes, 10) : clientBytes;

    // File size
    let fileSize: number | null = null;
    if (swFileSize) {
      fileSize = parseInt(swFileSize, 10);
    } else {
      const cr = resp.headers.get('Content-Range');
      if (cr) {
        const m = cr.match(/\/(\d+)/);
        if (m) fileSize = parseInt(m[1], 10);
      }
    }

    // Actual origin server status
    const originStatus = swServerStatus ? parseInt(swServerStatus, 10) : resp.status;

    addLogEntry({
      method: req.method,
      url: shortUrl(req.url),
      requestedRange: rangeHeader,
      originStatus,
      serverBytes,
      clientBytes,
      fileSize,
      hasSW,
    });
  }

  return resp;
};

// ─── Logging UI ──────────────────────────────────────────────────────────────

interface LogEntry {
  method: string;
  url: string;
  requestedRange: string | null;
  originStatus: number;    // what the real server returned
  serverBytes: number;     // bytes SW downloaded from server
  clientBytes: number;     // bytes delivered to the library
  fileSize: number | null;
  hasSW: boolean;          // was SW involved?
}

function addLogEntry(entry: LogEntry): void {
  requestCount++;

  // Detect server Range support from first real Range request
  if (entry.requestedRange && entry.method !== 'HEAD' && serverSupportsRange === null) {
    serverSupportsRange = entry.originStatus === 206;
    updateServerRangeBadge();
  }

  // Requested range display
  const rangeMatch = entry.requestedRange?.match(/bytes=(\d+)-(\d+)?/);
  let rangeDisplay: string;
  if (entry.method === 'HEAD') {
    rangeDisplay = 'HEAD';
  } else if (rangeMatch) {
    rangeDisplay = `${fmtBytes(+rangeMatch[1])} – ${rangeMatch[2] ? fmtBytes(+rangeMatch[2]) : 'end'}`;
  } else {
    rangeDisplay = '—';
  }

  // Origin status badge
  let statusHtml: string;
  if (entry.method === 'HEAD') {
    statusHtml = '<span class="badge badge-head">HEAD</span>';
  } else if (entry.originStatus === 206) {
    statusHtml = '<span class="badge badge-206">206</span>';
  } else {
    statusHtml = `<span class="badge badge-200">${entry.originStatus}</span>`;
  }

  // Server vs client bytes
  const serverBytesStr = entry.method === 'HEAD' ? '—' : fmtBytes(entry.serverBytes);
  const clientBytesStr = entry.method === 'HEAD' ? '—' : fmtBytes(entry.clientBytes);

  // Savings indicator (when SW sliced a full response)
  let savingsHtml = '';
  if (entry.method !== 'HEAD' && entry.originStatus !== 206 && entry.serverBytes > entry.clientBytes) {
    const saved = entry.serverBytes - entry.clientBytes;
    savingsHtml = `<span class="savings">-${fmtBytes(saved)}</span>`;
  }

  const row = document.createElement('div');
  row.className = 'net-row';
  row.innerHTML = `
    <span title="${entry.url}">${entry.url}</span>
    <span>${rangeDisplay}</span>
    <span>${statusHtml}</span>
    <span>${serverBytesStr}</span>
    <span>${clientBytesStr} ${savingsHtml}</span>
  `;
  networkLog.appendChild(row);
  networkLog.scrollTop = networkLog.scrollHeight;

  // Update totals
  if (entry.method !== 'HEAD') {
    totalServerBytes += entry.serverBytes;
    totalClientBytes += entry.clientBytes;
  }
  if (entry.fileSize != null && (fileTotalSize === null || entry.fileSize > fileTotalSize)) {
    fileTotalSize = entry.fileSize;
  }

  updateTransferBar();
  networkSummary.textContent = `${requestCount} req, ${fmtBytes(totalClientBytes)} received`;
}

function updateServerRangeBadge(): void {
  if (serverSupportsRange === null) {
    serverRangeBadge.textContent = 'not tested yet';
    serverRangeBadge.className = 'badge badge-unknown';
  } else if (serverSupportsRange) {
    serverRangeBadge.textContent = 'YES — server returns 206 Partial Content';
    serverRangeBadge.className = 'badge badge-206';
  } else {
    serverRangeBadge.textContent = 'NO — SW downloads full file and slices locally';
    serverRangeBadge.className = 'badge badge-200';
  }
}

function updateTransferBar(): void {
  transferBar.hidden = false;

  if (fileTotalSize && fileTotalSize > 0) {
    const pct = Math.min(100, (totalClientBytes / fileTotalSize) * 100);
    transferFill.style.width = `${pct}%`;
    transferLabel.textContent = `${fmtBytes(totalClientBytes)} / ${fmtBytes(fileTotalSize)} (${pct.toFixed(1)}%)`;
  } else {
    transferFill.style.width = '0%';
    transferLabel.textContent = `${fmtBytes(totalClientBytes)} / ?`;
  }
}

function resetNetworkLog(): void {
  const rows = networkLog.querySelectorAll('.net-row:not(.net-header)');
  rows.forEach((r) => r.remove());
  totalServerBytes = 0;
  totalClientBytes = 0;
  fileTotalSize = null;
  requestCount = 0;
  serverSupportsRange = null;
  networkSummary.textContent = '0 requests';
  transferBar.hidden = true;
  updateServerRangeBadge();
}

// ─── Service Worker registration ─────────────────────────────────────────────

async function registerSW(): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    swStatus.textContent = 'Not supported — Range fallback unavailable';
    return;
  }
  try {
    const base = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL || '/';
    const reg = await navigator.serviceWorker.register(base + 'sw.js', { scope: base });

    if (reg.active) {
      swStatus.textContent = 'Service Worker active — Range fallback ready';
    } else {
      swStatus.textContent = 'Service Worker installing...';
      const sw = reg.installing || reg.waiting;
      sw?.addEventListener('statechange', () => {
        if (sw.state === 'activated') {
          swStatus.textContent = 'Service Worker active — Range fallback ready';
        }
      });
    }
  } catch (err) {
    swStatus.textContent = `SW failed: ${err}`;
  }
}

// ─── File list ───────────────────────────────────────────────────────────────

const fileList = document.getElementById('file-list')!;

fileList.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.file-btn') as HTMLElement | null;
  if (!btn) return;

  fileList.querySelectorAll('.file-btn').forEach((b) => b.classList.remove('selected'));
  btn.classList.add('selected');
  urlInput.value = btn.dataset.url || '';

  const dur = btn.dataset.duration || '660';
  startSlider.max = dur;
  endSlider.max = dur;
  const maxEnd = Math.min(30, parseFloat(dur));
  endSlider.value = String(maxEnd);
  endVal.textContent = maxEnd.toFixed(1);
  const startDefault = Math.min(10, parseFloat(dur) - maxEnd);
  startSlider.value = String(Math.max(0, startDefault));
  startVal.textContent = Math.max(0, startDefault).toFixed(1);
});

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
  sourceNode.onended = () => { stopBtn.disabled = true; playBtn.disabled = false; };
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
    ctx.fillRect(x, mid + min * mid, 1, (max - min) * mid || 1);
  }
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function shortUrl(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').pop() || url;
    return name.length > 40 ? name.slice(0, 37) + '...' : name;
  } catch {
    return url.length > 40 ? url.slice(0, 37) + '...' : url;
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

updateServerRangeBadge();
registerSW();
