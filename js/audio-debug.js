(function () {
  // Lightweight handler for 'bgm:blocked' events - shows the audioDebugPanel and
  // provides a persistent "Enable music" affordance that forces local playback.
  function safe(fn) { try { return fn(); } catch(e) { console.warn('audio-debug error', e); } }

  function onBgmBlocked(ev) {
    safe(() => {
      const panel = document.getElementById('audioDebugPanel');
      if (!panel) return;
      panel.style.display = 'block';

      // Wire close button once
      const closeBtn = document.getElementById('audioDebugCloseBtn');
      if (closeBtn && !closeBtn._audioDebugWired) {
        closeBtn.addEventListener('click', () => { try { panel.style.display = 'none'; } catch(e){} });
        closeBtn._audioDebugWired = true;
      }

      const entries = document.getElementById('audioDebugEntries');
      if (!entries) return;

      const detail = (ev && ev.detail) ? ev.detail : {};
      const url = detail.url || 'bgm';

      const entry = document.createElement('div');
      entry.style.display = 'flex';
      entry.style.justifyContent = 'space-between';
      entry.style.alignItems = 'center';
      entry.style.gap = '8px';
      entry.style.marginTop = '6px';

      const label = document.createElement('div');
      label.textContent = `[${new Date().toLocaleTimeString()}] BGM blocked (${String(url).split('/').pop()})`;
      label.style.fontSize = '12px';
      label.style.flex = '1';
      label.style.marginRight = '8px';
      label.style.overflow = 'hidden';
      label.style.textOverflow = 'ellipsis';
      label.style.whiteSpace = 'nowrap';

      const btn = document.createElement('button');
      btn.textContent = 'Enable music';
      btn.className = 'btn';
      btn.style.flex = '0 0 auto';
      btn.addEventListener('click', function () {
        safe(() => {
          try { localStorage.setItem('hand_ninja_music_enabled', 'true'); } catch(e){}

          // Try to force-start via musicController
          const mc = window.__handNinja && window.__handNinja.musicController;
          if (mc && typeof mc.start === 'function') {
            try { mc.start(url, { force: true, vol: (mc.getState && mc.getState().vol) || 0.7 }).catch(()=>{}); } catch(e){}
          } else {
            // fallback: legacy playSound('bgm') if available
            try { if (typeof playSound === 'function') playSound('bgm'); } catch(e){}
          }

          // hide panel after enabling
          try { panel.style.display = 'none'; } catch(e){}
        });
      }, false);

      entry.appendChild(label);
      entry.appendChild(btn);

      // Insert newest at top
      entries.insertBefore(entry, entries.firstChild);
    });
  }

  // Attach listener as early as possible
  try {
    if (document && typeof document.addEventListener === 'function') {
      document.addEventListener('bgm:blocked', onBgmBlocked, false);
    }
  } catch (e) {
    console.warn('audio-debug: failed to attach bgm:blocked listener', e);
  }

  // Expose a simple helper for manual testing from console
  window.__handNinja = window.__handNinja || {};
  window.__handNinja._audioDebug = {
    simulateBlocked(url) { document.dispatchEvent(new CustomEvent('bgm:blocked', { detail: { url } })); }
  };
})();
