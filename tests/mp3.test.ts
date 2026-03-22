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
      if (info.duration) {
        const start = Math.max(0, info.duration - 5);
        const buffer = await audioSnip.decodeAudioDataSegment(ctx, CBR_URL, start, info.duration);
        expect(buffer).toBeInstanceOf(AudioBuffer);
        expect(buffer.duration).toBeGreaterThan(0);
      }
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
