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
      expect(info.duration).not.toBeNull();
      const start = Math.max(0, info.duration! - 5);
      const buffer = await audioSnip.decodeAudioDataSegment(ctx, M4A_URL, start, info.duration!);
      expect(buffer).toBeInstanceOf(AudioBuffer);
      expect(buffer.duration).toBeGreaterThan(0);
    } finally {
      ctx.close();
    }
  }, 60000);
});

describe('Mp4Plugin metadata (bug regression)', () => {
  it('parses encoder delay from M4A', async () => {
    const info = await mp4Plugin.getInfo(M4A_URL);
    // AAC files have encoder delay (edit list or default 2112)
    expect(info.encoderDelay).toBeGreaterThan(0);
  }, 30000);

  it('consecutive segments are seamless (no gap/overlap)', async () => {
    const ctx = new AudioContext();
    try {
      const seg1 = await audioSnip.decodeAudioDataSegment(ctx, M4A_URL, 10, 15);
      const seg2 = await audioSnip.decodeAudioDataSegment(ctx, M4A_URL, 15, 20);
      const totalDuration = seg1.duration + seg2.duration;
      expect(Math.abs(totalDuration - 10)).toBeLessThan(0.1);
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
      expect(info.duration).not.toBeNull();
      const start = Math.max(0, info.duration! - 5);
      const buffer = await audioSnip.decodeAudioDataSegment(ctx, MP4_URL, start, info.duration!);
      expect(buffer).toBeInstanceOf(AudioBuffer);
      expect(buffer.duration).toBeGreaterThan(0);
    } finally {
      ctx.close();
    }
  }, 60000);
});
