declare module 'mp4box' {
  interface MP4BoxFile {
    onReady: ((info: unknown) => void) | null;
    onError: ((e: Error) => void) | null;
    onSamples: ((id: number, user: unknown, samples: unknown[]) => void) | null;
    appendBuffer(data: ArrayBuffer & { fileStart?: number }): void;
    flush(): void;
    setExtractionOptions(trackId: number, user?: unknown, options?: { nbSamples?: number }): void;
    start(): void;
    seek(time: number, useRap?: boolean): { offset: number; time: number };
    getTrackById(trackId: number): unknown;
  }

  const MP4Box: {
    createFile(): MP4BoxFile;
  };
  export default MP4Box;
}
