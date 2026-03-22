// ─── Types ───────────────────────────────────────────────────────────────────

export interface AudioFileInfo {
  duration: number | null;
  sampleRate: number;
  channels: number;
  bitrate: number;
  codec: string;
  isVbr: boolean;
  encoderDelay: number; // samples
}

export abstract class BasePlugin {
  abstract canHandle(url: string): boolean;
  abstract getInfo(url: string): Promise<AudioFileInfo>;
  abstract decode(
    ctx: BaseAudioContext,
    url: string,
    startTime: number,
    endTime: number,
  ): Promise<AudioBuffer>;
}

// ─── Shared utilities ────────────────────────────────────────────────────────

export async function fetchRange(
  url: string,
  start: number,
  end: number,
): Promise<Uint8Array> {
  const resp = await fetch(url, {
    headers: { Range: `bytes=${start}-${end}` },
  });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`HTTP ${resp.status} fetching range ${start}-${end}`);
  }
  const data = new Uint8Array(await resp.arrayBuffer());
  // If server ignored Range and returned full file, slice to requested range
  if (resp.status === 200 && data.length > end - start + 1) {
    return data.slice(start, end + 1);
  }
  return data;
}

export async function fetchContentLength(
  url: string,
): Promise<number | null> {
  // Try HEAD first
  const headResp = await fetch(url, { method: 'HEAD' });
  const cl = headResp.headers.get('content-length');
  if (cl) return parseInt(cl, 10);
  // Fallback: GET with Range 0-0 and parse Content-Range
  const rangeResp = await fetch(url, {
    headers: { Range: 'bytes=0-0' },
  });
  const cr = rangeResp.headers.get('content-range');
  if (cr) {
    const match = cr.match(/\/(\d+)/);
    if (match) {
      await rangeResp.arrayBuffer(); // consume body
      return parseInt(match[1], 10);
    }
  }
  // If no Content-Range, check Content-Length from the response itself
  if (!cr) {
    const cl2 = rangeResp.headers.get('content-length');
    if (cl2) {
      await rangeResp.arrayBuffer(); // consume body
      return parseInt(cl2, 10);
    }
  }
  await rangeResp.arrayBuffer(); // consume body
  return null;
}

// ─── RemoteFile — per-operation file handle ──────────────────────────────────

/**
 * Wraps a URL for efficient byte access. On the first getRange() call it probes
 * whether the server supports HTTP Range requests. If the server returns 200
 * (full file), the data is kept in memory and all subsequent getRange() calls
 * are served locally — the file is never re-downloaded.
 *
 * Create one RemoteFile per decode() call, let it go when done.
 */
export class RemoteFile {
  private url: string;
  private fullData: Uint8Array | null = null;
  private _size: number | null = null;
  private _rangeSupported: boolean | null = null;

  constructor(url: string) {
    this.url = url;
  }

  get rangeSupported(): boolean | null {
    return this._rangeSupported;
  }

  get size(): number | null {
    return this._size;
  }

  /** Fetch content length via HEAD (does not download body). */
  async fetchSize(): Promise<number | null> {
    if (this._size !== null) return this._size;
    if (this.fullData) {
      this._size = this.fullData.length;
      return this._size;
    }
    this._size = await fetchContentLength(this.url);
    return this._size;
  }

  /** Read a byte range. Detects Range support on first call. */
  async getRange(start: number, end: number): Promise<Uint8Array> {
    // Already have the whole file in memory — just slice
    if (this.fullData) {
      return this.fullData.slice(start, end + 1);
    }

    const resp = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`HTTP ${resp.status} fetching range ${start}-${end} from ${this.url}`);
    }

    const data = new Uint8Array(await resp.arrayBuffer());

    if (resp.status === 206) {
      this._rangeSupported = true;
      // Pick up total size from Content-Range if we don't have it yet
      if (this._size === null) {
        const cr = resp.headers.get('content-range');
        if (cr) {
          const m = cr.match(/\/(\d+)/);
          if (m) this._size = parseInt(m[1], 10);
        }
      }
      return data;
    }

    // Server returned 200 (full file) — keep it, never re-download
    this._rangeSupported = false;
    this.fullData = data;
    this._size = data.length;
    return data.slice(start, end + 1);
  }
}

export function trimBySamples(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  startSample: number,
  endSample: number,
): AudioBuffer {
  const start = Math.max(0, Math.round(startSample));
  const end = Math.min(buffer.length, Math.round(endSample));
  const length = end - start;
  if (length <= 0) {
    throw new Error(
      `Invalid trim range: startSample=${startSample}, endSample=${endSample}, bufferLength=${buffer.length}`,
    );
  }
  const trimmed = ctx.createBuffer(
    buffer.numberOfChannels,
    length,
    buffer.sampleRate,
  );
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const src = buffer.getChannelData(ch);
    trimmed.copyToChannel(src.subarray(start, end), ch);
  }
  return trimmed;
}

// ─── Plugin registry / singleton ─────────────────────────────────────────────

class AudioSnip {
  private plugins: BasePlugin[] = [];

  register(plugin: BasePlugin): void {
    this.plugins.push(plugin);
  }

  private resolve(url: string): BasePlugin {
    for (const p of this.plugins) {
      if (p.canHandle(url)) return p;
    }
    throw new Error(`No plugin registered for URL: ${url}`);
  }

  async decodeAudioDataSegment(
    ctx: BaseAudioContext,
    url: string,
    startTime: number,
    endTime: number,
  ): Promise<AudioBuffer> {
    const plugin = this.resolve(url);
    return plugin.decode(ctx, url, startTime, endTime);
  }
}

export const audioSnip = new AudioSnip();
