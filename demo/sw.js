// Service Worker: intercepts Range requests and provides Range fallback.
// Adds X-SW-* headers so the main thread can display the full picture:
//   X-SW-Server-Status  — actual HTTP status from origin server (200 or 206)
//   X-SW-Server-Bytes   — bytes downloaded from server
//   X-SW-Client-Bytes   — bytes delivered to client (after slicing)
//   X-SW-File-Size      — total file size (if known)

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const rangeHeader = event.request.headers.get('Range');
  if (!rangeHeader) return;
  event.respondWith(handleRange(event.request, rangeHeader));
});

async function handleRange(req, rangeHeader) {
  const resp = await fetch(req);
  const serverStatus = resp.status;

  // ── Server supports Range (206) — pass through ──
  if (serverStatus === 206) {
    const body = await resp.arrayBuffer();
    const cr = resp.headers.get('Content-Range');
    let fileSize = '';
    if (cr) {
      const m = cr.match(/\/(\d+)/);
      if (m) fileSize = m[1];
    }

    const headers = new Headers(resp.headers);
    headers.set('X-SW-Server-Status', '206');
    headers.set('X-SW-Server-Bytes', String(body.byteLength));
    headers.set('X-SW-Client-Bytes', String(body.byteLength));
    if (fileSize) headers.set('X-SW-File-Size', fileSize);

    return new Response(body, { status: 206, headers });
  }

  // ── Server returned full file (200) — slice it ──
  const fullBody = await resp.arrayBuffer();
  const serverBytes = fullBody.byteLength;

  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) {
    const headers = new Headers();
    headers.set('X-SW-Server-Status', String(serverStatus));
    headers.set('X-SW-Server-Bytes', String(serverBytes));
    headers.set('X-SW-Client-Bytes', String(serverBytes));
    headers.set('X-SW-File-Size', String(serverBytes));
    return new Response(fullBody, { headers });
  }

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : fullBody.byteLength - 1;
  const slice = fullBody.slice(start, end + 1);

  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + fullBody.byteLength,
      'Content-Length': String(slice.byteLength),
      'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream',
      'X-SW-Server-Status': String(serverStatus),
      'X-SW-Server-Bytes': String(serverBytes),
      'X-SW-Client-Bytes': String(slice.byteLength),
      'X-SW-File-Size': String(fullBody.byteLength),
    },
  });
}
