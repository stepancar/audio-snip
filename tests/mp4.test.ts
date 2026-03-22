import { describe, it, expect, beforeAll } from 'vitest';
import { audioSnip } from '../src/core.js';
import { Mp4Plugin } from '../src/plugins/mp4.js';

const mp4Plugin = new Mp4Plugin();

beforeAll(() => {
  audioSnip.register(mp4Plugin);
});

const M4A_URL = '/test.m4a';
const MP4_URL = '/test.mp4';

describe('Mp4Plugin', () => {
  it('canHandle returns true for .m4a URLs', () => {
    expect(mp4Plugin.canHandle('https://example.com/audio.m4a')).toBe(true);
  });

  it('canHandle returns true for .mp4 URLs', () => {
    expect(mp4Plugin.canHandle('https://example.com/video.mp4')).toBe(true);
  });

  it('canHandle returns false for .mp3 URLs', () => {
    expect(mp4Plugin.canHandle('https://example.com/audio.mp3')).toBe(false);
  });

  it('canHandle returns true for .aac URLs', () => {
    expect(mp4Plugin.canHandle('https://example.com/audio.aac')).toBe(true);
  });

  it('canHandle returns true for .m4b URLs', () => {
    expect(mp4Plugin.canHandle('https://example.com/book.m4b')).toBe(true);
  });
});

describe('Mp4Plugin.decode (M4A - audio only)', () => {
  it('returns AudioBuffer of the requested duration', async () => {
    const ctx = new AudioContext();
    try {
      const buffer = await audioSnip.decodeAudioDataSegment(ctx, M4A_URL, 10, 20);
      expect(buffer).toBeInstanceOf(AudioBuffer);
      expect(Math.abs(buffer.duration - 10)).toBeLessThan(0.05);
    } finally {
      ctx.close();
    }
  }, 60000);

  it('handles segment at start of file (t=0)', async () => {
    const ctx = new AudioContext();
    try {
      const buffer = await audioSnip.decodeAudioDataSegment(ctx, M4A_URL, 0, 5);
      expect(buffer).toBeInstanceOf(AudioBuffer);
      expect(Math.abs(buffer.duration - 5)).toBeLessThan(0.05);
    } finally {
      ctx.close();
    }
  }, 60000);

  it('handles segment at end of file', async () => {
    const ctx = new AudioContext();
    try {
      const info = await mp4Plugin.getInfo(M4A_URL);
      if (info.duration) {
        const start = Math.max(0, info.duration - 5);
        const buffer = await audioSnip.decodeAudioDataSegment(ctx, M4A_URL, start, info.duration);
        expect(buffer).toBeInstanceOf(AudioBuffer);
        expect(buffer.duration).toBeGreaterThan(0);
      }
    } finally {
      ctx.close();
    }
  }, 60000);
});

describe('Mp4Plugin.decode (MP4 - video+audio)', () => {
  it('returns AudioBuffer of the requested duration', async () => {
    const ctx = new AudioContext();
    try {
      const buffer = await audioSnip.decodeAudioDataSegment(ctx, MP4_URL, 10, 20);
      expect(buffer).toBeInstanceOf(AudioBuffer);
      expect(Math.abs(buffer.duration - 10)).toBeLessThan(0.05);
    } finally {
      ctx.close();
    }
  }, 60000);

  it('handles segment at start of file (t=0)', async () => {
    const ctx = new AudioContext();
    try {
      const buffer = await audioSnip.decodeAudioDataSegment(ctx, MP4_URL, 0, 5);
      expect(buffer).toBeInstanceOf(AudioBuffer);
      expect(Math.abs(buffer.duration - 5)).toBeLessThan(0.05);
    } finally {
      ctx.close();
    }
  }, 60000);

  it('handles segment at end of file', async () => {
    const ctx = new AudioContext();
    try {
      const info = await mp4Plugin.getInfo(MP4_URL);
      if (info.duration) {
        const start = Math.max(0, info.duration - 5);
        const buffer = await audioSnip.decodeAudioDataSegment(ctx, MP4_URL, start, info.duration);
        expect(buffer).toBeInstanceOf(AudioBuffer);
        expect(buffer.duration).toBeGreaterThan(0);
      }
    } finally {
      ctx.close();
    }
  }, 60000);
});
