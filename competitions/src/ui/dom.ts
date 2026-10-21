type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs)
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k in el && typeof v !== 'string') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function setText(el: Element | null | undefined, text: string) {
  if (el && el.textContent !== text) el.textContent = text;
}
export function toggle(el: Element | null | undefined, cls: string, on: boolean) {
  if (el && el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}
export function show(el: HTMLElement | null | undefined, on: boolean) {
  if (el && el.hidden === on) el.hidden = !on;
}

export function fmtTime(frames: number | null | undefined) {
  if (frames == null || !Number.isFinite(frames)) return '--:--.---';
  const ms = Math.max(0, Math.round(frames));
  const m = Math.floor(ms / 60000),
    s = Math.floor((ms % 60000) / 1000),
    r = ms % 1000;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}
export function fmtGap(frames: number | null | undefined) {
  if (frames == null) return '';
  const sign = frames < 0 ? '-' : '+';
  const ms = Math.abs(Math.round(frames));
  return ms >= 60000 ? `${sign}${fmtTime(ms)}` : `${sign}${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}`;
}
export function fmtClock(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60),
    s = total % 60;
  return m ? `${m}:${String(s).padStart(2, '0')}` : `${s}`;
}
export function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'],
    v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
export function flag(cc: string | null | undefined) {
  if (!cc || !/^[a-z]{2}$/i.test(cc)) return '';
  return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0)));
}

const P: Record<string, string> = {
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  cuppa: '<path d="M4 10h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 12h1.5a2.5 2.5 0 0 1 0 5H17M8 3c-.8 1 .8 2 0 3.5M12 3c-.8 1 .8 2 0 3.5"/>',
  flag: '<path d="M5 21V4m0 0h11l-2 4 2 4H5"/>',
  calendar: '<rect x="4" y="5" width="16" height="15" rx="1"/><path d="M4 10h16M9 3v4m6-4v4"/>',
  podium: '<path d="M9 21V9h6v12M3 21v-7h6m6 7v-5h6v5M2 21h20"/>',
  crown: '<path d="m3 8 4 4 5-7 5 7 4-4-2 11H5z"/>',
  skull: '<path d="M12 3a8 8 0 0 0-8 8c0 3 1.5 4.5 3 5.5V20h10v-3.5c1.5-1 3-2.5 3-5.5a8 8 0 0 0-8-8z"/><circle cx="9" cy="11" r="1.6"/><circle cx="15" cy="11" r="1.6"/>',
  stopwatch: '<circle cx="12" cy="14" r="7"/><path d="M12 14V10m-3-7h6m4 4 1.5-1.5"/>',
  burst: '<path d="m12 2 2 6 6-2-3 5 5 3-6 1 1 6-5-4-5 4 1-6-6-1 5-3-3-5 6 2z"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4m-4 1v4m-4 3h8"/>',
  user: '<circle cx="12" cy="7.5" r="4"/><path d="M4 21c0-4.5 3.6-7.5 8-7.5s8 3 8 7.5"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20.5V19a4.5 4.5 0 0 1 4.5-4.5h4a4.5 4.5 0 0 1 4.5 4.5v1.5M15.5 4.6a3.5 3.5 0 0 1 0 6.8M18 14.7a4.5 4.5 0 0 1 3.5 4.3v1.5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9 7 7m10 10 2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  play: '<path d="M7 4v16l13-8z"/>',
  pause: '<path d="M7 4h4v16H7zm6 0h4v16h-4z"/>',
  skip: '<path d="M5 4v16l10-8zm12 0v16"/>',
  restart: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 3v5h5"/>',
  stop: '<rect x="5" y="5" width="14" height="14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  copy: '<rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1m-2 8a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1" transform="translate(1 -1) scale(.9)"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m4 12 5 5L20 6"/>',
  star: '<path d="m12 3 2.8 5.8 6.2.9-4.5 4.4 1 6.3L12 17.5 6.5 20.4l1-6.3L3 9.7l6.2-.9z"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  camera: '<path d="M3 7h4l2-3h6l2 3h4v13H3z"/><circle cx="12" cy="13" r="4"/>',
  video: '<rect x="3" y="6" width="13" height="12"/><path d="m16 10 5-3v10l-5-3"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="1"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  exit: '<path d="M14 4h6v16h-6M10 8l-4 4 4 4M6 12h10"/>',
  megaphone: '<path d="M3 10v4h4l8 5V5L7 10zm15-1a4 4 0 0 1 0 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  clip: '<path d="M4 6h16v12H4z"/><path d="m10 9 5 3-5 3z"/>',
  lock: '<rect x="5" y="11" width="14" height="10"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  flash: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
};
export function icon(name: string, cls = '') {
  const span = document.createElement('span');
  span.className = 'ic ' + cls;
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] ?? ''}</svg>`;
  return span;
}

let sink: (error: unknown) => void = (error) => console.error(error);
export function onUiError(fn: (error: unknown) => void) {
  sink = fn;
}

export function click(fn: () => unknown) {
  return (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    (window as unknown as { __nswsUIClick?: () => void }).__nswsUIClick?.();
    try {
      const r = fn();
      if (r instanceof Promise) r.catch(sink);
    } catch (err) {
      sink(err);
    }
  };
}

// A slider whose track fills up to the thumb while it moves.
export function range(attrs: { min: number; max: number; step?: number; value: number; disabled?: boolean }) {
  const input = h('input', { type: 'range', min: attrs.min, max: attrs.max, step: attrs.step ?? 1, value: String(attrs.value), disabled: !!attrs.disabled }) as HTMLInputElement;
  const paint = () => input.style.setProperty('--fill', `${((Number(input.value) - attrs.min) / Math.max(1e-9, attrs.max - attrs.min)) * 100}%`);
  input.addEventListener('input', paint);
  paint();
  return input;
}

export function confirmBtn(label: string, fn: () => unknown, cls = '', title?: string) {
  let armed = 0;
  const b = btn(label, () => {
    if (Date.now() - armed > 3000) {
      armed = Date.now();
      b.textContent = 'Click again to confirm';
      b.classList.add('danger');
      setTimeout(() => {
        if (Date.now() - armed >= 3000) {
          b.textContent = label;
          if (!cls.includes('danger')) b.classList.remove('danger');
        }
      }, 3000);
      return;
    }
    armed = 0;
    return fn();
  }, cls, title);
  return b;
}

export function btn(label: Child, fn: () => unknown, cls = '', title?: string) {
  return h('button', { class: 'btn ' + cls, type: 'button', title, onclick: click(fn) }, label);
}

export function fill(el: Element, ...children: Child[]) {
  el.replaceChildren();
  append(el, children);
}
