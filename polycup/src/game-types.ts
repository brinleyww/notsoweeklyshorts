import type { CameraPose, CameraView, DrivingControls, RaceRecord } from './types.ts';
export interface CarStyle {
  serialize(): string;
}
export interface NativeVector {
  toArray(): number[];
  fromArray(values: number[]): NativeVector;
  clone(): NativeVector;
}
export interface NativeCar {
  getPosition(): NativeVector;
  getQuaternion(): NativeVector;
  update(delta: number): void;
  getTime(): { numberOfFrames: number };
  getFinishTime(): { numberOfFrames: number } | null;
  getNextCheckpointIndex(): number;
  addCheckpointCallback(callback: (index: number) => void): void;
  addFinishCallback(callback: () => void): void;
  start(): void;
}
export interface TrackMetadata {
  name: string;
  author?: string;
}
export interface TrackData {
  getId(): string;
  hasStartingPoint(): boolean;
  toExportString(metadata: TrackMetadata): string;
}
export interface LoadedTrack {
  trackData: TrackData;
  trackMetadata: TrackMetadata;
  code?: string;
}
export interface LibraryTrack {
  id: string;
  name: string;
  author?: string;
  category: string;
  thumbnail: Promise<string> | string;
  load: () => Promise<LoadedTrack>;
}
export interface LobbyPlayer {
  id: number;
  nickname: string;
  countryCode?: string | null;
  isSelf: boolean;
  carStyle?: CarStyle;
}
export interface NativeConnection {
  dispose(): void;
  getPlayers(): LobbyPlayer[];
  getPing?(id: number): number | null;
  kickPlayer?(id: number): void;
  isInviteAllowed(): boolean;
  getInviteIsLoading(): boolean;
  getInvite(): {
    inviteCode: string;
    timeoutMilliseconds: number | null;
    timeoutStart: number;
  } | null;
  requestInvite(): void;
  renewInvite(): void;
  startNewSession(mode: number, metadata: TrackMetadata, data: TrackData): void;
}
export interface NativeGame {
  update(...args: unknown[]): unknown;
  dispose(...args: unknown[]): unknown;
}
export interface GameInfo {
  connection: NativeConnection;
  sessionId: number;
  trackData: TrackData;
  metadata: TrackMetadata;
  car: NativeCar;
  spectator: { isEnabled: boolean };
  disposed: boolean;
  checkpointCount: number;
}
export interface InputVisualizer {
  element: HTMLElement;
  update(controls: DrivingControls): void;
  dispose(): void;
}
export interface TrackLibrary {
  forEachTrack(
    callback: (
      id: string,
      metadata: TrackMetadata,
      category: string,
      environment: unknown,
      load: () => Promise<LoadedTrack>,
      thumbnail: Promise<string>,
    ) => void,
  ): void;
  isOfficialTrack(id: string): boolean;
  isCommunityTrack(id: string): boolean;
}
export interface NativeApi {
  watchGames(callback: (sessions: WeakMap<NativeGame, unknown>) => void): void;
  pruneClosedPeers(connection: NativeConnection): void;
  reconnectIdentity(
    game: NativeGame,
    cupId: string,
  ): Promise<import('./reconnect.ts').ProfileIdentity>;
  Host: abstract new (...args: never[]) => NativeConnection;
  Client: abstract new (...args: never[]) => NativeConnection;
  Game: { prototype: NativeGame };
  TrackLibrary: { prototype: Record<string, (...args: unknown[]) => unknown> };
  trackLibrary?: TrackLibrary;
  read(game: NativeGame): GameInfo;
  renderer(game: NativeGame): { update: (...args: unknown[]) => unknown };
  enableCupSpectator(game: NativeGame): void;
  hudElement(game: NativeGame): HTMLElement | null;
  presentation(game: NativeGame, cup: boolean, watching: boolean): void;
  leaderboardUploads(game: NativeGame, enabled?: boolean): void;
  carThumbnail(style: CarStyle): Promise<string>;
  readInputs(game: NativeGame): { frames: number; controls: DrivingControls };
  watchInputs(game: NativeGame, callback: () => void): () => void;
  createInputVisualizer(parent: HTMLElement): InputVisualizer;
  clearInput(game: NativeGame): void;
  camera(game: NativeGame): Omit<CameraPose, 'at'>;
  remoteCar(game: NativeGame, id: number): NativeCar | undefined;
  chatKeys?(game: NativeGame): string[];
  ghostKeys(game: NativeGame): string[];
  autoSpectate(game: NativeGame): boolean;
  restartPressed(game: NativeGame, event: KeyboardEvent): boolean;
  freecamPressed?(game: NativeGame, event: KeyboardEvent): boolean;
  enterFreecam?(game: NativeGame): void;
  startRespawnPressed(game: NativeGame, event: KeyboardEvent): boolean;
  showRoundTime(game: NativeGame, frames: number): void;
  showRoundCheckpoint(game: NativeGame, frames: number): void;
  showRoundFinish(game: NativeGame, frames: number): void;
  drivingBindings(game: NativeGame): import('./held-inputs.ts').DrivingBindings;
  applyDrivingInput(game: NativeGame, controls: DrivingControls): void;
  visibility(game: NativeGame, ids: number[] | null, self: number | null): void;
  drivingView(game: NativeGame): 0 | 1;
  release(game: NativeGame, view?: 0 | 1): void;
  follow(game: NativeGame, pose: CameraView, id: number): void;
  peers(connection: NativeConnection): { id: number; pc: RTCPeerConnection }[];
  parse(code: string): LoadedTrack | null;
  reset(game: NativeGame): void;
  clearRecords(connection: NativeConnection): void;
  guard(fn: (game: NativeGame) => boolean): void;
  guardRestart(fn: (game: NativeGame) => boolean): void;
  personalBest(game: NativeGame, id: string): Promise<RaceRecord>;
  worldRecord(game: NativeGame, id: string): Promise<RaceRecord>;
  records(game: NativeGame): {
    server: {
      getLeaderboardUserEntry(
        token: string,
        id: string,
        verified: boolean,
      ): Promise<{ time: { numberOfFrames: number } } | null>;
      getLeaderboard(
        token: string,
        id: string,
        start: number,
        count: number,
        verified: boolean,
      ): Promise<{
        entries: {
          frames: { numberOfFrames: number };
          nickname: string;
          countryCode?: string | null;
        }[];
      }>;
    };
    profiles: {
      getCurrentUserProfile(): { tokenHash: string; token: string };
      profileSlot: number;
    };
    store: { getRecordTime(slot: number, id: string): { numberOfFrames: number } | null };
  };
}
export interface PolyModLoader {
  getPhysicsWasmURL?: (...args: unknown[]) => string;
  registerClassMixin(
    path: string,
    method: string,
    mixin: { type: unknown; token: string; func: string },
  ): void;
  registerFuncMixin(path: string, mixin: { type: unknown; token: string; func: string }): void;
  polyVersion: string;
  getFromPolyTrack(source: string): unknown;
  registerGlobalMixin(mixin: { type: unknown; token: string; func: string }): void;
  registerSettingCategory(name: string): void;
  registerSetting(label: string, key: string, type: string, value: boolean): void;
  registerBindCategory(name: string): void;
  registerKeybind(
    label: string,
    key: string,
    event: string,
    primary: string,
    secondary: null,
    callback: (event: KeyboardEvent) => void,
  ): void;
}
