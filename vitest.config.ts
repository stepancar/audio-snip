import { defineConfig, Plugin } from 'vite';
import path from 'path';
import fs from 'fs';

/**
 * Vite plugin that adds HTTP Range request support for static files.
 * Required so tests can exercise the same Range-based fetch logic
 * that the library uses in production.
 */
function rangeRequestPlugin(): Plugin {
  let publicDir: string;

  return {
    name: 'range-request-support',
    configResolved(config) {
      publicDir = config.publicDir;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const range = req.headers.range;
        if (!range || !req.url) return next();

        // Resolve file path within publicDir
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        const filePath = path.join(publicDir, urlPath);

        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
          return next();
        }

        const stat = fs.statSync(filePath);
        const total = stat.size;
        const match = range.match(/bytes=(\d+)-(\d*)/);
        if (!match) return next();

        const start = parseInt(match[1], 10);
        const end = match[2] ? parseInt(match[2], 10) : total - 1;

        if (start >= total || end >= total) {
          res.writeHead(416, { 'Content-Range': `bytes */${total}` });
          res.end();
          return;
        }

        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'application/octet-stream',
        });

        const stream = fs.createReadStream(filePath, { start, end });
        stream.pipe(res);
      });
    },
  };
}

export default defineConfig({
  publicDir: path.resolve(import.meta.dirname!, 'tests/fixtures'),
  plugins: [rangeRequestPlugin()],
  test: {
    browser: {
      enabled: true,
      name: 'chromium',
      provider: 'playwright',
    },
  },
});
