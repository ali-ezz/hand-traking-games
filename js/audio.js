/*
WebAudio-based Audio Manager
Provides:
 - initOnFirstInteraction()
 - preload(key), preloadAll()
 - playBgm(key, {volume, crossfadeMs})
 - stopBgm({crossfadeMs})
 - playSfx(key, {volume, playbackRate, duck})
 - setMasterVolume(v)
 - ready Promise to await preload completion
Usage:
  window.AUDIO.initOnFirstInteraction();
  window.AUDIO.preloadAll().then(()=>{ ... });
  window.AUDIO.playBgm('bgm_runner_loop');
  window.AUDIO.playSfx('sfx_jump');
Fallback:
  If WebAudio isn't available, falls back to using HTMLAudio via the SimpleAudio helper (if present).
*/
(function(){
  if (window.AudioManager) return;

  const DEFAULT_POOL = 10;
  const DEFAULT_DUCK_MS = 260;
  const DEFAULT_DUCK_FACTOR = 0.38;

  class AudioManager {
    constructor(map = {}) {
      this.map = map;
      this.ctx = null;
      this.buffers = {}; // key -> AudioBuffer
      this.masterGain = null;
      this.bgmGain = null;
      this.sfxGain = null;

      this.bgm = { src: null, gainNode: null, source: null, key: null };
      this.sfxPool = []; // {source, gain, inUse}
      this.poolSize = DEFAULT_POOL;

      this.ready = Promise.resolve();
      this.unlocked = false;

      this.ducking = { active: false, timeoutId: null, factor: DEFAULT_DUCK_FACTOR, ms: DEFAULT_DUCK_MS };
    }

    // Create AudioContext and gain graph on user gesture
    initOnFirstInteraction() {
      if (this.unlocked) return;
      const unlock = async () => {
        try {
          this._createContext();
          // Preload small set lazily; actual assets loaded via preloadAll()
        } catch (e) {
          // ignore
        } finally {
          this.unlocked = true;
          window.removeEventListener('pointerdown', unlock);
          window.removeEventListener('touchstart', unlock);
        }
      };
      window.addEventListener('pointerdown', unlock, { once: true, passive: true });
      window.addEventListener('touchstart', unlock, { once: true, passive: true });
    }

    _createContext() {
      if (this.ctx) return;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return; // no WebAudio
      this.ctx = new Ctx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 1;
      this.bgmGain = this.ctx.createGain();
      this.bgmGain.gain.value = 0.9;
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 1;

      // graph: (bgmGain + sfxGain) -> masterGain -> destination
      this.bgmGain.connect(this.masterGain);
      this.sfxGain.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);

      // init sfx pool
      for (let i = 0; i < this.poolSize; i++) {
        this.sfxPool.push({ source: null, gain: null, inUse: false });
      }
    }

    // Preload and decode an asset
    async preload(key) {
      if (!this.map[key]) return;
      if (this.buffers[key]) return;
      try {
        // If no WebAudio, skip decoding but ensure HTMLAudio can be used via map
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!this.ctx) this._createContext();
        const res = await fetch(this.map[key]);
        const ab = await res.arrayBuffer();
        const buf = await this.ctx.decodeAudioData(ab.slice(0));
        this.buffers[key] = buf;
      } catch (e) {
        // decoding failed; leave fallback to HTMLAudio
      }
    }

    // Preload all assets (returns a promise)
    async preloadAll() {
      const keys = Object.keys(this.map || {});
      const jobs = keys.map(k => this.preload(k));
      this.ready = Promise.all(jobs);
      return this.ready;
    }

    // play background music with optional crossfade
    playBgm(key, opts = {}) {
      const vol = typeof opts.volume === 'number' ? opts.volume : 0.6;
      const crossMs = typeof opts.crossfadeMs === 'number' ? opts.crossfadeMs : 450;

      // Delegate BGM playback to centralized musicController when available.
      try {
        const mc = window.__handNinja && window.__handNinja.musicController;
        const url = this.map && this.map[key];
        const isBgmKey = (key && (key === 'bgm' || key.startsWith('bgm'))) || (url && /bgm/i.test(url));
        // Respect caller's explicit intent to force-start, otherwise allow musicController to
        // decide (e.g. prevent non-admin autoplay). Callers can pass { force: true } when
        // they truly intend to override policy.
        const forceStart = !!(opts && opts.force);
        if (mc && isBgmKey && url) {
          // Ask controller to preload for faster future start; controller will noop if unsupported.
          try { mc.preload && mc.preload(url).catch(()=>{}); } catch(e){}
          // Do not auto-start here; centralized controller manages when playback begins.
          // The helper will only preload the asset for faster future start.
          this._controllerPreloaded = true;
          // In all cases avoid local autoplay; controller manages playback. Return early.
          return;
        }
      } catch (e) {}

      // If WebAudio available and buffer loaded, play using AudioBufferSourceNode
      if (this.ctx && this.buffers[key]) {
        try {
          const now = this.ctx.currentTime;
          const newSource = this.ctx.createBufferSource();
          newSource.buffer = this.buffers[key];
          newSource.loop = true;
          const newGain = this.ctx.createGain();
          newGain.gain.value = 0;
          newSource.connect(newGain);
          newGain.connect(this.bgmGain);

          newSource.start(now);

          // crossfade
          if (this.bgm.source) {
            // fade out old
            this.bgm.gainNode.gain.cancelScheduledValues(now);
            this.bgm.gainNode.gain.setValueAtTime(this.bgm.gainNode.gain.value, now);
            this.bgm.gainNode.gain.linearRampToValueAtTime(0.0001, now + crossMs / 1000);
            // stop after crossfade
            try { this.bgm.source.stop(now + crossMs / 1000 + 0.05); } catch(e){}
          }

          // fade in new
          newGain.gain.setValueAtTime(0.0001, now);
          newGain.gain.linearRampToValueAtTime(vol, now + crossMs / 1000);

          this.bgm = { source: newSource, gainNode: newGain, key: key };
          return;
        } catch (e) {
          // fall through to HTMLAudio fallback
        }
      }

      // Fallback: use HTMLAudio (SimpleAudio if present)
      try {
        if (window._SimpleAudio) {
          if (!this._simple) {
            this._simple = new window._SimpleAudio(this.map);
            this._simple.initOnFirstInteraction();
          }
          this._simple.playBgm(key, vol);
        } else {
          // try native Audio
          if (!this._htmlBgm || this._htmlBgmKey !== key) {
            if (this._htmlBgm) try { this._htmlBgm.pause(); } catch(e){}
            const src = this.map[key];
            if (!src) return;

            // If a centralized musicController exists, prefer handing the URL to it so it can
            // enforce room/admin autoplay policy (e.g. preload-only for non-admins).
              try {
                const mc = window.__handNinja && window.__handNinja.musicController;
                if (mc) {
                  // Preload via centralized controller; do not auto-start playback here.
                  try { mc.preload && mc.preload(src).catch(()=>{}); } catch(e){}
                  // The controller will manage playback/preload; don't create a native Audio here.
                  this._htmlBgm = null;
                  this._htmlBgmKey = key;
                  return;
                }
              } catch (e){}

            const a = new Audio(src);
            a.loop = true;
            a.volume = vol;
            a.play().catch(()=>{});
            this._htmlBgm = a;
            this._htmlBgmKey = key;
          }
        }
      } catch (e) {}
    }

    stopBgm(opts = {}) {
      const crossMs = typeof opts.crossfadeMs === 'number' ? opts.crossfadeMs : 300;

      // Delegate to centralized musicController if present
      try {
        const mc = window.__handNinja && window.__handNinja.musicController;
        if (mc) {
          const forceStop = !!(opts && opts.force);
          // Only ask controller to stop if caller forced it or controller previously started playback.
          if (forceStop || this._controllerStarted) {
            try { mc.stop({ force: forceStop }); } catch(e){}
            this._controllerStarted = false;
          }
          return;
        }
      } catch (e) {}

      if (this.ctx && this.bgm && this.bgm.source) {
        try {
          const now = this.ctx.currentTime;
          this.bgm.gainNode.gain.cancelScheduledValues(now);
          this.bgm.gainNode.gain.setValueAtTime(this.bgm.gainNode.gain.value, now);
          this.bgm.gainNode.gain.linearRampToValueAtTime(0.0001, now + crossMs / 1000);
          try { this.bgm.source.stop(now + crossMs / 1000 + 0.05); } catch(e){}
          this.bgm = { src: null, gainNode: null, source: null, key: null };
          return;
        } catch (e) {}
      }
      // fallback
      try {
        if (this._simple) this._simple.stopBgm();
        if (this._htmlBgm) try { this._htmlBgm.pause(); } catch(e){}
        this._htmlBgm = null;
        this._htmlBgmKey = null;
      } catch (e) {}
    }

    // Play a short SFX. Duck BGM briefly to make action feel 'fat'
    playSfx(key, opts = {}) {
      const volume = typeof opts.volume === 'number' ? opts.volume : 1;
      const playbackRate = typeof opts.playbackRate === 'number' ? opts.playbackRate : 1;
      const duck = opts.duck !== false; // default true

      // Try WebAudio path
      if (this.ctx && this.buffers[key]) {
        try {
          const buf = this.buffers[key];
          const src = this.ctx.createBufferSource();
          src.buffer = buf;
          src.playbackRate.value = playbackRate;

          const g = this.ctx.createGain();
          g.gain.value = volume;
          src.connect(g);
          g.connect(this.sfxGain);

          src.start(0);

          // sfx pooling bookkeeping (not strictly necessary but keeps track)
          // auto cleanup on ended
          src.onended = () => {
            try { src.disconnect(); g.disconnect(); } catch(e){}
          };

          // duck background briefly
          if (duck && this.bgm && this.bgm.gainNode) {
            this._duckBgm();
          }
          return;
        } catch (e) {
          // fall through to fallback
        }
      }

      // Fallback: HTMLAudio
      try {
        const src = this.map[key];
        if (!src) return;
        const a = new Audio(src);
        a.volume = volume;
        a.playbackRate = playbackRate;
        a.play().catch(()=>{});
        if (duck && this._htmlBgm) {
          // lightweight ducking for HTMLAudio: reduce volume then restore
          const oldVol = this._htmlBgm.volume || 1;
          this._htmlBgm.volume = oldVol * DEFAULT_DUCK_FACTOR;
          setTimeout(()=>{ try { this._htmlBgm.volume = oldVol; } catch(e){} }, DEFAULT_DUCK_MS);
        }
      } catch (e) {}
    }

    _duckBgm() {
      if (!this.ctx || !this.bgm || !this.bgm.gainNode) return;
      if (this.ducking.timeoutId) {
        clearTimeout(this.ducking.timeoutId);
      }
      const now = this.ctx.currentTime;
      const g = this.bgm.gainNode.gain;
      const factor = this.ducking.factor;
      const ms = this.ducking.ms;
      try {
        g.cancelScheduledValues(now);
        const cur = g.value || 1;
        g.setValueAtTime(cur, now);
        g.linearRampToValueAtTime(cur * factor, now + 0.02);
        // schedule restore after ms
        this.ducking.timeoutId = setTimeout(() => {
          try {
            const t = this.ctx.currentTime;
            g.cancelScheduledValues(t);
            g.setValueAtTime(g.value, t);
            g.linearRampToValueAtTime(Math.max(0.0001, 0.9), t + 0.08);
          } catch (e) {}
        }, ms);
      } catch (e) {}
    }

    setMasterVolume(v) {
      if (this.ctx && this.masterGain) {
        try { this.masterGain.gain.value = v; } catch(e){}
      } else if (this._simple) {
        // no-op
      }
    }

    // small helper to map action names to assets (can be replaced by game)
    static defaultMap() {
      return {
        // BGMs
        'bgm': 'https://ali-ezz.github.io/hand-traking-games/assets/bgm.mp3',
        'bgm_maze_loop': 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_maze_loop.mp3',
        'bgm_paint_loop': 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_paint_loop.mp3',
        'bgm_runner_loop': 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_runner_loop.mp3',
        'bgm_shape_loop': 'https://ali-ezz.github.io/hand-traking-games/assets/bgm_shape_loop.mp3',

        // SFX
        'sfx_jump': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_jump.mp3',
        'sfx_hit': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_hit.mp3',
        'sfx_point': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_point.mp3',
        'sfx_pop_small': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_pop_small.mp3',
        'sfx_popup': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_popup.mp3',
        'sfx_segment_complete': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_segment_complete.mp3',
        'sfx_shape_complete': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_shape_complete.mp3',
        'sfx_wrong': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_wrong.mp3',
        'sfx_clear': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_clear.mp3',
        'sfx_done': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_done.mp3',
        'sfx_eraser': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_eraser.mp3',
        'sfx_paint_stroke': 'https://ali-ezz.github.io/hand-traking-games/assets/sfx_paint_stroke.mp3',

        // slice / bomb / fruit
        'slice': 'https://ali-ezz.github.io/hand-traking-games/assets/slice.mp3',
        'slice-fruit': 'https://ali-ezz.github.io/hand-traking-games/assets/slice-frute.mp3',
        'bomb': 'https://ali-ezz.github.io/hand-traking-games/assets/bomb.mp3',
        'bomb-frute': 'https://ali-ezz.github.io/hand-traking-games/assets/bomb-frute.mp3'
      };
    }
  }

  // Instantiate with default map if none provided
  const defaultMap = AudioManager.defaultMap();
  window.AudioManager = AudioManager;
  window.AUDIO = new AudioManager(window.AUDIO && window.AUDIO.map ? window.AUDIO.map : defaultMap);
  // keep compatibility with SimpleAudio usage
  if (window._SimpleAudio && !window.AUDIO._simple) {
    try { window.AUDIO._simple = new window._SimpleAudio(defaultMap); } catch(e){}
  }
})();
