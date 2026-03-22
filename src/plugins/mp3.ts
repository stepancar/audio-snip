import {
  BasePlugin,
  AudioFileInfo,
  RemoteFile,
  trimBySamples,
} from '../core.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const HEAD_SIZE = 128 * 1024; // 128 KB initial fetch

// MPEG bitrate tables [version][layer][index]
const BITRATE_TABLE: Record<string, number[]> = {
  'V1L1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  'V1L2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  'V1L3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  'V2L1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  'V2L2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
  'V2L3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

const SAMPLE_RATE_TABLE: number[][] = [
  [44100, 48000, 32000, 0], // MPEG1
  [22050, 24000, 16000, 0], // MPEG2
  [11025, 12000, 8000, 0],  // MPEG2.5
];

const SAMPLES_PER_FRAME: Record<string, number> = {
  'V1L1': 384,
  'V1L2': 1152,
  'V1L3': 1152,
  'V2L1': 384,
  'V2L2': 1152,
  'V2L3': 576,
};

// ─── Frame header parsing ────────────────────────────────────────────────────

interface FrameHeader {
  mpegVersion: number; // 1, 2, or 2.5
  layer: number;       // 1, 2, or 3
  bitrate: number;     // kbps
  sampleRate: number;
  channels: number;
  padding: boolean;
  samplesPerFrame: number;
  frameSize: number;
  sideInfoSize: number;
}

function parseFrameHeader(data: Uint8Array, offset: number): FrameHeader | null {
  if (offset + 4 > data.length) return null;

  const b0 = data[offset];
  const b1 = data[offset + 1];
  const b2 = data[offset + 2];
  const b3 = data[offset + 3];

  // Sync: 11 bits set
  if (b0 !== 0xFF || (b1 & 0xE0) !== 0xE0) return null;

  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const bitrateIdx = (b2 >> 4) & 0x0F;
  const srIdx = (b2 >> 2) & 0x03;
  const padding = ((b2 >> 1) & 0x01) === 1;
  const channelMode = (b3 >> 6) & 0x03;

  // Reject reserved values
  if (versionBits === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) {
    return null;
  }

  const mpegVersion = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;
  const vKey = mpegVersion === 1 ? 'V1' : 'V2';
  const lKey = `L${layer}`;
  const key = `${vKey}${lKey}`;

  const bitrate = BITRATE_TABLE[key]?.[bitrateIdx];
  if (!bitrate) return null;

  const srTableIdx = mpegVersion === 1 ? 0 : mpegVersion === 2 ? 1 : 2;
  const sampleRate = SAMPLE_RATE_TABLE[srTableIdx][srIdx];
  if (!sampleRate) return null;

  const samplesPerFrame = SAMPLES_PER_FRAME[key];
  const channels = channelMode === 3 ? 1 : 2;

  let frameSize: number;
  if (layer === 1) {
    frameSize = Math.floor((12 * bitrate * 1000) / sampleRate + (padding ? 1 : 0)) * 4;
  } else {
    frameSize = Math.floor((samplesPerFrame * (bitrate * 1000) / 8) / sampleRate) + (padding ? 1 : 0);
  }

  // Side information size for Layer 3
  let sideInfoSize = 0;
  if (layer === 3) {
    if (mpegVersion === 1) {
      sideInfoSize = channels === 1 ? 17 : 32;
    } else {
      sideInfoSize = channels === 1 ? 9 : 17;
    }
  }

  return {
    mpegVersion,
    layer,
    bitrate,
    sampleRate,
    channels,
    padding,
    samplesPerFrame,
    frameSize,
    sideInfoSize,
  };
}

// ─── ID3v2 tag size ──────────────────────────────────────────────────────────

function id3v2Size(data: Uint8Array): number {
  if (data.length < 10) return 0;
  if (data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return 0; // "ID3"
  // Syncsafe integer at bytes 6-9
  const size =
    ((data[6] & 0x7F) << 21) |
    ((data[7] & 0x7F) << 14) |
    ((data[8] & 0x7F) << 7) |
    (data[9] & 0x7F);
  const flags = data[5];
  const hasFooter = (flags & 0x10) !== 0;
  return size + 10 + (hasFooter ? 10 : 0); // 10-byte header + optional 10-byte footer
}

// ─── Find first frame sync after given offset ───────────────────────────────

function findFrameSync(data: Uint8Array, start: number): number {
  for (let i = start; i < data.length - 4; i++) {
    if (data[i] === 0xFF && (data[i + 1] & 0xE0) === 0xE0) {
      const hdr = parseFrameHeader(data, i);
      if (hdr && hdr.frameSize > 0) {
        // Validate next frame exists
        const next = i + hdr.frameSize;
        if (next + 2 <= data.length) {
          if (data[next] === 0xFF && (data[next + 1] & 0xE0) === 0xE0) {
            return i;
          }
        } else {
          // Near end of data, trust single sync
          return i;
        }
      }
    }
  }
  return -1;
}

// ─── Xing / VBRI parsing ────────────────────────────────────────────────────

interface VbrInfo {
  isVbr: boolean;
  totalFrames: number | null;
  totalBytes: number | null;
  toc: Uint8Array | null; // 100 entries
  encoderDelay: number;
  encoderPadding: number;
}

function parseXingVbri(
  data: Uint8Array,
  frameOffset: number,
  header: FrameHeader,
): VbrInfo | null {
  // Xing/Info header is after frame header (4 bytes) + side info
  const xingOffset = frameOffset + 4 + header.sideInfoSize;

  if (xingOffset + 4 > data.length) return null;

  const tag = String.fromCharCode(
    data[xingOffset],
    data[xingOffset + 1],
    data[xingOffset + 2],
    data[xingOffset + 3],
  );

  if (tag === 'Xing' || tag === 'Info') {
    const flags = readU32BE(data, xingOffset + 4);
    let pos = xingOffset + 8;

    let totalFrames: number | null = null;
    let totalBytes: number | null = null;
    let toc: Uint8Array | null = null;

    if (flags & 1) {
      totalFrames = readU32BE(data, pos);
      pos += 4;
    }
    if (flags & 2) {
      totalBytes = readU32BE(data, pos);
      pos += 4;
    }
    if (flags & 4) {
      toc = data.slice(pos, pos + 100);
      pos += 100;
    }
    // flags & 8 → quality indicator, skip
    if (flags & 8) {
      pos += 4;
    }

    // LAME tag: encoder string at Xing+120, delay/padding at Xing+141
    let encoderDelay = 0;
    let encoderPadding = 0;

    const lameOffset = xingOffset + 141;
    if (lameOffset + 3 <= data.length) {
      // Verify LAME tag exists (9 char encoder string at xingOffset+120)
      const lameTag = String.fromCharCode(
        data[xingOffset + 120],
        data[xingOffset + 121],
        data[xingOffset + 122],
        data[xingOffset + 123],
      );
      if (lameTag === 'LAME' || lameTag === 'Lavf' || lameTag === 'Lavc') {
        // Encoder delay: 12 bits at byte 141, encoder padding: 12 bits at byte 142-143
        const delayByte1 = data[xingOffset + 141];
        const delayByte2 = data[xingOffset + 142];
        const delayByte3 = data[xingOffset + 143];
        encoderDelay = (delayByte1 << 4) | (delayByte2 >> 4);
        encoderPadding = ((delayByte2 & 0x0F) << 8) | delayByte3;
      }
    }

    return {
      isVbr: tag === 'Xing',
      totalFrames,
      totalBytes,
      toc,
      encoderDelay,
      encoderPadding,
    };
  }

  // Try VBRI (Fraunhofer) — always at offset 36 from frame start
  const vbriOffset = frameOffset + 36;
  if (vbriOffset + 4 <= data.length) {
    const vbriTag = String.fromCharCode(
      data[vbriOffset],
      data[vbriOffset + 1],
      data[vbriOffset + 2],
      data[vbriOffset + 3],
    );
    if (vbriTag === 'VBRI') {
      const totalBytes = readU32BE(data, vbriOffset + 10);
      const totalFrames = readU32BE(data, vbriOffset + 14);
      return {
        isVbr: true,
        totalFrames,
        totalBytes,
        toc: null,
        encoderDelay: 0,
        encoderPadding: 0,
      };
    }
  }

  return null;
}

function readU32BE(data: Uint8Array, offset: number): number {
  return (
    ((data[offset] << 24) >>> 0) +
    (data[offset + 1] << 16) +
    (data[offset + 2] << 8) +
    data[offset + 3]
  );
}

// ─── TOC-based byte interpolation for VBR ────────────────────────────────────

function tocInterpolate(
  toc: Uint8Array,
  fraction: number,
  totalBytes: number,
): number {
  // fraction is 0..1 representing position in file
  const scaledPos = fraction * 100;
  const idx = Math.min(99, Math.floor(scaledPos));
  const idxFrac = scaledPos - idx;

  const lower = toc[idx];
  const upper = idx < 99 ? toc[idx + 1] : 256;
  const interpolated = lower + idxFrac * (upper - lower);

  return Math.floor((interpolated / 256) * totalBytes);
}

// ─── Mp3Plugin ───────────────────────────────────────────────────────────────

export interface Mp3PluginOptions {
  paddingFrames?: number;
}

export class Mp3Plugin extends BasePlugin {
  private paddingFrames: number;

  constructor(options: Mp3PluginOptions = {}) {
    super();
    this.paddingFrames = options.paddingFrames ?? 8;
  }

  canHandle(url: string): boolean {
    const path = url.split('?')[0].split('#')[0].toLowerCase();
    return path.endsWith('.mp3');
  }

  async getInfo(url: string): Promise<AudioFileInfo> {
    const file = new RemoteFile(url);
    const { header, vbrInfo, fileSize, audioStart } = await this.fetchHeader(file);
    const duration = this.computeDuration(header, vbrInfo, fileSize, audioStart, vbrInfo?.encoderDelay ?? 0, vbrInfo?.encoderPadding ?? 0);

    return {
      duration,
      sampleRate: header.sampleRate,
      channels: header.channels,
      bitrate: header.bitrate,
      codec: `MPEG${header.mpegVersion} Layer ${header.layer}`,
      isVbr: vbrInfo?.isVbr ?? false,
      encoderDelay: vbrInfo?.encoderDelay ?? 0,
    };
  }

  async decode(
    ctx: BaseAudioContext,
    url: string,
    startTime: number,
    endTime: number,
  ): Promise<AudioBuffer> {
    const file = new RemoteFile(url);
    const { header, vbrInfo, audioStart, xingFrameStart, fileSize } = await this.fetchHeader(file);

    const sampleRate = header.sampleRate;
    const encoderDelay = vbrInfo?.encoderDelay ?? 0;
    const encoderPadding = vbrInfo?.encoderPadding ?? 0;
    const isVbr = vbrInfo?.isVbr ?? false;
    const duration = this.computeDuration(header, vbrInfo, fileSize, audioStart, encoderDelay, encoderPadding);

    // Compute byte range for the requested time segment
    let startByte: number;
    let endByte: number;

    // For VBR+TOC, map time to byte position via TOC
    if (isVbr && vbrInfo?.toc && vbrInfo.totalBytes && duration) {
      const startFrac = Math.max(0, startTime / duration);
      const endFrac = Math.min(1, endTime / duration);
      startByte = xingFrameStart + tocInterpolate(vbrInfo.toc, startFrac, vbrInfo.totalBytes);
      endByte = xingFrameStart + tocInterpolate(vbrInfo.toc, endFrac, vbrInfo.totalBytes);
    } else {
      // CBR or VBR-without-TOC: linear byte estimate
      const bytesPerSecond = (header.bitrate * 1000) / 8;
      startByte = audioStart + Math.floor(startTime * bytesPerSecond);
      endByte = audioStart + Math.ceil(endTime * bytesPerSecond);
    }

    // Snap to frame boundaries and add padding
    const paddingBytes = this.paddingFrames * header.frameSize;
    const fetchStart = Math.max(audioStart, startByte - paddingBytes);
    // Add extra frames at end for safety
    const fetchEnd = Math.min(
      (fileSize ?? endByte + paddingBytes * 2) - 1,
      endByte + paddingBytes * 2,
    );

    // Fetch the segment
    const chunk = await file.getRange(fetchStart, fetchEnd);

    // Find first valid frame in fetched chunk
    const firstSync = findFrameSync(chunk, 0);
    if (firstSync === -1) {
      throw new Error('No valid MP3 frame found in fetched range');
    }

    // Walk frames to count samples up to the actual startByte offset
    // This gives us exact sample count for trimming, even for VBR
    const offsetInChunk = startByte - fetchStart;
    let samplesBefore = 0;
    let pos = firstSync;
    while (pos < chunk.length - 4) {
      const fh = parseFrameHeader(chunk, pos);
      if (!fh || fh.frameSize <= 0) break;
      if (pos >= offsetInChunk) break;
      samplesBefore += fh.samplesPerFrame;
      pos += fh.frameSize;
    }

    // Decode the entire fetched chunk
    const audioData = new Uint8Array(chunk.subarray(firstSync)).buffer;
    const decoded = await ctx.decodeAudioData(audioData.slice(0) as ArrayBuffer);

    // Use decoded buffer's sampleRate — AudioContext may resample (e.g. 44100→48000)
    const decodedRate = decoded.sampleRate;
    const resampleRatio = decodedRate / sampleRate;

    // Scale samplesBefore and encoderDelay to decoded rate
    const trimStartSamples = Math.round((samplesBefore - encoderDelay) * resampleRatio);
    const wantedSamples = Math.round((endTime - startTime) * decodedRate);

    const startSample = Math.max(0, trimStartSamples);
    let endSample = startSample + wantedSamples;

    // If endTime >= duration, also trim encoder padding from end
    if (duration && endTime >= duration - 0.01 && encoderPadding > 0) {
      const scaledPadding = Math.round(encoderPadding * resampleRatio);
      endSample = Math.min(endSample, decoded.length - scaledPadding);
    }

    endSample = Math.min(endSample, decoded.length);

    return trimBySamples(ctx, decoded, startSample, endSample);
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private async fetchHeader(file: RemoteFile): Promise<{
    header: FrameHeader;
    vbrInfo: VbrInfo | null;
    audioStart: number;
    xingFrameStart: number;
    fileSize: number | null;
  }> {
    const fileSize = await file.fetchSize();

    let headData = await file.getRange(0, HEAD_SIZE - 1);

    // Skip ID3v2 tag
    let audioStart = 0;
    const id3Size = id3v2Size(headData);
    if (id3Size > 0) {
      audioStart = id3Size;
      if (id3Size >= HEAD_SIZE) {
        headData = await file.getRange(id3Size, id3Size + HEAD_SIZE - 1);
      }
    }

    // Find first frame sync (search from 0 if we re-fetched past ID3, else from audioStart)
    const searchStart = id3Size >= HEAD_SIZE ? 0 : audioStart;
    const syncOffset = findFrameSync(headData, searchStart);
    if (syncOffset === -1) {
      throw new Error('No valid MP3 frame sync found');
    }

    const header = parseFrameHeader(headData, syncOffset)!;
    const absoluteFrameOffset = id3Size >= HEAD_SIZE ? id3Size + syncOffset : syncOffset;

    const vbrInfo = parseXingVbri(headData, syncOffset, header);

    // Audio starts after the Xing/Info frame (if present), or at the first frame
    const audioDataStart = vbrInfo
      ? absoluteFrameOffset + header.frameSize
      : absoluteFrameOffset;

    return {
      header,
      vbrInfo,
      audioStart: audioDataStart,
      xingFrameStart: absoluteFrameOffset,
      fileSize,
    };
  }

  private computeDuration(
    header: FrameHeader,
    vbrInfo: VbrInfo | null,
    fileSize: number | null,
    audioStart: number,
    encoderDelay: number = 0,
    encoderPadding: number = 0,
  ): number | null {
    if (vbrInfo?.totalFrames) {
      const totalSamples = vbrInfo.totalFrames * header.samplesPerFrame - encoderDelay - encoderPadding;
      return totalSamples / header.sampleRate;
    }
    if (fileSize) {
      const audioBytes = fileSize - audioStart;
      return audioBytes / ((header.bitrate * 1000) / 8);
    }
    return null;
  }
}
