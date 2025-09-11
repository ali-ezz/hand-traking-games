// JavaScript
// Minimal SimpleAudio helper (quick-fix static path)
// Provides: initOnFirstInteraction(), playBgm(key, vol), stopBgm(), playSfx(key)
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
    playBgm(key, vol = 0.6){
      // Prefer centralized musicController for BGM-like keys/URLs.
      // Call the controller before checking unlocked so non-admins can preload while admins may start playback.
      try {
        const mc = window.__handNinja && window.__handNinja.musicController;
        const url = this.map && this.map[key];
        const isBgmKey = (key && (key === 'bgm' || key.startsWith('bgm'))) || (url && /bgm/i.test(url));
        if (mc && isBgmKey && url) {
          // Ask the controller to start; controller will enforce room/admin policy
          // and may only preload when autoplay is not allowed.
          mc.start(url, { force: false, vol });
          this.bgmKey = key;
          return;
        }
      } catch(e){}
      // If audio system hasn't been unlocked, avoid creating/playing HTMLAudio.
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
    }
    stopBgm(){
      try {
        const mc = window.__handNinja && window.__handNinja.musicController;
        if (mc) { mc.stop({ force: false }); }
      } catch(e){}
      if (this.bgm) try { this.bgm.pause(); } catch(e){}
      this.bgm = null; this.bgmKey = null;
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
