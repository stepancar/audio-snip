import {
  BasePlugin,
  AudioFileInfo,
  fetchRange,
  fetchContentLength,
  trimBySamples,
} from '../core.js';

// ─── MP4Box type declarations ────────────────────────────────────────────────

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

interface MP4BoxFile {
  onReady: ((info: MP4Info) => void) | null;
  onError: ((e: Error) => void) | null;
  onSamples: ((id: number, user: unknown, samples: MP4Sample[]) => void) | null;
  appendBuffer(data: ArrayBuffer & { fileStart?: number }): void;
  flush(): void;
  setExtractionOptions(trackId: number, user?: unknown, options?: { nbSamples?: number }): void;
  start(): void;
  seek(time: number, useRap?: boolean): { offset: number; time: number };
  getTrackById(trackId: number): MP4Track;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
import MP4BoxFactory from 'mp4box';

const MP4BoxLib = MP4BoxFactory as unknown as { createFile(): MP4BoxFile };

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
    try {
      const path = new URL(url, 'https://dummy').pathname.toLowerCase();
      return (
        path.endsWith('.m4a') ||
        path.endsWith('.mp4') ||
        path.endsWith('.aac') ||
        path.endsWith('.m4b')
      );
    } catch {
      const lower = url.toLowerCase();
      return lower.endsWith('.m4a') || lower.endsWith('.mp4') || lower.endsWith('.aac') || lower.endsWith('.m4b');
    }
  }

  async getInfo(url: string): Promise<AudioFileInfo> {
    const { info, audioTrack } = await this.loadMoov(url);
    const duration = info.duration / info.timescale;

    return {
      duration,
      sampleRate: audioTrack.audio!.sample_rate,
      channels: audioTrack.audio!.channel_count,
      bitrate: audioTrack.bitrate,
      codec: audioTrack.codec,
      isVbr: true, // AAC is always VBR conceptually
      encoderDelay: 0,
    };
  }

  async decode(
    ctx: BaseAudioContext,
    url: string,
    startTime: number,
    endTime: number,
  ): Promise<AudioBuffer> {
    const MP4Box = MP4BoxLib;
    const fileSize = await fetchContentLength(url);

    // We need to stream data into MP4Box to get info + samples
    const mp4 = MP4Box.createFile();

    const info = await new Promise<MP4Info>((resolve, reject) => {
      mp4.onReady = resolve;
      mp4.onError = reject;

      // We'll feed data in chunks
      this.streamToMP4Box(mp4, url, fileSize).catch(reject);
    });

    const audioTrack = info.tracks.find((t) => t.type === 'audio');
    if (!audioTrack) throw new Error('No audio track found in MP4');

    const sampleRate = audioTrack.audio!.sample_rate;
    const timescale = audioTrack.timescale;

    // Collect samples in the time range
    const samples = await new Promise<MP4Sample[]>((resolve, _reject) => {
      const collected: MP4Sample[] = [];
      mp4.onSamples = (_id, _user, samps) => {
        collected.push(...samps);
      };
      mp4.setExtractionOptions(audioTrack.id, null, { nbSamples: audioTrack.nb_samples });
      mp4.start();
      mp4.flush();

      // Give mp4box a moment to process
      setTimeout(() => resolve(collected), 100);
    });

    if (samples.length === 0) {
      throw new Error('No audio samples extracted from MP4');
    }

    // Map startTime/endTime to sample indices
    const startTimescale = startTime * timescale;
    const endTimescale = endTime * timescale;

    // Find first and last sample within range
    // Add some extra samples before for decoder priming
    let firstIdx = 0;
    let lastIdx = samples.length - 1;

    for (let i = 0; i < samples.length; i++) {
      if (samples[i].cts + samples[i].duration > startTimescale) {
        firstIdx = Math.max(0, i - 1); // one extra for priming
        break;
      }
    }
    for (let i = samples.length - 1; i >= 0; i--) {
      if (samples[i].cts < endTimescale) {
        lastIdx = Math.min(samples.length - 1, i + 1); // one extra at end
        break;
      }
    }

    // Get decoder config from first sample description
    const firstSample = samples[0];
    const aacConfig = firstSample.description?.aacDecoderConfigDescriptor;
    const audioObjectType = aacConfig?.audioObjectType ?? 2; // AAC-LC
    const samplingFreqIndex = aacConfig?.samplingFrequencyIndex ?? getSamplingFrequencyIndex(sampleRate);
    const channelConfig = aacConfig?.channelConfiguration ?? audioTrack.audio!.channel_count;

    // Build ADTS stream from samples
    const adtsChunks: Uint8Array[] = [];
    for (let i = firstIdx; i <= lastIdx; i++) {
      const sample = samples[i];
      const rawData = new Uint8Array(sample.data);
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

    // Concatenate all ADTS frames
    const totalLen = adtsChunks.reduce((acc, c) => acc + c.length, 0);
    const adtsStream = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of adtsChunks) {
      adtsStream.set(chunk, offset);
      offset += chunk.length;
    }

    // Decode
    const decoded = await ctx.decodeAudioData(adtsStream.buffer.slice(0));

    // Calculate trim in samples
    // The first sample in our extracted range starts at samples[firstIdx].cts
    const rangeStartTime = samples[firstIdx].cts / timescale;
    const trimStartSeconds = startTime - rangeStartTime;
    const trimStartSamples = Math.round(trimStartSeconds * sampleRate);
    const wantedSamples = Math.round((endTime - startTime) * sampleRate);

    const startSample = Math.max(0, trimStartSamples);
    const endSample = Math.min(decoded.length, startSample + wantedSamples);

    return trimBySamples(ctx, decoded, startSample, endSample);
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  private async loadMoov(url: string): Promise<{ info: MP4Info; audioTrack: MP4Track }> {
    const MP4Box = MP4BoxLib;
    const mp4 = MP4Box.createFile();
    const fileSize = await fetchContentLength(url);

    const info = await new Promise<MP4Info>((resolve, reject) => {
      mp4.onReady = resolve;
      mp4.onError = reject;
      this.streamToMP4Box(mp4, url, fileSize).catch(reject);
    });

    const audioTrack = info.tracks.find((t) => t.type === 'audio');
    if (!audioTrack) throw new Error('No audio track found in MP4');

    return { info, audioTrack };
  }

  private async streamToMP4Box(
    mp4: MP4BoxFile,
    url: string,
    fileSize: number | null,
  ): Promise<void> {
    const chunkSize = 256 * 1024;
    const totalSize = fileSize ?? 10 * 1024 * 1024; // fallback 10MB
    let offset = 0;

    while (offset < totalSize) {
      const end = Math.min(offset + chunkSize - 1, totalSize - 1);
      const data = await fetchRange(url, offset, end);
      const ab = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer & { fileStart?: number };
      ab.fileStart = offset;
      mp4.appendBuffer(ab);

      offset = end + 1;

      // Check if we have enough info - mp4box will call onReady
      // For large files, we may need to stop early once we have what we need
      if (offset > 2 * 1024 * 1024 && offset < totalSize - chunkSize) {
        // For the moov-at-end case, try the tail
        break;
      }
    }

    // If moov is at the end, fetch the tail
    if (fileSize && offset < fileSize) {
      const tailStart = Math.max(offset, fileSize - 2 * 1024 * 1024);
      const tailData = await fetchRange(url, tailStart, fileSize - 1);
      const ab = tailData.buffer.slice(
        tailData.byteOffset,
        tailData.byteOffset + tailData.byteLength,
      ) as ArrayBuffer & { fileStart?: number };
      ab.fileStart = tailStart;
      mp4.appendBuffer(ab);
    }

    mp4.flush();
  }
}
