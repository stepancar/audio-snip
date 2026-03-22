import {
  BasePlugin,
  AudioFileInfo,
  RemoteFile,
  trimBySamples,
} from '../core.js';

// ─── MP4Box type declarations ────────────────────────────────────────────────

interface MP4EditEntry {
  segment_duration: number;
  media_time: number;
  media_rate: number;
}

interface MP4Track {
  id: number;
  type: string;
  codec: string;
  audio?: {
    sample_rate: number;
    channel_count: number;
    sample_size: number;
  };
  timescale: number;
  duration: number;
  nb_samples: number;
  bitrate: number;
  movie_duration: number;
  movie_timescale: number;
  edits?: MP4EditEntry[];
}

interface MP4Sample {
  number: number;
  track_id: number;
  description_index: number;
  description: {
    aacDecoderConfigDescriptor?: {
      audioObjectType: number;
      samplingFrequencyIndex: number;
      channelConfiguration: number;
    };
  };
  data: ArrayBuffer;
  size: number;
  duration: number;
  cts: number;
  dts: number;
  is_sync: boolean;
  offset: number;
}

interface MP4Info {
  tracks: MP4Track[];
  duration: number;
  timescale: number;
}

interface MP4SampleInfo {
  number: number;
  offset: number;
  size: number;
  duration: number;
  cts: number;
  dts: number;
  is_sync: boolean;
  track_id: number;
  timescale: number;
  description: MP4Sample['description'];
  alreadyRead: number;
}

interface MP4BoxFile {
  onReady: ((info: MP4Info) => void) | null;
  onError: ((e: Error) => void) | null;
  onSamples: ((id: number, user: unknown, samples: MP4Sample[]) => void) | null;
  appendBuffer(data: ArrayBuffer & { fileStart?: number }): number;
  flush(): void;
  setExtractionOptions(trackId: number, user?: unknown, options?: { nbSamples?: number; rapAlignement?: boolean }): void;
  unsetExtractionOptions(trackId: number): void;
  start(): void;
  stop(): void;
  seek(time: number, useRap?: boolean): { offset: number; time: number };
  getTrackById(trackId: number): MP4Track;
  getTrackSamplesInfo(trackId: number): MP4SampleInfo[];
  releaseUsedSamples(trackId: number, sampleNum: number): void;
}

import MP4BoxFactory from 'mp4box';

const MP4Box = MP4BoxFactory as unknown as { createFile(): MP4BoxFile };

const AAC_LC_PRIMING_SAMPLES = 2112;
const MOOV_TIMEOUT_MS = 30000;
const MOOV_INITIAL_BYTES = 2 * 1024 * 1024;
const RANGE_MERGE_GAP = 64 * 1024;

// ─── ADTS header construction ────────────────────────────────────────────────

function makeAdtsHeader(
  frameLength: number,
  audioObjectType: number,
  samplingFrequencyIndex: number,
  channelConfiguration: number,
): Uint8Array {
  const header = new Uint8Array(7);
  const fullLength = frameLength + 7;

  // Syncword (12 bits), ID (1 bit = 0 for MPEG-4), Layer (2 bits = 00), Protection absent (1 bit = 1)
  header[0] = 0xFF;
  header[1] = 0xF1;
  // Profile (2 bits, audioObjectType - 1), Sampling freq idx (4 bits), Private (1 bit = 0), Channel config high (1 bit)
  header[2] =
    ((audioObjectType - 1) << 6) |
    (samplingFrequencyIndex << 2) |
    (0 << 1) |
    ((channelConfiguration >> 2) & 0x01);
  // Channel config low (2 bits), Original (1 bit = 0), Home (1 bit = 0), copyright_id (1 bit = 0), copyright_start (1 bit = 0), frame length high (2 bits)
  header[3] =
    ((channelConfiguration & 0x03) << 6) |
    ((fullLength >> 11) & 0x03);
  // frame length mid (8 bits)
  header[4] = (fullLength >> 3) & 0xFF;
  // frame length low (3 bits), buffer fullness high (5 bits = 0x1F)
  header[5] = ((fullLength & 0x07) << 5) | 0x1F;
  // buffer fullness low (6 bits = 0x3F), number of AAC frames - 1 (2 bits = 0)
  header[6] = 0xFC;

  return header;
}

// Sampling frequency index table
const SAMPLING_FREQ_TABLE = [
  96000, 88200, 64000, 48000, 44100, 32000,
  24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

function getSamplingFrequencyIndex(sampleRate: number): number {
  const idx = SAMPLING_FREQ_TABLE.indexOf(sampleRate);
  return idx >= 0 ? idx : 4; // default to 44100
}

// ─── Mp4Plugin ───────────────────────────────────────────────────────────────

export class Mp4Plugin extends BasePlugin {
  canHandle(url: string): boolean {
    const path = url.split('?')[0].split('#')[0].toLowerCase();
    return path.endsWith('.m4a') || path.endsWith('.mp4') || path.endsWith('.aac') || path.endsWith('.m4b');
  }

  async getInfo(url: string): Promise<AudioFileInfo> {
    const file = new RemoteFile(url);
    const { info, audioTrack } = await this.loadMoovForDecode(file);
    const duration = info.duration / info.timescale;

    // Parse encoder delay from edit list (elst atom)
    let encoderDelay: number;
    const edits = audioTrack.edits;
    if (edits && edits.length > 0 && edits[0].media_time > 0) {
      const mediaTime = edits[0].media_time;
      encoderDelay = Math.round(mediaTime * audioTrack.audio!.sample_rate / audioTrack.timescale);
    } else {
      // Default priming for AAC-LC: 1024 * 2 + 64 = 2112
      encoderDelay = AAC_LC_PRIMING_SAMPLES;
    }

    return {
      duration,
      sampleRate: audioTrack.audio!.sample_rate,
      channels: audioTrack.audio!.channel_count,
      bitrate: audioTrack.bitrate,
      codec: audioTrack.codec,
      isVbr: true, // AAC is always VBR conceptually
      encoderDelay,
    };
  }

  async decode(
    ctx: BaseAudioContext,
    url: string,
    startTime: number,
    endTime: number,
  ): Promise<AudioBuffer> {
    // Step 1: Load moov atom only (a few MB) to get metadata + sample table
    const file = new RemoteFile(url);
    const { audioTrack, mp4 } = await this.loadMoovForDecode(file);

    const sampleRate = audioTrack.audio!.sample_rate;
    const timescale = audioTrack.timescale;

    // Parse encoder delay from edit list
    let encoderDelay: number;
    const edits = audioTrack.edits;
    if (edits && edits.length > 0 && edits[0].media_time > 0) {
      const mediaTime = edits[0].media_time;
      encoderDelay = Math.round(mediaTime * sampleRate / timescale);
    } else {
      encoderDelay = AAC_LC_PRIMING_SAMPLES; // Default AAC-LC priming
    }

    // Step 2: Use sample table to find which samples fall in [startTime, endTime]
    const allSamples = mp4.getTrackSamplesInfo(audioTrack.id);
    if (allSamples.length === 0) {
      throw new Error('No audio samples in track');
    }

    const startTS = startTime * timescale;
    const endTS = endTime * timescale;

    let firstIdx = 0;
    let lastIdx = allSamples.length - 1;

    for (let i = 0; i < allSamples.length; i++) {
      if (allSamples[i].cts + allSamples[i].duration > startTS) {
        firstIdx = Math.max(0, i - 1); // one extra for decoder priming
        break;
      }
    }
    for (let i = allSamples.length - 1; i >= 0; i--) {
      if (allSamples[i].cts < endTS) {
        lastIdx = Math.min(allSamples.length - 1, i + 1); // one extra at end
        break;
      }
    }

    const neededSamples = allSamples.slice(firstIdx, lastIdx + 1);

    // Step 3: Compute minimal byte ranges from sample offsets
    // Collapse contiguous/overlapping samples into merged ranges
    const ranges = this.collapseRanges(neededSamples);

    // Step 4: Fetch only the byte ranges containing needed samples
    // We read sample data directly from the fetched bytes — no onSamples needed.
    const rangeData = new Map<number, Uint8Array>(); // range.start → data
    for (const range of ranges) {
      const data = await file.getRange(range.start, range.end);
      rangeData.set(range.start, data);
    }

    // Step 5: Extract raw AAC frame data for each needed sample
    // by reading directly from fetched ranges using sample offset/size
    const firstSampleInfo = neededSamples[0];
    const aacConfig = firstSampleInfo.description?.aacDecoderConfigDescriptor;
    const audioObjectType = aacConfig?.audioObjectType ?? 2;
    const samplingFreqIndex = aacConfig?.samplingFrequencyIndex ?? getSamplingFrequencyIndex(sampleRate);
    const channelConfig = aacConfig?.channelConfiguration ?? audioTrack.audio!.channel_count;

    const adtsChunks: Uint8Array[] = [];
    for (const si of neededSamples) {
      // Find which fetched range contains this sample
      const rawData = this.readSampleFromRanges(si.offset, si.size, ranges, rangeData);
      if (!rawData) {
        throw new Error(`Failed to read sample at offset ${si.offset}, size ${si.size} — byte range not fetched`);
      }

      const adtsHeader = makeAdtsHeader(
        rawData.length,
        audioObjectType,
        samplingFreqIndex,
        channelConfig,
      );
      const frame = new Uint8Array(adtsHeader.length + rawData.length);
      frame.set(adtsHeader, 0);
      frame.set(rawData, adtsHeader.length);
      adtsChunks.push(frame);
    }

    if (adtsChunks.length === 0) {
      throw new Error('No audio samples could be read from fetched ranges');
    }

    const totalLen = adtsChunks.reduce((acc, c) => acc + c.length, 0);
    const adtsStream = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of adtsChunks) {
      adtsStream.set(chunk, offset);
      offset += chunk.length;
    }

    // Step 6: Decode and trim
    const decoded = await ctx.decodeAudioData(adtsStream.buffer.slice(0));

    const decodedRate = decoded.sampleRate;
    const rangeStartTime = neededSamples[0].cts / timescale;
    const trimStartSeconds = startTime - rangeStartTime;
    const trimStartSamples = Math.round(trimStartSeconds * decodedRate) + encoderDelay;
    const wantedSamples = Math.round((endTime - startTime) * decodedRate);

    const startSample = Math.max(0, trimStartSamples);
    const endSample = Math.min(decoded.length, startSample + wantedSamples);

    return trimBySamples(ctx, decoded, startSample, endSample);
  }

  /**
   * Read sample data from pre-fetched byte ranges.
   */
  private readSampleFromRanges(
    sampleOffset: number,
    sampleSize: number,
    ranges: { start: number; end: number }[],
    rangeData: Map<number, Uint8Array>,
  ): Uint8Array | null {
    for (const range of ranges) {
      if (sampleOffset >= range.start && sampleOffset + sampleSize - 1 <= range.end) {
        const data = rangeData.get(range.start);
        if (!data) return null;
        const localOffset = sampleOffset - range.start;
        return data.subarray(localOffset, localOffset + sampleSize);
      }
    }
    return null;
  }

  /**
   * Collapse sample byte ranges into minimal contiguous fetch ranges.
   * Adjacent or overlapping ranges are merged to reduce HTTP requests.
   */
  private collapseRanges(
    samples: MP4SampleInfo[],
  ): { start: number; end: number }[] {
    if (samples.length === 0) return [];

    const sorted = [...samples].sort((a, b) => a.offset - b.offset);
    const ranges: { start: number; end: number }[] = [];
    let cur = { start: sorted[0].offset, end: sorted[0].offset + sorted[0].size - 1 };

    for (let i = 1; i < sorted.length; i++) {
      const sampleStart = sorted[i].offset;
      const sampleEnd = sampleStart + sorted[i].size - 1;
      // Merge if gap is < 64KB (cheaper to over-fetch than make another request)
      if (sampleStart <= cur.end + RANGE_MERGE_GAP) {
        cur.end = Math.max(cur.end, sampleEnd);
      } else {
        ranges.push(cur);
        cur = { start: sampleStart, end: sampleEnd };
      }
    }
    ranges.push(cur);
    return ranges;
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private async loadMoovForDecode(file: RemoteFile): Promise<{ info: MP4Info; audioTrack: MP4Track; mp4: MP4BoxFile }> {
    const mp4 = MP4Box.createFile();
    const fileSize = await file.fetchSize();

    let timer: ReturnType<typeof setTimeout>;
    const infoPromise = new Promise<MP4Info>((resolve, reject) => {
      mp4.onReady = resolve;
      mp4.onError = reject;
      this.streamToMP4Box(mp4, file, fileSize).catch(reject);
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timeout: could not parse MP4 metadata')), MOOV_TIMEOUT_MS);
    });
    let info: MP4Info;
    try {
      info = await Promise.race([infoPromise, timeout]);
    } finally {
      clearTimeout(timer!);
    }

    const audioTrack = info.tracks.find((t) => t.type === 'audio');
    if (!audioTrack) throw new Error('No audio track found in MP4');

    return { info, audioTrack, mp4 };
  }

  private async streamToMP4Box(
    mp4: MP4BoxFile,
    file: RemoteFile,
    fileSize: number | null,
  ): Promise<void> {
    const chunkSize = 256 * 1024;
    if (!fileSize) throw new Error('Cannot determine file size — needed for MP4 parsing');

    // mp4box calls onReady when moov is parsed. We track that to stop early.
    let moovFound = false;
    const origOnReady = mp4.onReady;
    mp4.onReady = (info) => {
      moovFound = true;
      origOnReady?.(info);
    };

    // Stream from start until moov is found or we hit MOOV_INITIAL_BYTES
    let offset = 0;
    while (offset < fileSize && !moovFound) {
      const end = Math.min(offset + chunkSize - 1, fileSize - 1);
      const data = await file.getRange(offset, end);
      const ab = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer & { fileStart?: number };
      ab.fileStart = offset;
      mp4.appendBuffer(ab);
      offset = end + 1;

      // After reading MOOV_INITIAL_BYTES from start without finding moov,
      // jump to the tail (moov-at-end layout)
      if (!moovFound && offset >= MOOV_INITIAL_BYTES && offset < fileSize - chunkSize) {
        break;
      }
    }

    // If moov wasn't in the head, try the tail
    if (!moovFound && offset < fileSize) {
      const tailStart = Math.max(offset, fileSize - MOOV_INITIAL_BYTES);
      let tailOffset = tailStart;
      while (tailOffset < fileSize && !moovFound) {
        const end = Math.min(tailOffset + chunkSize - 1, fileSize - 1);
        const data = await file.getRange(tailOffset, end);
        const ab = data.buffer.slice(
          data.byteOffset,
          data.byteOffset + data.byteLength,
        ) as ArrayBuffer & { fileStart?: number };
        ab.fileStart = tailOffset;
        mp4.appendBuffer(ab);
        tailOffset = end + 1;
      }
    }

    mp4.flush();
  }

}
