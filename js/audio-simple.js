// JavaScript
// Minimal SimpleAudio helper (quick-fix static path)
// Provides: initOnFirstInteraction(), playBgm(key, vol, opts), stopBgm(opts), playSfx(key)
// This version delegates BGM lifecycle to window.__handNinja.musicController when available.
// Fallback friendly — safe to include even if game.js already has a similar inline fallback.
(function(){
  if (window._SimpleAudio) return;
  class SimpleAudio {
    constructor(map){
      this.map = map || {};
      this.buff = {};
      this.unlocked = false;
      this.bgm = null;
      this.bgmKey = null;
      this._controllerStarted = false;
    }
    initOnFirstInteraction(){
      const unlock = () => {
        try {
          Object.entries(this.map).forEach(([k,url])=>{
            try {
              if (!url) return;
              const a = new Audio(url);
              a.preload = 'auto';
              a.addEventListener('error', ()=>{}, { once: true });
              this.buff[k] = a;
            } catch(e){}
          });
        } catch(e){}
        this.unlocked = true;
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('touchstart', unlock);
      };
      window.addEventListener('pointerdown', unlock, { once: true, passive: true });
      window.addEventListener('touchstart', unlock, { once: true, passive: true });
    }
    playBgm(key, vol = 0.6, opts = {}){
      // Prefer centralized musicController for BGM-like keys/URLs.
      // Ask the controller to preload the BGM; only ask it to start when allowed
      // (force === true OR client not in room OR client is admin). Otherwise preload only.
      try {
        const mc = window.__handNinja && window.__handNinja.musicController;
        const url = this.map && this.map[key];
        const isBgmKey = (key && (key === 'bgm' || key.startsWith('bgm'))) || (url && /bgm/i.test(url));
        const forceStart = !!(opts && opts.force);
        if (mc && isBgmKey && url) {
          // Preload for faster later start (controller may noop if unsupported).
          try { mc.preload && mc.preload(url).catch(()=>{}); } catch(e){}
          // Decide if controller should actually start playback now.
          let allowStart = forceStart;
          try {
            const state = (typeof mc.getState === 'function') ? mc.getState() : null;
            const inRoom = state && !!state.inRoom;
            const isAdmin = state && !!state.isAdmin;
            // If not in a room (single-player) or the client is admin, allow immediate start.
            if (!inRoom || isAdmin) allowStart = true;
          } catch(e){}
          if (allowStart) {
            try { mc.start && mc.start(url, { force: forceStart, vol }).catch(()=>{}); } catch(e){}
            this._controllerStarted = true;
          } else {
            this._controllerStarted = false;
          }
          this.bgmKey = key;
          // Do not create local Audio when controller is present.
          return;
        }
      } catch(e){}
      // Fallback: local HTMLAudio looped BGM.
      if (!this.unlocked) return;
      if (this.bgm && this.bgmKey === key) return;
      if (this.bgm){ try { this.bgm.pause(); } catch(e){} this.bgm = null; }
      const src = (this.buff[key] && this.buff[key].src) ? this.buff[key].src : (this.map[key] || null);
      if (!src) return;
      const a = new Audio(src);
      a.loop = true;
      try { a.volume = vol; } catch(e){}
      a.play().catch(()=>{});
      this.bgm = a; this.bgmKey = key;
      this._controllerStarted = false;
    }
    stopBgm(opts = {}){
      const forceStop = !!(opts && opts.force);
      try {
        const mc = window.__handNinja && window.__handNinja.musicController;
        // If controller started the bgm on behalf of this client, delegate stop to it.
        // Also allow forced stop to be delegated regardless of who started it.
        if (mc && (this._controllerStarted || forceStop)) {
          try { mc.stop && mc.stop({ force: forceStop }); } catch(e){}
          this._controllerStarted = false;
        }
      } catch(e){}
      if (this.bgm) try { this.bgm.pause(); } catch(e){}
      this.bgm = null; this.bgmKey = null;
      this._controllerStarted = false;
    }
    playSfx(key, vol = 1){
      if (!this.unlocked) return;
      const src = (this.buff[key] && this.buff[key].src) ? this.buff[key].src : (this.map[key] || null);
      if (!src) return;
      const s = new Audio(src);
      try { s.volume = vol; } catch(e){}
      s.play().catch(()=>{});
    }
  }
  window._SimpleAudio = SimpleAudio;
})();
