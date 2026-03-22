import { describe, it, expect } from 'vitest';
import { fetchRange, fetchContentLength } from '../src/core.js';

// Fixtures served by vitest dev server with Range support

describe('fetchRange', () => {
  it('returns correct byte range', async () => {
    const data = await fetchRange('/test-cbr.mp3', 0, 9);
    expect(data.length).toBe(10);
  });

  it('returns data for Range request in the middle of file', async () => {
    const data = await fetchRange('/test-cbr.mp3', 1000, 1999);
    expect(data.length).toBe(1000);
  });

  it('throws on invalid URL', async () => {
    await expect(fetchRange('/nonexistent-file.mp3', 0, 10)).rejects.toThrow();
  });
});

describe('fetchContentLength', () => {
  it('returns file size for known fixture', async () => {
    const size = await fetchContentLength('/test-cbr.mp3');
    expect(size).toBeGreaterThan(1000000); // 10MB file
  });
});
