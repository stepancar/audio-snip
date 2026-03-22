// Service Worker: intercepts Range requests, logs them to the UI,
// and provides Range fallback for servers that don't support it.

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
  broadcast({ type: 'sw-ready' });
});

self.addEventListener('fetch', (event) => {
  const rangeHeader = event.request.headers.get('Range');
  if (!rangeHeader) return;
  event.respondWith(handleRange(event.request, rangeHeader));
});

async function handleRange(req, rangeHeader) {
  const resp = await fetch(req);

  const entry = {
    type: 'range-request',
    url: shortUrl(req.url),
    requestedRange: rangeHeader,
    status: resp.status,
    responseBytes: 0,
    totalBytes: null,
    rangeSupported: resp.status === 206,
    timestamp: Date.now(),
  };

  // Server supports Range (206)
  if (resp.status === 206) {
    const cr = resp.headers.get('Content-Range');
    if (cr) {
      const m = cr.match(/\/(\d+)/);
      if (m) entry.totalBytes = parseInt(m[1], 10);
    }
    const body = await resp.arrayBuffer();
    entry.responseBytes = body.byteLength;
    broadcast(entry);
    return new Response(body, { status: 206, headers: resp.headers });
  }

  // Server returned full file (200) — slice it ourselves
  const fullBody = await resp.arrayBuffer();
  entry.totalBytes = fullBody.byteLength;

  const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!match) {
    entry.responseBytes = fullBody.byteLength;
    broadcast(entry);
    return new Response(fullBody);
  }

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : fullBody.byteLength - 1;
  const slice = fullBody.slice(start, end + 1);

  entry.responseBytes = slice.byteLength;
  broadcast(entry);

  return new Response(slice, {
    status: 206,
    headers: {
      'Content-Range': 'bytes ' + start + '-' + end + '/' + fullBody.byteLength,
      'Content-Length': String(slice.byteLength),
      'Content-Type': resp.headers.get('Content-Type') || 'application/octet-stream',
    },
  });
}

function shortUrl(url) {
  try {
    const name = new URL(url).pathname.split('/').pop() || url;
    return name.length > 50 ? name.slice(0, 47) + '...' : name;
  } catch {
    return url.slice(0, 50);
  }
}

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const c of clients) c.postMessage(msg);
}
