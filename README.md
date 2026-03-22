# audio-snip

Decode a segment of a remote audio file via HTTP Range requests — without downloading the whole thing.

A 50 MB podcast, but you only need seconds 30–60? `audio-snip` fetches ~500 KB instead of 50 MB.

## Demo

[Live demo](https://stepancar.github.io/audio-snip/) — pick a test file, choose a time range, see exactly which byte ranges were fetched.

## Before / After

### Before — vanilla fetch + AudioContext

You have to download the **entire file**, then decode, then slice:

```ts
const resp = await fetch(url);               // downloads all 50 MB
const buf = await resp.arrayBuffer();
const full = await audioCtx.decodeAudioData(buf);

// manual trimming
const start = Math.round(30 * full.sampleRate);
const end = Math.round(60 * full.sampleRate);
const trimmed = audioCtx.createBuffer(full.numberOfChannels, end - start, full.sampleRate);
for (let ch = 0; ch < full.numberOfChannels; ch++) {
  trimmed.copyToChannel(full.getChannelData(ch).subarray(start, end), ch);
}
```

### After — audio-snip

```ts
import { audioSnip } from 'audio-snip';
import { Mp3Plugin } from 'audio-snip/mp3';
import { Mp4Plugin } from 'audio-snip/mp4';

audioSnip.register(new Mp3Plugin());
audioSnip.register(new Mp4Plugin());

const buffer = await audioSnip.decodeAudioDataSegment(audioCtx, url, 30, 60);
// AudioBuffer with exactly 30 seconds of audio
// only a few hundred KB were fetched
```

## How it works

1. Fetch file header (first ~128 KB) to parse codec metadata
2. Use metadata (Xing TOC for MP3, stbl tables for MP4) to map time → byte offset
3. Fetch only the needed byte range via HTTP `Range` request
4. Decode and trim to exact sample boundaries

## Supported formats

| Format | Plugin | Notes |
|--------|--------|-------|
| MP3 CBR/VBR | `Mp3Plugin` | Xing/VBRI TOC, LAME gapless, ID3v2 |
| M4A/MP4/AAC | `Mp4Plugin` | Uses mp4box.js, ADTS wrapping, video+audio files |

## Install

```sh
npm install audio-snip
```

## License

MIT
