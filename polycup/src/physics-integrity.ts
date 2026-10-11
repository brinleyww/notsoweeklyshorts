import type { PolyModLoader } from './game-types.ts';

// SHA-256 of the unmodified PolyTrack 0.6.3 physics binary.
export const STOCK_PHYSICS = 'd4ef02676973d41afc34b23b5248f6950b35dc4cc7e3047e3a9c6bd88e4c180e';
export interface PhysicsReport {
  hash: string | null;
  driveForce: number | null;
}
export function validPhysicsReport(value: unknown): value is PhysicsReport {
  if (!value || typeof value !== 'object') return false;
  const r = value as PhysicsReport;
  return (
    (r.hash === null || (typeof r.hash === 'string' && /^[a-f0-9]{64}$/.test(r.hash))) &&
    (r.driveForce === null || (typeof r.driveForce === 'number' && Number.isFinite(r.driveForce)))
  );
}
export async function inspectPhysics(bytes: ArrayBuffer): Promise<PhysicsReport> {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const view = new DataView(bytes),
    offset = 0x2f840;
  const force =
    bytes.byteLength >= offset + 5 && view.getUint8(offset) === 0x43
      ? view.getFloat32(offset + 1, true)
      : null;
  return { hash, driveForce: force !== null && Number.isFinite(force) ? force : null };
}
export class PhysicsIntegrity {
  #report: PhysicsReport = { hash: null, driveForce: null };
  #generation = 0;
  get report(): PhysicsReport {
    return { ...this.#report };
  }
  install(pml: PolyModLoader) {
    if (!pml.getPhysicsWasmURL) return;
    const original = pml.getPhysicsWasmURL;
    pml.getPhysicsWasmURL = (...args) => {
      const url = original.apply(pml, args);
      const generation = ++this.#generation;
      this.#report = { hash: null, driveForce: null };
      // Inspect the URL returned for the worker, after all registered PML patches.
      void fetch(url, { signal: AbortSignal.timeout(15000) })
        .then((r) => {
          if (!r.ok) throw new Error('Physics unavailable');
          return r.arrayBuffer();
        })
        .then(inspectPhysics)
        .then((report) => {
          if (generation === this.#generation) this.#report = report;
        })
        .catch(() => {});
      return url;
    };
  }
}
