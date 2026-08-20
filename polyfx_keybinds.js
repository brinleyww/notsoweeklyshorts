// Wires up PolyFX's hotkeys natively — ported from PolyFX's main.mod.js pml.registerKeybind()
// calls, which only work through PolyModLoader. NSWS doesn't run PML, so this replaces that
// registration with a plain keydown listener that reads the same rebindable codes the
// "PolyFX" section of the settings menu writes (see main.bundle.js), instead of hardcoding
// KeyL / F2 / F9.
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

  window.addEventListener('keydown', (e) => {
    // Don't act on the keypress the settings menu is currently capturing as a new binding.
    if (window.__polyfxKeyBindCapturing || window.__bwClipKeyBindCapturing || window.__bwVisualFxKeyBindCapturing) return;

    const fx = window.__PolyFX;
    if (!fx) return;

    if (e.code === getCode(BINDINGS.panel)) {
      if (e.repeat || isTypingTarget()) return;
      if (!fx.panel) return;
      e.preventDefault();
      fx.panel.toggle();
      return;
    }

    if (e.code === getCode(BINDINGS.photo)) {
      if (e.repeat || isTypingTarget()) return;
      if (!fx.photo) return;
      e.preventDefault();
      fx.photo.setActive(!fx.photo.active, fx.lastCamera);
      return;
    }

    if (e.code === getCode(BINDINGS.screenshot)) {
      if (!fx.photo || !fx.photo.active) return;
      e.preventDefault();
      fx.photo.captureQueued = true;
    }
  }, true);
})();
