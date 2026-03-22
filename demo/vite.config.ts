import { defineConfig } from 'vite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '../tests/fixtures');

export default defineConfig({
  root: __dirname,
  base: '/audio-snip/',
  build: {
    outDir: '../dist-demo',
    emptyOutDir: true,
  },
  plugins: [
    {
      name: 'copy-static-assets',
      // Dev: serve fixtures at /fixtures/*
      configureServer(server) {
        server.middlewares.use('/fixtures', (req, res, next) => {
          if (!req.url) return next();
          const filePath = path.join(fixturesDir, decodeURIComponent(req.url.split('?')[0]));
          if (!fs.existsSync(filePath)) return next();
          const stat = fs.statSync(filePath);

          // Support Range requests
          const range = req.headers.range;
          if (range) {
            const match = range.match(/bytes=(\d+)-(\d*)/);
            if (match) {
              const start = parseInt(match[1], 10);
              const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
              res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': end - start + 1,
                'Content-Type': 'audio/mpeg',
              });
              fs.createReadStream(filePath, { start, end }).pipe(res);
              return;
            }
          }

          res.writeHead(200, {
            'Content-Length': stat.size,
            'Accept-Ranges': 'bytes',
            'Content-Type': 'audio/mpeg',
          });
          fs.createReadStream(filePath).pipe(res);
        });
      },
      // Build: copy sw.js and fixtures into output
      writeBundle() {
        fs.copyFileSync(
          path.resolve(__dirname, 'sw.js'),
          path.resolve(__dirname, '../dist-demo/sw.js'),
        );
        const outFixtures = path.resolve(__dirname, '../dist-demo/fixtures');
        fs.mkdirSync(outFixtures, { recursive: true });
        for (const f of fs.readdirSync(fixturesDir)) {
          if (f.startsWith('.')) continue;
          fs.copyFileSync(
            path.join(fixturesDir, f),
            path.join(outFixtures, f),
          );
        }
      },
    },
  ],
});
