import type { PolyModLoader } from './game-types.ts';
import { Controller } from './controller.ts';
import { registerCarVisibility } from './native.ts';
import { CupUI } from './ui.ts';
import { registerVersionCheck } from './version-check.ts';
const { PolyMod, MixinType } = (await import(new URL('PolyTypes.js', document.baseURI).href)) as {
  PolyMod: new () => object;
  MixinType: { INSERT: unknown };
};
class PolyCup extends PolyMod {
  #controller!: Controller;
  #ui?: CupUI;

  constructor() {
    super();
    // PolyMod installs own no-op hooks, which would shadow subclass methods.
    for (const hook of ['preInit', 'init', 'postInit', 'onGameLoad'] as const) {
      Object.defineProperty(this, hook, {
        value: PolyCup.prototype[hook].bind(this),
        writable: false,
      });
    }
  }
  preInit(pml: PolyModLoader) {
    registerCarVisibility(pml, MixinType.INSERT);
  }
  init(pml: PolyModLoader) {
    this.#controller = new Controller(() => this.#ui?.render());
    try {
      registerVersionCheck(pml, MixinType.INSERT);
      this.#controller.init(pml);
      pml.registerSettingCategory('PolyCup');
      pml.registerSetting('Spectate after finishing', 'PolyCupAutoSpectate', 'boolean', true);
      pml.registerBindCategory('PolyCup');
      pml.registerKeybind('Open Cup chat', 'PolyCupChat', 'keydown', 'KeyY', null, (event) =>
        this.#ui?.chatHotkey(event),
      );
      pml.registerKeybind(
        "Toggle other players' ghosts",
        'PolyCupToggleGhosts',
        'keydown',
        'KeyG',
        null,
        (event) => this.#ui?.ghostHotkey(event),
      );
    } catch (error) {
      this.#controller.fail(error);
    }
  }
  postInit() {
    if (!this.#ui) this.#ui = new CupUI(this.#controller);
    this.#ui.render();
  }
  onGameLoad() {
    this.postInit();
  }
}
export const polyMod = new PolyCup();
