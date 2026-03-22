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
  const full = new Uint8Array(await resp.arrayBuffer());
  // If server ignored Range header and returned full file (200 instead of 206),
  // slice to the requested range manually.
  if (resp.status === 200 && full.length > end - start + 1) {
    return full.slice(start, end + 1);
  }
  return full;
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
    if (match) return parseInt(match[1], 10);
  }
  return null;
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
