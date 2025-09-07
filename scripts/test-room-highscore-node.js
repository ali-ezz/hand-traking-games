const fs = require('fs');
const path = require('path');
const http = require('http');

(async () => {
  // Lightweight Puppeteer-based runner that serves the repo over HTTP (fixes file:// CORS),
  // injects the browser helper (scripts/test-room-highscore.js) and invokes the test runner.
  //
  // Requirements:
  //   npm i puppeteer
  //
  // Usage:
  //   node scripts/test-room-highscore-node.js
  //
  // Output:
  //   Prints page console logs prefixed with PAGE: so you can see the scenarios and results.

  const puppeteer = require('puppeteer');

  const indexPath = path.resolve(process.cwd(), 'index.html');
  const helperPath = path.resolve(process.cwd(), 'scripts', 'test-room-highscore.js');

  if (!fs.existsSync(indexPath)) {
    console.error('index.html not found at', indexPath);
    process.exit(1);
  }
  if (!fs.existsSync(helperPath)) {
    console.error('test helper not found at', helperPath);
    process.exit(1);
  }

  const helperCode = fs.readFileSync(helperPath, 'utf8');

  // Minimal static file server
  const server = http.createServer((req, res) => {
    try {
      let reqPath = decodeURIComponent(req.url.split('?')[0]);
      if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
      const filePath = path.join(process.cwd(), reqPath);
      if (!filePath.startsWith(process.cwd())) {
        res.statusCode = 403; res.end('Forbidden'); return;
      }
      if (!fs.existsSync(filePath)) {
        res.statusCode = 404; res.end('Not found'); return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const mime = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav'
      }[ext] || 'application/octet-stream';
      res.setHeader('Content-Type', mime);
      fs.createReadStream(filePath).pipe(res);
    } catch (e) {
      res.statusCode = 500; res.end('Server error');
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', err => {
      if (err) return reject(err);
      resolve();
    });
  });
  const port = server.address().port;
  const fileUrl = `http://127.0.0.1:${port}/index.html`;
  console.log('Serving', fileUrl);

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // Relay page console messages to the node console
  page.on('console', msg => {
    try {
      const text = msg.text();
      console.log('PAGE:', text);
    } catch (e) {
      console.log('PAGE: <unserializable console message>');
    }
  });

  page.on('pageerror', err => {
    console.error('PAGE ERROR:', err);
  });

  console.log('Opening', fileUrl);
  await page.goto(fileUrl, { waitUntil: 'load', timeout: 10000 });

  // Inject the helper code into the page context
  await page.evaluate(helperCode);

  // Wait a bit for the page to initialize any globals (game may init on load)
  await new Promise(r => setTimeout(r, 500));

  // Ensure helper is installed
  const hasHelper = await page.evaluate(() => !!(window.__testRoomHighscore && typeof window.__testRoomHighscore.runRoomHighscoreTest === 'function'));
  if (!hasHelper) {
    console.error('Helper not installed on page.');
    await browser.close();
    server.close();
    process.exit(1);
  }

  console.log('Invoking runRoomHighscoreTest() on page; capturing logs...');
  // run the async test runner in page
  await page.evaluate(() => {
    return window.__testRoomHighscore.runRoomHighscoreTest();
  });

  // allow time for final logs to flush
  await new Promise(r => setTimeout(r, 500));

  console.log('Test runner finished. Closing browser and server.');
  await browser.close();
  server.close();
})();
