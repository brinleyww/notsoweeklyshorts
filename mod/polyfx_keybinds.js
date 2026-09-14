// PolyFX's hotkeys. NSWS doesn't run PolyModLoader, so this listens for the bindings
// the settings menu's "PolyFX" rows save (see POLYFX_KEYBINDS in main.bundle.js).
(function () {
  // Without PolyModLoader, __PolyFX has no GraphicsPreset setting and falls back to Off,
  // which never creates the tuning panel or photo mode, so the hotkeys below would do
  // nothing. Default to Balanced (1), as PML did.
  const fx = window.__PolyFX;
  if (fx) {
    try {
      const stored = localStorage.getItem('_polyfxGraphicsPreset');
      fx.presetOverride = stored != null ? parseInt(stored, 10) : 1;
    } catch (e) {
      fx.presetOverride = 1;
    }
  }
})();

(function () {
  const BINDINGS = {
    panel: { storageKey: '_polyfxPanelKeyBind', defaultCode: 'KeyL' },
    photo: { storageKey: '_polyfxPhotoKeyBind', defaultCode: 'F2' },
    screenshot: { storageKey: '_polyfxScreenshotKeyBind', defaultCode: 'F9' },
  };

  function getCode(binding) {
    try {
      return localStorage.getItem(binding.storageKey) || binding.defaultCode;
    } catch (e) {
      return binding.defaultCode;
    }
  }

  function isTypingTarget() {
    const el = document.activeElement;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  // Bindings can be key combinations ("Shift+KeyL"); main.bundle.js matches them
  // the same way it matches the game's own bindings.
  function matches(e, binding) {
    return window.__nswsKeyBindingMatches ? window.__nswsKeyBindingMatches(e, binding) : e.code === binding;
  }

  window.addEventListener('keydown', (e) => {
    // Don't act on the keypress the settings menu is currently capturing as a new binding.
    if (window.__nswsKeyBindCapturing) return;

    const fx = window.__PolyFX;
    if (!fx) return;

    if (e.code === 'Escape') {
      if (fx.panel && fx.panel.visible) fx.panel.toggle();
      // No preventDefault/return here — let Escape still reach the game's own pause/exit menu.
    }

    if (matches(e, getCode(BINDINGS.panel))) {
      if (e.repeat || isTypingTarget()) return;
      if (!fx.panel) return;
      e.preventDefault();
      fx.panel.toggle();
      return;
    }

    if (matches(e, getCode(BINDINGS.photo))) {
      if (e.repeat || isTypingTarget()) return;
      if (!fx.photo) return;
      e.preventDefault();
      fx.photo.setActive(!fx.photo.active, fx.lastCamera);
      return;
    }

    if (matches(e, getCode(BINDINGS.screenshot))) {
      if (!fx.photo || !fx.photo.active) return;
      e.preventDefault();
      fx.photo.captureQueued = true;
    }
  }, true);

  // .timer-ui only exists while a track is loaded, so its absence covers every way of
  // leaving one, not just Escape.
  setInterval(() => {
    const fx = window.__PolyFX;
    if (!fx || !fx.panel || !fx.panel.visible) return;
    if (!document.querySelector('.timer-ui')) fx.panel.toggle();
  }, 500);
})();
