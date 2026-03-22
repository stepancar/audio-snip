import { describe, it, expect } from 'vitest';
import { Mp4Plugin } from '../src/plugins/mp4.js';

const mp4Plugin = new Mp4Plugin();

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
