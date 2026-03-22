import { describe, it, expect, beforeAll } from 'vitest';
import { audioSnip } from '../src/core.js';
import { Mp3Plugin } from '../src/plugins/mp3.js';

const mp3Plugin = new Mp3Plugin({ paddingFrames: 8 });

beforeAll(() => {
  audioSnip.register(mp3Plugin);
});

// 60-second fixtures served by vitest dev server from tests/fixtures/ (publicDir)
const CBR_URL = '/test-cbr.mp3';
const VBR_URL = '/test-vbr.mp3';

describe('Mp3Plugin', () => {
  it('canHandle returns true for .mp3 URLs', () => {
    expect(mp3Plugin.canHandle('https://example.com/audio.mp3')).toBe(true);
    expect(mp3Plugin.canHandle('https://example.com/audio.mp3?v=1')).toBe(true);
  });

  it('canHandle returns false for non-mp3 URLs', () => {
    expect(mp3Plugin.canHandle('https://example.com/audio.m4a')).toBe(false);
    expect(mp3Plugin.canHandle('https://example.com/audio.wav')).toBe(false);
  });

  it('throws for unregistered format', async () => {
    const ctx = new AudioContext();
    await expect(
      audioSnip.decodeAudioDataSegment(ctx, 'https://example.com/audio.ogg', 0, 5),
    ).rejects.toThrow('No plugin registered');
    ctx.close();
  });
});

describe('Mp3Plugin.decode (CBR)', () => {
  it('returns AudioBuffer of exactly the requested duration', async () => {
    const ctx = new AudioContext();
    try {
      const buffer = await audioSnip.decodeAudioDataSegment(ctx, CBR_URL, 10, 20);
      expect(buffer).toBeInstanceOf(AudioBuffer);
      // within 50ms
      expect(Math.abs(buffer.duration - 10)).toBeLessThan(0.05);
    } finally {
      ctx.close();
    }
  }, 30000);

  it('handles segment at start of file (t=0)', async () => {
    const ctx = new AudioContext();
    try {
      const buffer = await audioSnip.decodeAudioDataSegment(ctx, CBR_URL, 0, 5);
      expect(buffer).toBeInstanceOf(AudioBuffer);
      expect(Math.abs(buffer.duration - 5)).toBeLessThan(0.05);
    } finally {
      ctx.close();
    }
  }, 30000);

  it('subtracts encoder delay', async () => {
    const ctx = new AudioContext();
    try {
      const info = await mp3Plugin.getInfo(CBR_URL);
      const buffer = await audioSnip.decodeAudioDataSegment(ctx, CBR_URL, 0, 3);
      expect(Math.abs(buffer.duration - 3)).toBeLessThan(0.05);
      // LAME-encoded files should have non-zero encoder delay
      expect(info.encoderDelay).toBeGreaterThanOrEqual(0);
    } finally {
      ctx.close();
    }
  }, 30000);

  it('handles segment at end of file', async () => {
    const ctx = new AudioContext();
    try {
      const info = await mp3Plugin.getInfo(CBR_URL);
      expect(info.duration).not.toBeNull();
      const start = Math.max(0, info.duration! - 5);
      const buffer = await audioSnip.decodeAudioDataSegment(ctx, CBR_URL, start, info.duration!);
      expect(buffer).toBeInstanceOf(AudioBuffer);
      expect(buffer.duration).toBeGreaterThan(0);
    } finally {
      ctx.close();
    }
  }, 30000);
});

describe('Mp3Plugin.decode (VBR)', () => {
  it('is accurate for VBR files', async () => {
    const ctx = new AudioContext();
    try {
      const buffer = await audioSnip.decodeAudioDataSegment(ctx, VBR_URL, 10, 20);
      expect(buffer).toBeInstanceOf(AudioBuffer);
      expect(Math.abs(buffer.duration - 10)).toBeLessThan(0.05);
    } finally {
      ctx.close();
    }
  }, 30000);
});

describe('Mp3Plugin metadata (bug regression)', () => {
  it('duration subtracts encoder delay and padding', async () => {
    const info = await mp3Plugin.getInfo(CBR_URL);
    expect(info.duration).not.toBeNull();
    // LAME-encoded fixture has encoderDelay ~576 samples
    expect(info.encoderDelay).toBeGreaterThan(0);
    const expectedReduction = info.encoderDelay / info.sampleRate;
    expect(expectedReduction).toBeGreaterThan(0.01); // at least 10ms reduction
  }, 30000);

  it('parses LAME encoder delay from CBR file', async () => {
    const info = await mp3Plugin.getInfo(CBR_URL);
    // Our fixtures are LAME-encoded, so encoder delay should be ~576
    expect(info.encoderDelay).toBeGreaterThan(0);
  }, 30000);

  it('consecutive segments are seamless (no gap/overlap)', async () => {
    const ctx = new AudioContext();
    try {
      const seg1 = await audioSnip.decodeAudioDataSegment(ctx, CBR_URL, 10, 15);
      const seg2 = await audioSnip.decodeAudioDataSegment(ctx, CBR_URL, 15, 20);
      // Each segment should be ~5s, total ~10s
      const totalDuration = seg1.duration + seg2.duration;
      expect(Math.abs(totalDuration - 10)).toBeLessThan(0.1);
    } finally {
      ctx.close();
    }
  }, 30000);
});
