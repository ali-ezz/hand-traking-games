# Cloudflared tunnel — quick steps for remote testing

1) Start the local server (from repo root)
```bash
cd server
npm install
PORT=3000 npm start
```

2) Start a cloudflared quick tunnel (new terminal)
```bash
cd server && cloudflared tunnel --url http://localhost:3000
```
- This prints a public URL (https://XXXXXXXX.trycloudflare.com). Use that URL to test remotely.
- If you see backend timeout errors with quick-tunnel, use a persistent tunnel (requires a Cloudflare account and a domain). Quick troubleshooting: ensure the local server is reachable at http://localhost:3000 and no firewall is blocking.

Optional: persistent tunnel (when you own a domain)
```bash
cloudflared login
cloudflared tunnel create handgames
# create a CNAME/route for your domain per cloudflared docs
cloudflared tunnel run handgames
```

3) Remote test checklist (open the cloudflared URL in browser; use incognito for first-run)
- Tap/click once on the page to trigger the first-user-gesture (this warms camera + resumes AudioContext).
- Start each game and verify:
  - BGM starts immediately and loops (no long first-play delay).
  - Switching games stops previous BGM (no overlap).
  - SFX play instantly on actions.
- DevTools quick checks:
```js
// Audio elements
document.querySelectorAll('audio').forEach(a=>console.log(a.src, a.paused, a.currentTime));

// AudioContext state (if app exposes one)
console.log('AudioContext state', !!window.audioCtx && window.audioCtx.state);

// Measure TTFB for a bgm asset (replace URL)
curl -w 'time_starttransfer:%{time_starttransfer}s\n' -o /dev/null -s https://YOUR_CLOUDFLARED_URL/assets/bgm_maze_loop.mp3
```

Notes
- You do not need the proxy.js workaround for ngrok when using cloudflared — cloudflared doesn’t show the ngrok interstitial.
- If cloudflared quick-tunnel fails repeatedly, either:
  - confirm server is accessible on localhost:3000, or
  - use a persistent tunnel (login + create + run) as shown above.

Task checklist
- [ ] Start server (PORT=3000)
- [ ] Start cloudflared tunnel
- [ ] Perform remote verification (warm gesture + playthrough)
