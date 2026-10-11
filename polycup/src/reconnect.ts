export interface ProfileIdentity {
  publicKey: string;
  sign(nonce: string): Promise<string>;
}
const encode = (s: string) => new TextEncoder().encode(s);
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const bytes = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const payload = (cupId: string, nonce: string) =>
  encode('PolyCup reconnect proof v1\0' + cupId + '\0' + nonce);
export const validPublicKey = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

// Derive a Cup-specific signing key locally. The native credential never leaves this function.
export async function profileIdentity(token: string, cupId: string): Promise<ProfileIdentity> {
  if (typeof token !== 'string' || !token || !cupId)
    throw new Error('Profile identity unavailable.');
  const seed = await crypto.subtle.digest(
    'SHA-256',
    encode('PolyCup reconnect key v1\0' + cupId + '\0' + token),
  );
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(bytes('302e020100300506032b657004220420'));
  pkcs8.set(new Uint8Array(seed), 16);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return {
    publicKey: jwk.x!,
    sign: async (nonce) => hex(await crypto.subtle.sign('Ed25519', key, payload(cupId, nonce))),
  };
}

export class ReconnectRegistry {
  #cupId = '';
  #owners = new Map<string, number>();
  #peers = new Map<number, string>();
  #pending = new Map<number, { key: string; nonce: string; expires: number }>();
  reset(cupId: string) {
    if (cupId === this.#cupId) return;
    this.#cupId = cupId;
    this.#owners.clear();
    this.#peers.clear();
    this.#pending.clear();
  }
  sync(online: number[], roster: number[]) {
    for (const id of this.#peers.keys()) if (!online.includes(id)) this.#peers.delete(id);
    for (const id of this.#pending.keys()) if (!online.includes(id)) this.#pending.delete(id);
    for (const [key, id] of this.#owners) if (!roster.includes(id)) this.#owners.delete(key);
    for (const [id, key] of this.#peers) {
      if (roster.includes(id) && !this.#owners.has(key) && ![...this.#owners.values()].includes(id))
        this.#owners.set(key, id);
    }
  }
  verified(id: number, key: string) {
    return this.#peers.get(id) === key;
  }
  challenge(id: number, key: string) {
    if (!validPublicKey(key) || !this.#cupId) return null;
    const existing = this.#pending.get(id);
    if (existing && existing.key === key && existing.expires > Date.now()) return existing.nonce;
    const nonce = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
    this.#pending.set(id, { key, nonce, expires: Date.now() + 15000 });
    return nonce;
  }
  async prove(id: number, nonce: string, signature: string) {
    const pending = this.#pending.get(id),
      cupId = this.#cupId;
    if (
      !pending ||
      pending.nonce !== nonce ||
      pending.expires < Date.now() ||
      !/^[a-f0-9]{128}$/.test(signature)
    )
      return false;
    this.#pending.delete(id);
    try {
      const key = await crypto.subtle.importKey(
        'jwk',
        { kty: 'OKP', crv: 'Ed25519', x: pending.key },
        'Ed25519',
        false,
        ['verify'],
      );
      const valid = await crypto.subtle.verify(
        'Ed25519',
        key,
        bytes(signature),
        payload(cupId, nonce),
      );
      if (!valid || this.#cupId !== cupId) return false;
      this.#peers.set(id, pending.key);
      return true;
    } catch {
      return false;
    }
  }
  owner(id: number) {
    const key = this.#peers.get(id);
    return key ? (this.#owners.get(key) ?? null) : null;
  }
  key(id: number) {
    return this.#peers.get(id);
  }
  ownerKey(id: number) {
    return [...this.#owners].find(([, owner]) => owner === id)?.[0];
  }
  authenticated(id: number) {
    return this.#peers.has(id);
  }
  rebind(oldId: number, newId: number) {
    for (const [key, id] of this.#owners) if (id === oldId) this.#owners.delete(key);
    const key = this.#peers.get(newId);
    if (key) this.#owners.set(key, newId);
  }
}
