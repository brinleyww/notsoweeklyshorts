// Typed access to the game. main.bundle.js builds all of it (cupNative and window.__nswsCup).

export interface Controls {
  up: boolean;
  right: boolean;
  down: boolean;
  left: boolean;
}
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}
export interface Quat extends Vec3 {
  w: number;
}
export interface CarState {
  frames: number;
  speedKmh: number;
  hasStarted: boolean;
  finishFrames: number | null;
  nextCheckpointIndex: number;
  hasCheckpointToRespawnAt: boolean;
  position: Vec3;
  quaternion: Quat;
  collisionImpulses: number[];
  wheelContact: ({ position: Vec3; normal: Vec3 } | null)[];
  wheelSuspensionLength: number[];
  wheelSuspensionVelocity: number[];
  wheelDeltaRotation: number[];
  wheelSkidInfo: number[];
  steering: number;
  brakeLightEnabled: boolean;
  controls: Controls & { reset: boolean };
}
export interface Car {
  getTime(): { numberOfFrames: number };
  getFinishTime(): { numberOfFrames: number } | null;
  getNextCheckpointIndex(): number;
  getSpeedKmh(): number;
  getRecording(): { serialize(): string } | null;
  getCarState(): CarState;
  setCarState(state: CarState, reset: boolean): void;
  hasStarted(): boolean;
  hasFinished(): boolean;
  addCheckpointCallback(cb: (index: number) => void): void;
  addFinishCallback(cb: () => void): void;
  start(): void;
}
export interface TrackMeta {
  name: string;
  author?: string;
}
export interface TrackData {
  getId(): string;
  hasStartingPoint(): boolean;
}
export interface LobbyPlayer {
  id: number;
  nickname: string;
  countryCode?: string | null;
  carStyle?: { serialize(): string } | string;
  isSelf: boolean;
}
export type CarUpdate = (session: number, id: number, resets: number, state: CarState) => void;
export interface Connection {
  dispose(): void;
  getPlayers(): LobbyPlayer[];
  getPing(id: number): number | null;
  kickPlayer?(id: number): void;
  getInvite?(): { inviteCode: string } | null;
  requestInvite?(): void;
  renewInvite?(): void;
  getInviteIsLoading?(): boolean;
  startNewSession?(mode: number, meta: TrackMeta, data: TrackData): void;
  reportCupStatus?(status: unknown): void;
  addCarUpdateCallback(cb: CarUpdate): void;
  removeCarUpdateCallback(cb: CarUpdate): void;
  addCarResetCallback(cb: (session: number, id: number, resets: number) => void): void;
  addNewSessionCallback(session: number | null, cb: (session: number, mode: number, meta: TrackMeta, data: TrackData) => void): void;
  removeNewSessionCallback(cb: unknown): void;
}
export type Game = object;
export interface GameInfo {
  connection: Connection | undefined;
  sessionId: number | undefined;
  trackData: TrackData;
  metadata: TrackMeta;
  car: Car;
  spectator: { isEnabled: boolean };
  disposed: boolean;
  checkpointCount: number;
}
export interface Bindings {
  up: (string | null)[];
  right: (string | null)[];
  down: (string | null)[];
  left: (string | null)[];
}
export interface LoadedTrack {
  trackData: TrackData;
  trackMetadata: TrackMeta;
}
export interface Native {
  Host: abstract new (...args: never[]) => Connection;
  Client: abstract new (...args: never[]) => Connection;
  trackLibrary: {
    forEachTrack(
      cb: (id: string, meta: TrackMeta, category: string, env: unknown, load: () => Promise<LoadedTrack>, thumb: Promise<string> | string) => void,
    ): void;
  };
  onFrame(fn: ((game: Game, dt: number) => void) | null): void;
  // Missing on a page that loaded the game before they existed.
  onCars?(fn: ((game: Game, dt: number) => void) | null): void;
  lerpCarState?(a: CarState, b: CarState, t: number): CarState;
  read(g: Game): GameInfo;
  presentation(g: Game, cup: boolean, watching: boolean): void;
  leaderboardUploads(g: Game, enabled?: boolean): void;
  carThumbnail(style: unknown): Promise<string>;
  worldRecord(id: string, verified: boolean): Promise<number | null>;
  personalBest(id: string): number | null;
  clearInput(g: Game): void;
  drivingBindings(g: Game): Bindings;
  applyDrivingInput(g: Game, c: Controls): void;
  remoteCar(g: Game, id: number): Car | undefined;
  followCar(g: Game, id: number, cockpit: boolean, dt: number): boolean;
  autoSpectate(): boolean;
  restartPressed(g: Game, e: KeyboardEvent): boolean;
  startRespawnPressed(g: Game, e: KeyboardEvent): boolean;
  freecamPressed(g: Game, e: KeyboardEvent): boolean;
  enterFreecam(g: Game): void;
  showRoundTime(g: Game, frames: number): void;
  showRoundCheckpoint(g: Game, frames: number): void;
  showRoundFinish(g: Game, frames: number): void;
  visibility(g: Game, ids: number[] | null, self: number | null): void;
  drivingView(g: Game): 0 | 1;
  release(g: Game, view?: 0 | 1): void;
  peers(c: Connection): { id: number; pc: RTCPeerConnection }[];
  pruneClosedPeers(c: Connection): void;
  parse(code: string): LoadedTrack | null;
  reset(g: Game): void;
  clearRecords(c: Connection): void;
  guard(fn: (g: Game) => boolean): void;
  guardRestart(fn: (g: Game) => boolean): void;
  inviteError(c: Connection): string | null;
  verifyRun(g: Game, recording: string, frames: number): Promise<boolean | null>;
  collisions(g: Game, ids: number[] | null): void;
  // A hit's frame `at` is on the other car's own clock.
  bumps(g: Game): { id: number; impulse: number[]; at?: number }[];
  bump(g: Game, impulse: number[]): void;
  sound(name: 'tick' | 'go' | 'record' | 'checkpoint' | 'finish'): void;
  saveClip(run: { recording: string; frames: number; trackId: string; carStyle: string; nickname: string; name: string }): Promise<boolean | 'duplicate'>;
  carStyle(g: Game): string;
  freecamKeys(g: Game): string[];
  restartKeys(g: Game): string[];
  // Bots. Missing on a page that loaded the game before they existed.
  physicsInit?(): unknown;
  trackPayload?(trackData: TrackData): TrackPayload;
  boardRuns?(trackId: string, amount: number): Promise<BoardRun[]>;
  personalBestRun?(trackId: string): { frames: number; recording: string } | null;
  // The game's cars for these bots in session g (created, restyled, or disposed to match), drawn like remote cars.
  bots?(g: Game, list: { id: number; style: string; nickname: string }[]): void;
  botState?(g: Game, id: number, state: CarState, reset: boolean): void;
  // A bot this page's car can hit, as {f, p, q} poses on the bot's clock (now, then next); null leaves it out.
  botKeys?(g: Game, id: number, hitId: number, keys: { f: number; p: number[]; q: number[] }[] | null, reset: number): void;
}
export interface TrackPayload {
  trackData: string;
  mountainVertices: Float32Array;
  mountainOffset: Vec3;
}
export interface BoardRun {
  rank: number;
  nickname: string;
  frames: number;
  recording: string;
}
export interface Bridge {
  Host: new (loc: unknown, api: unknown, maxPlayers: number, profiles: unknown) => Connection & {
    startNewSessionImmediate(mode: number, meta: TrackMeta, data: TrackData): number;
  };
  Client: new (loc: unknown, api: unknown, profiles: unknown, records: unknown) => Connection & {
    joinInvite(code: string, cancel: unknown): Promise<void>;
    addConnectionLostCallback(cb: () => void): void;
    removeConnectionLostCallback(cb: () => void): void;
  };
  GameMode: { Casual: number; Competitive: number };
  CancelToken: new () => { cancel(): void };
  services(): {
    loc: unknown;
    api: unknown;
    profiles: { getCurrentUserProfile(): { nickname: string; carStyle?: unknown } };
    records: unknown;
    tracks: unknown;
  };
  startRace(meta: TrackMeta, data: TrackData, mp: { multiplayerConnection: Connection; sessionId: number; gameMode: number }): void;
  toMenu(): void;
  native(): Native;
}

export interface SiteKeys {
  chat(): string;
  ghosts(): string;
  scoreboard(): string;
  spectatePrevious(): string;
  spectateNext(): string;
  matches(e: KeyboardEvent, binding: string): boolean;
  list(): unknown[];
  format(code: string): string;
  record(cb: (code: string | null) => void): void;
}

// Hidden, or another window has the focus.
export const background = () => document.hidden || !document.hasFocus();

export const site = window as unknown as {
  __nswsCup?: Bridge;
  __nswsApiBase?: string;
  __nswsShareBase?: string;
  __nswsSocket?: typeof WebSocket;
  __nswsCupKeys?: SiteKeys;
  __nswsKeyBindCapturing?: boolean;
  __nswsTicker?: { every(ms: number, fn: () => void): void };
  __nswsMuxPace?: number;
  __nswsMuxQuiet?: boolean;
  __nswsMuxCarsUnseen?: boolean;
  __nswsMuxCar?: { start: number };
  __nswsFanIds?: Map<number, number>;
  __nswsCarClocks?: Map<number, number>;
  __nswsCupDirect?: (from: number, to: number) => boolean;
  __nswsCupRejoin?: { code: string; role: 'racer' | 'spectator'; info: unknown };
  __nswsMuxFlush?: () => void;
  __nswsMuxOutage?: { from: number; until: number };
  __nswsCupJoinCode?: string;
  __nswsCupHostOptions?: unknown;
  __nswsCupPool?: { shorts: boolean; weeks?: number[]; main: string[]; community: string[] };
  __nswsTrackWeekMap?: Record<string, number>;
  __nswsMessageBox?: { show(text: string, button: string, callback: null): void };
  __nswsOwner?: { check(): Promise<boolean>; token(): Promise<string | null> };
  __nswsUIClick?: () => void;
  __nswsLobbyTag?: (trackId: string) => string;
  __nswsCupRoom?: () => { code: string; secret: string | null } | null;
  __nswsCupLeave?: (message: string) => void;
  __nswsCupApp?: unknown;
  __nswsChatIdentity?: { visitorId(): string; nickname(): string; ownerKey(): Promise<string | null> };
};
