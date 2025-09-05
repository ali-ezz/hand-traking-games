// Simple HTTP proxy to inject the ngrok header so the ngrok interstitial is skipped.
//
// Usage:
//   NODE to run:   node proxy.js
//   Custom target: TARGET=http://localhost:3001 PORT=8080 node proxy.js
//
// This proxy forwards all requests to TARGET (default http://localhost:3000)
// and adds the header `ngrok-skip-browser-warning: 1` to upstream requests.
// No external dependencies required.

const http = require('http');
const https = require('https');
const { URL } = require('url');

const TARGET = process.env.TARGET || 'http://localhost:3000';
const PORT = parseInt(process.env.PORT, 10) || 8080;

const targetUrl = new URL(TARGET);
const isTargetHttps = targetUrl.protocol === 'https:';

const server = http.createServer((req, res) => {
  // Build path on target server
  const targetPath = (targetUrl.pathname.replace(/\/$/, '') || '') + req.url;

  const options = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isTargetHttps ? 443 : 80),
    path: targetPath,
    method: req.method,
    headers: Object.assign({}, req.headers, {
      // ensure ngrok shows the real app instead of the interstitial
      'ngrok-skip-browser-warning': '1',
      // set Host to target host to avoid virtual-hosting issues
      host: targetUrl.host
    })
  };

  const proxyReq = (isTargetHttps ? https : http).request(options, (proxyRes) => {
    // Forward status and headers
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    // Stream response body
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad gateway: ' + err.message);
  });

  // Stream request body
  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT}  ->  ${TARGET}`);
  console.log('Run `ngrok http ' + PORT + '` (or point your tunnel to this port).');
});
