import { STOCK_PHYSICS, validPhysicsReport, type PhysicsReport } from './physics-integrity.ts';
import type { CameraView } from './types.ts';
import type { LobbyPlayer } from './game-types.ts';
import * as Cup from './cup.ts';
import { banEntries, banTrack, beginBans, picksOpen, resetDraft, rosterOpen } from './draft.ts';
import type {
  GameInfo,
  LibraryTrack,
  LoadedTrack,
  NativeApi,
  NativeCar,
  NativeConnection,
  NativeGame,
  PolyModLoader,
} from './game-types.ts';
import { frameNumber, InputCapture, inputMask, InputTimeline, validInputEvents } from './inputs.ts';
import { connectNative, CupTransport, watchGameSessions } from './native.ts';
import { CheckpointProgress } from './progress.ts';
import type {
  ActionMessage,
  ActionType,
  CheckpointMessage,
  FinishMessage,
  InputViewMessage,
  Message,
  ReadyMessage,
  StateMutation,
  TrackMessage,
} from './protocol.ts';
import { ReviewLog } from './review.ts';
import { ReconnectRegistry, validPublicKey, type ProfileIdentity } from './reconnect.ts';
import { CameraBuffer, validPose } from './spectator.ts';
import { HeldDrivingInputs, isEditing } from './held-inputs.ts';
import { CupChat } from './chat.ts';
import { PendingActions } from './pending-actions.ts';
import { poolAllows, rulesFor, type CupPreset } from './presets.ts';
import { standings, updateLiveMovement } from './standings.ts';
import type {
  CameraPose,
  CupState,
  InputContext,
  InputPacket,
  RaceRecord,
  Round,
} from './types.ts';
import { validPB, validSnapshot, validWR } from './validation.ts';
const RECONNECT_GRACE_MS = 15000;
const LOAD_GRACE_MS = 30000;
// Not So Weekly Shorts: how long racers have to choose the next track, and to confirm a retire.
const TRACK_VOTE_MS = 12000;
const RETIRE_CONFIRM_MS = 2000;
// A round waits this long after it ends for finishes still being replayed.
const VERIFY_WAIT_MS = 10000;
type Ticker = { every(ms: number, fn: () => void): void };
export class Controller {
  #physicsSource: () => PhysicsReport = () => ({ hash: null, driveForce: null });
  #physicsReports = new Map<number, { cupId: string; report: PhysicsReport }>();
  #lastPhysics = 0;
  // Not So Weekly Shorts: physics reports and spectator counts are only sent when they change (or
  // as a slow refresh), since every relayed message costs Cloudflare requests.
  #sentPhysics = '';
  #sentPhysicsAt = 0;
  #sentViewers = new Map<number, { key: string; at: number }>();
  #freecam = false;
  #freecamGame: NativeGame | null = null;
  #viewerCount = 0;
  #viewerRound = '';
  #lastViewers = 0;
  setPhysicsSource(source: () => PhysicsReport) {
    this.#physicsSource = source;
  }
  get physicsWarnings() {
    if (!this.#isHost || !this.#state) return [];
    return this.#state.roster.flatMap((p) => {
      if (!this.#lobby.some((peer) => peer.id === p.id)) return [];
      const entry = this.#physicsReports.get(p.id);
      if (entry?.cupId !== this.#state!.id || !entry.report.hash) return [];
      return entry.report.hash === STOCK_PHYSICS
        ? []
        : [{ id: p.id, driveForce: entry.report.driveForce }];
    });
  }
  get viewerCount() {
    return this.#state?.runtime?.id === this.#viewerRound ? this.#viewerCount : 0;
  }
  syncDiagnostics() {
    const s = this.#state;
    if (!s || this.#selfId === null) return;
    const now = Date.now();
    if (now - this.#lastPhysics >= 3000) {
      const report = this.#physicsSource();
      const key = s.id + JSON.stringify(report);
      if (this.#isHost) this.#physicsReports.set(this.#selfId, { cupId: s.id, report });
      else if (
        (key !== this.#sentPhysics || now - this.#sentPhysicsAt >= 30000) &&
        this.#transport.send(0, { type: 'physics', cupId: s.id, report })
      ) {
        this.#sentPhysics = key;
        this.#sentPhysicsAt = now;
      }
      this.#lastPhysics = now;
    }
    if (!this.#isHost || !s.runtime || now - this.#lastViewers < 1000) return;
    this.#lastViewers = now;
    const counts = new Map<number, number>();
    for (const [viewer, target] of this.#subscriptions) {
      if (
        this.#lobby.some((p) => p.id === viewer) &&
        Cup.mayWatch(s, viewer) &&
        this.watchable().includes(target)
      )
        counts.set(target, (counts.get(target) ?? 0) + 1);
    }
    if (
      this.canSpectate() &&
      !this.#freecam &&
      this.watchId !== null &&
      this.watchable().includes(this.watchId)
    )
      counts.set(this.watchId, (counts.get(this.watchId) ?? 0) + 1);
    for (const id of Cup.racingIds(s)) {
      const count = counts.get(id) ?? 0;
      if (id === this.#selfId) {
        this.#viewerCount = count;
        this.#viewerRound = s.runtime.id;
      } else {
        const key = `${s.runtime.id}:${count}`,
          sent = this.#sentViewers.get(id);
        if (
          (sent?.key !== key || now - sent.at >= 10000) &&
          this.#transport.send(id, { type: 'viewers', cupId: s.id, roundId: s.runtime.id, count })
        )
          this.#sentViewers.set(id, { key, at: now });
      }
    }
  }
  #setupDepartures = new Map<string, string>();
  #enrolling = new Set<number>();
  #resumeRacers = new Set<number>();
  #removingTrack = false;
  #preparingRandom: Promise<void> | null = null;
  get preparingRandom() {
    return !!this.#preparingRandom;
  }
  #actions = new PendingActions();
  #drivingView: 0 | 1 | undefined;
  #cameraRestoredGame: NativeGame | null = null;
  #unavailableSince = new Map<number, number>();
  #pendingReconnects = new Map<number, number>();
  #reconnectPending = false;
  #loadingSince = 0;
  #lastReady = 0;
  get reconnectPending() {
    return this.#reconnectPending;
  }
  #reconnect = new ReconnectRegistry();
  #identity: Promise<ProfileIdentity> | null = null;
  #identityCup = '';
  #lastIdentity = 0;
  get game() {
    return this.#game;
  }
  get info() {
    return this.#info;
  }
  get state() {
    return this.#state;
  }
  get panelRequest() {
    return this.#panelRequest;
  }
  get selfId() {
    return this.#selfId;
  }
  get connection() {
    return this.#connection;
  }
  get lobby() {
    return this.#lobby;
  }
  get watchId() {
    return this.#followingId ?? this.#watchId;
  }
  get startingCup() {
    return this.#startingCup;
  }
  get pendingUpload() {
    return this.#pendingUpload;
  }
  get review() {
    return this.#review;
  }
  get native() {
    return this.#native;
  }
  get hideOtherGhosts() {
    return this.#hideOtherGhosts;
  }
  get isHost() {
    return this.#isHost;
  }
  get hello() {
    return this.#hello;
  }
  get error() {
    return this.#error;
  }
  // Not So Weekly Shorts: a summary for debugging a cup from the console (__nswsCupApp.debug()).
  debugInfo() {
    const run = this.#state?.runtime;
    return {
      host: this.#isHost,
      phase: this.#state?.phase ?? null,
      round: run?.round ?? null,
      roundSession: run?.sessionId ?? null,
      gameSession: this.#info?.sessionId ?? null,
      loadingSession: this.#loadingSession ?? null,
      self: this.#selfId,
      racing: this.#selfId !== null && Cup.racingIds(this.#state).includes(this.#selfId),
      blocked: this.#game ? this.shouldBlock(this.#game) : null,
      auto: this.#auto,
      nextAuto: this.#nextAuto,
      startSoon: this.#startSoon,
      preparing: !!this.#preparingRandom,
      error: this.#error,
    };
  }
  // Not So Weekly Shorts: the organizer has answered this page's hello (it can act in the cup).
  get greeted() {
    return this.#isHost || this.#bestRtt < Infinity;
  }
  get auto() {
    return this.#auto;
  }
  get watchStatus() {
    return this.#watchStatus;
  }
  get transferProgress() {
    return this.#transferProgress;
  }
  get needsRebind() {
    return this.#needsRebind;
  }

  #onChange: () => void;
  #state: CupState | null = null;
  #game: NativeGame | null = null;
  #connection: NativeConnection | null = null;
  #isHost: boolean = false;
  #selfId: number | null = null;
  #lobby: LobbyPlayer[] = [];
  #lobbyReadAt = 0;
  #tracks: Map<string, LoadedTrack> = new Map();
  #hello: Set<number> = new Set();
  #offset: number = 0;
  #bestRtt: number = Infinity;
  #error: string = '';
  #resetKey: string = '';
  #startKey: string = '';
  #hookedCar: NativeCar | null = null;
  #hookedRound: string = '';
  #startedCar: NativeCar | null = null;
  #raceTimeOffset = 0;
  #raceClockRound: string | null = null;
  #readyKey: string = '';
  #lastBroadcast: number = 0;
  #transport: CupTransport;
  #trackUploads: Map<
    number,
    { transferId: string; cupId: string; length: number; data: string; seq: number; until: number }
  > = new Map();
  #pendingUpload: { transferId: string; done: boolean; error: string | null } | null = null;
  #transferProgress: string = '';
  #recordRequests: Map<string, { pending: boolean; until: number }> = new Map();
  #lastRecordPoll: number = 0;
  #startingCup: object | null = null;

  #lastHello: number = 0;
  #auto: boolean = true;
  #cameraTransport: CupTransport;
  #cameraBuffers: Map<number, CameraBuffer> = new Map();
  #subscriptions: Map<number, number> = new Map();
  #handoffSubscriptions: Map<number, number> = new Map();
  #watchId: number | null = null;
  #followingId: number | null = null;
  #lastPose: number = 0;
  #lastSubscribe: number = 0;
  #watchStatus: string = '';
  #watchedPose: CameraPose | null = null;
  #hideOtherGhosts: boolean = false;
  #checkpointProgress: CheckpointProgress = new CheckpointProgress();
  #pendingCheckpoints: Map<number, CheckpointMessage> = new Map();
  #checkpointSender: number | null = null;
  #lastCheckpointSend: number = -Infinity;
  #syncSequence: number = 0;
  #receivedSequence: number = -1;
  #panelRequest: {
    revision: number;
    open: boolean;
    message: string;
  } = { revision: 0, open: false, message: '' };
  #roundViewKey: string = '';
  #review: ReviewLog = new ReviewLog();
  #liveInputs: Map<number, InputTimeline> = new Map();
  #inputSequences: Map<number, number> = new Map();
  #native!: NativeApi;
  #timer: number | undefined;
  #inputGame: NativeGame | null = null;
  #heldDrivingInputs = new HeldDrivingInputs();
  #inputRestoredGame: NativeGame | null = null;
  #inputCapture: InputCapture | null = null;
  #info: GameInfo | null = null;
  #unwatchInputs: (() => void) | undefined;
  #needsRebind: Set<number> = new Set();
  #viewCupId: string | null = null;
  #inputScope: string = '';
  #manualWatchRound: string | null = null;
  #lastWatchPose: CameraView | null = null;
  #filteredCars: boolean = false;
  #followingGame: NativeGame | null = null;
  #nextAuto: number | null = null;
  #loadingSession: number | undefined;
  #sentRevision: number | undefined;
  #chatTyping = false;
  // Not So Weekly Shorts: verified best per racer in a time-attack round, finishes being replayed,
  // the restart key's first press, and the track options of an open track vote.
  #verifiedBest = new Map<string, number>();
  #verifying = new Map<string, number>();
  #verifyStarted = 0;
  #retireArmed = 0;
  #voteEntries = new Map<string, LibraryTrack>();
  #helloCount = 0;
  onRetireWarning?: () => void;
  // Not So Weekly Shorts: the local player's finished runs in this cup, for "Clip my best run".
  #myRuns: {
    cupId: string;
    round: number;
    trackId: string;
    frames: number;
    attempt: number;
    recording: string;
    place: number | null;
  }[] = [];
  rememberRun(run: Round, recording: string, attempt: number, frames: number) {
    const cupId = this.#state!.id;
    const same = this.#myRuns.find((r) => r.cupId === cupId && r.round === run.round && r.trackId === run.trackId);
    if (same && same.frames <= frames) return;
    this.#myRuns = this.#myRuns.filter((r) => r !== same && r.cupId === cupId).slice(-40);
    this.#myRuns.push({ cupId, round: run.round, trackId: run.trackId, frames, attempt, recording, place: null });
  }
  syncMyRuns() {
    const s = this.#state,
      last = s && Cup.currentMatch(s)?.roundsLog.at(-1),
      me = this.#selfId;
    if (!s || !last || me === null || !(me in last.finishes)) return;
    for (const r of this.#myRuns)
      if (r.cupId === s.id && r.round === last.round && r.trackId === last.trackId && r.place === null)
        r.place = 1 + Object.values(last.finishes).filter((f) => f < last.finishes[me]).length;
  }
  get bestRun() {
    this.syncMyRuns();
    const runs = this.#myRuns.filter((r) => r.cupId === this.#state?.id && r.place !== null);
    return runs.reduce<(typeof runs)[number] | null>((best, r) => (!best || r.place! < best.place! || (r.place === best.place && r.round > best.round) ? r : best), null);
  }
  async saveBestRun() {
    const run = this.bestRun,
      game = this.#game;
    if (!run || !game || !this.#native.saveClip) throw new Error('There is no run to save.');
    const track = this.#state?.tracks.find((t) => t.id === run.trackId)?.name ?? 'Cup run';
    return this.#native.saveClip({
      recording: run.recording,
      frames: run.attempt,
      trackId: run.trackId,
      carStyle: this.#native.carStyle?.(game) ?? '',
      nickname: this.#lobby.find((p) => p.isSelf)?.nickname ?? 'Racer',
      name: `${this.#state?.name ?? 'Cup'} · ${track}`.slice(0, 60),
    });
  }
  onBump?: () => void;
  #setNextAuto(at: number | null, shown = true) {
    this.#nextAuto = at;
    const s = this.#state;
    if (!s || !this.#isHost || !shown) return;
    const value = at !== null && s.phase === 'between-rounds' ? at : null;
    if ((s.nextRoundAt ?? null) !== value) {
      s.nextRoundAt = value;
      Cup.touch(s);
    }
  }
  setChatTyping(value: boolean) {
    this.#chatTyping = value;
    if (value) this.clearDrivingInput();
  }
  #chat: CupChat;
  get chat() {
    return this.#chat;
  }

  #onSpectatorInputs?: () => void;
  constructor(onChange: () => void) {
    this.#onChange = onChange;
    this.#chat = new CupChat({
      context: () =>
        this.#state && this.#selfId !== null
          ? { cupId: this.#state.id, host: this.#isHost }
          : null,
      changed: () => this.#onChange(),
    });

    this.#transport = new CupTransport(
      (id, m) => this.receive(id, m),
      () => {
        this.#lastBroadcast = 0;
      },
    );

    this.#cameraTransport = new CupTransport(
      (id, m) => m.type === 'camera' && this.receiveCamera(id, m),
      () => {},
      { channelId: 43, realtime: true },
    );
  }
  get cup(): CupState {
    if (!this.#state) throw new Error('No Cup is active.');
    return this.#state;
  }
  get round(): Round {
    if (!this.cup.runtime) throw new Error('No round is active.');
    return this.cup.runtime;
  }
  get gameInfo(): GameInfo {
    if (!this.#info) throw new Error('No game session is active.');
    return this.#info;
  }
  get activeGame(): NativeGame {
    if (!this.#game) throw new Error('No game is active.');
    return this.#game;
  }
  get localPlayerId(): number | null {
    return this.#selfId;
  }
  ping(id: number) {
    if (!this.#lobby.some((p) => p.id === id)) return null;
    const ping = this.#connection?.getPing?.(id);
    return typeof ping === 'number' && Number.isFinite(ping) && ping >= 0 ? Math.round(ping) : null;
  }
  moveToSpectators(id: number) {
    this.requireHost();
    this.change((state) => Cup.leaveRunningCup(state, id));
    this.#resumeRacers.delete(id);
  }
  kickPlayer(id: number) {
    this.requireHost();
    if (id === this.#selfId || !this.#lobby.some((p) => p.id === id))
      throw new Error('Choose another connected player.');
    if (!this.#connection?.kickPlayer) throw new Error('Lobby kicking is unavailable.');
    const state = this.#state;
    if (state && Cup.player(state, id)) {
      if (state.phase === 'registration') {
        if (!rosterOpen(state)) resetDraft(state);
        Cup.removePlayer(state, id);
        this.pruneTrackData();
      } else if (state.phase !== 'complete') {
        Cup.sitOut(state, id);
        state.pendingRacers = (state.pendingRacers ?? []).filter((player) => player !== id);
        if (!state.withdrawn?.includes(id)) (state.withdrawn ??= []).push(id);
        Cup.touch(state);
      }
      this.#resumeRacers.delete(id);
      this.#needsRebind.delete(id);
      this.#pendingReconnects.delete(id);
    }
    this.#connection.kickPlayer(id);
    this.broadcast();
    this.#onChange();
  }
  toggleAutomaticRounds() {
    this.requireHost();
    this.#auto = !this.#auto;
    this.#setNextAuto(
      this.#auto && this.#state?.phase === 'between-rounds'
        ? Date.now() + rulesFor(this.#state).roundBreakSeconds * 1000
        : null,
    );
  }
  onInputsChanged(callback: () => void) {
    this.#onSpectatorInputs = callback;
  }
  init(pml: PolyModLoader) {
    if (this.#timer !== undefined) return;
    this.#native = connectNative(pml, this);
    window.addEventListener(
      'keydown',
      (event) => {
        if (!this.#state || this.#chatTyping) return;
        if (this.#game) this.#heldDrivingInputs.bind(this.#native.drivingBindings(this.#game));
        this.#heldDrivingInputs.press(event);
        if (this.freecamHotkey(event) || this.checkpointHotkey(event)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
    window.addEventListener('keyup', (event) => this.#heldDrivingInputs.release(event.code), {
      capture: true,
    });
    window.addEventListener('blur', () => this.clearDrivingInput());
    window.addEventListener(
      'focusin',
      (event) => {
        if (isEditing(event)) this.clearDrivingInput();
      },
      { capture: true },
    );
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clearDrivingInput();
    });
    this.#native.watchGames((sessions) =>
      watchGameSessions(sessions, (game) => {
        try {
          this.observeGame(game);
        } catch (error) {
          this.fail(error);
        }
      }),
    );
    // Not So Weekly Shorts: a worker-driven clock keeps a hidden organizer tab on time.
    const ticker = (window as unknown as { __nswsTicker?: Ticker }).__nswsTicker;
    if (ticker) {
      this.#timer = 1;
      ticker.every(100, () => this.tick());
    } else this.#timer = setInterval(() => this.tick(), 100);
  }
  now() {
    return Date.now() + (this.#isHost ? 0 : this.#offset);
  }
  clearDrivingInput() {
    this.#heldDrivingInputs.clear();
    if (this.#state && this.#game) this.#native.clearInput?.(this.#game);
  }
  rememberDrivingView(game: NativeGame) {
    if (
      game !== this.#game ||
      !this.#state ||
      this.#info?.disposed ||
      this.#followingGame === game ||
      this.localPlayerId === null ||
      !Cup.racingIds(this.#state).includes(this.localPlayerId)
    )
      return;
    if (this.#info?.spectator.isEnabled) {
      this.#drivingView = 0;
      return;
    }
    const run = this.#state.runtime;
    if (
      run &&
      (!['warmup', 'countdown', 'racing'].includes(this.#state.phase) ||
        this.#info?.sessionId !== run.sessionId ||
        Cup.roundDone(this.#state, this.localPlayerId))
    )
      return;
    this.#drivingView = this.#native.drivingView?.(game);
  }
  gameDisposed(game: NativeGame) {
    if (this.#game !== game) return;
    this.#unwatchInputs?.();
    this.#unwatchInputs = undefined;
    this.#inputGame = null;
    this.#game = null;
    this.#info = null;
  }
  connectionDisposed(connection: NativeConnection) {
    if (this.#connection !== connection) return;
    this.#actions.cancel('Disconnected from the organizer.');
    this.#enrolling.clear();
    this.#resumeRacers.clear();
    if (this.#isHost && this.#state) {
      this.#review.close(this.cup, 'interrupted');
    }
    this.#unwatchInputs?.();
    this.#inputGame = null;
    this.#inputCapture = null;
    this.#liveInputs.clear();
    this.#transport.dispose();
    this.#cameraTransport.dispose();
    this.#pendingCheckpoints.clear();
    this.#connection = null;
    this.#heldDrivingInputs.clear();
    this.#inputRestoredGame = null;
    this.#game = null;
    this.#info = null;
    this.#state = null;
    this.#lobby = [];
    this.#selfId = null;
    this.#auto = false;
    this.#isHost = false;
    this.#cameraBuffers.clear();
    this.#followingId = null;
    this.#handoffSubscriptions.clear();
    this.#unavailableSince.clear();
    this.#pendingReconnects.clear();
    this.#reconnectPending = false;
    this.#nextAuto = null;
    this.#startingCup = null;
    this.#hello.clear();
    this.requestPanel(false, 'Left the cup room');
    this.#onChange();
  }
  #errorAt = 0;
  fail(error: unknown) {
    this.#errorAt = Date.now();
    this.#error = error instanceof Error ? error.message : String(error);
    console.error('[PolyCup]', error);
    this.#onChange();
  }
  observeGame(game: NativeGame) {
    if (!this.#native) return;
    const info = this.#native.read(game);
    if (!info.connection || info.disposed) return;
    this.rememberDrivingView(game);
    this.#game = game;
    this.#info = info;
    const now = performance.now();
    if (this.#connection !== info.connection || now - this.#lobbyReadAt >= 250) {
      this.#lobbyReadAt = now;
      this.#lobby = info.connection.getPlayers();
      this.#selfId = this.#lobby.find((p) => p.isSelf)?.id ?? null;
    }
    if (this.#inputGame !== game) {
      this.#unwatchInputs?.();
      this.#inputGame = game;
      this.#unwatchInputs = this.#native.watchInputs?.(game, () => this.captureInputs());
    }
    if (this.#connection !== info.connection) {
      this.#actions.cancel('The connection to the cup changed.');
      this.#transport.dispose();
      this.#cameraTransport.dispose();
      this.#pendingCheckpoints.clear();
      this.#cameraBuffers.clear();
      this.#subscriptions.clear();
      this.#handoffSubscriptions.clear();
      this.#followingId = null;
      this.#hello.clear();
      this.#connection = info.connection;
      this.#drivingView = undefined;
      this.#cameraRestoredGame = null;
      this.#heldDrivingInputs.clear();
      this.#inputRestoredGame = null;
      this.#identity = null;
      this.#identityCup = '';
      this.#reconnectPending = false;
      this.#pendingReconnects.clear();
      this.#unavailableSince.clear();
      this.#trackUploads.clear();
      this.#recordRequests.clear();
      this.#isHost = this.#connection instanceof this.#native.Host;
      this.#state = null;
      this.#startingCup = null;
      this.#resetKey = '';
      this.#readyKey = '';
      this.#lastHello = 0;
      this.#helloCount = 0;
      this.#offset = 0;
      this.#bestRtt = Infinity;
      this.#watchId = null;
      this.#needsRebind = new Set();
      this.#syncSequence = 0;
      this.#receivedSequence = -1;
      this.#roundViewKey = '';
      this.#viewCupId = null;
      this.#onChange();
    }
    // Not So Weekly Shorts: collision cups never save or upload a time.
    this.#native.leaderboardUploads?.(
      game,
      this.#state
        ? rulesFor(this.#state).uploadLeaderboardTimes === true && !rulesFor(this.#state).collisions
        : undefined,
    );
    if (!this.#state || this.localPlayerId === null) return;
    const racing = Cup.racingIds(this.#state).includes(this.localPlayerId);
    if (racing && this.#cameraRestoredGame !== game) {
      this.#native.release?.(game, this.#drivingView);
      this.#cameraRestoredGame = game;
    }
    if (racing && this.#inputRestoredGame !== game) {
      const bindings = this.#native.drivingBindings?.(game);
      if (bindings) this.#heldDrivingInputs.bind(bindings);
      this.#native.applyDrivingInput?.(game, this.#heldDrivingInputs.controls());
      this.#inputRestoredGame = game;
    }
    const phase = this.cup.phase;
    if (!racing && info.spectator) this.#native.enableCupSpectator?.(game);
    const run = this.cup.runtime;
    if (
      run &&
      ['warmup', 'countdown', 'racing'].includes(phase) &&
      info.sessionId === run.sessionId
    ) {
      const resetKey = `${run.id}:${phase === 'warmup' ? 'warmup' : 'race'}`;
      if (this.#resetKey !== resetKey) {
        this.#resetKey = resetKey;
        this.#startKey = '';
        this.#raceTimeOffset = 0;
        this.#raceClockRound = run.id;
        const view =
          this.#followingGame === game ? this.#drivingView : this.#native.drivingView?.(game);
        this.#native.reset(game);
        this.#native.clearRecords(this.#connection);
        if (racing) {
          this.#native.release?.(game, view);
          info.spectator.isEnabled = false;
        }
        this.#info = this.#native.read(game);
      }
      if (
        phase !== 'warmup' &&
        racing &&
        (this.#hookedCar !== this.gameInfo.car || this.#hookedRound !== run.id)
      ) {
        this.#hookedCar = this.gameInfo.car;
        this.#hookedRound = run.id;
        this.hookFinish(this.gameInfo.car, run);
      }
      const startDue =
        (phase === 'countdown' || phase === 'racing') &&
        run.startsAt !== null &&
        this.now() >= run.startsAt!!;
      if (
        racing &&
        startDue &&
        (this.#startKey !== run.id || this.#startedCar !== this.gameInfo.car)
      ) {
        const retry = this.#startKey === run.id && Cup.timeAttack(this.cup);
        this.#startKey = run.id;
        this.#startedCar = this.gameInfo.car;
        this.#native.release?.(game);
        this.gameInfo.spectator.isEnabled = false;
        this.#native.applyDrivingInput?.(game, this.#heldDrivingInputs.controls());
        // Background tabs may process GO late. Count that delay in every Cup time,
        // while keeping the native recording clock unchanged. A time-attack retry starts at zero.
        this.#raceTimeOffset = retry
          ? 0
          : Math.max(
              this.#raceTimeOffset,
              Math.floor(this.now() - run.startsAt!) - this.gameInfo.car.getTime().numberOfFrames,
            );
        this.gameInfo.car.start();
        this.captureInputs();
      }
    }
  }
  shouldBlock(game: NativeGame) {
    if (!this.#state || game !== this.#game) return false;
    if (this.localPlayerId === null) return true;
    if (!Cup.racingIds(this.#state).includes(this.localPlayerId)) return true;
    if (this.gameInfo.sessionId !== this.cup.runtime?.sessionId) return true;
    if (this.cup.phase === 'warmup') return false;
    return !(
      ['racing', 'countdown'].includes(this.cup.phase) &&
      this.cup.runtime?.startsAt !== null &&
      this.now() >= this.round.startsAt! &&
      !(this.localPlayerId in this.round.finishes && !Cup.timeAttack(this.cup)) &&
      !this.round.dnfs.includes(this.localPlayerId)
    );
  }
  handleRestart(game: NativeGame) {
    if (!this.#state || game !== this.#game) return false;
    // Not So Weekly Shorts: a time-attack round restarts like warmup: a fresh attempt on a new clock.
    const attempt =
      this.cup.phase === 'racing' &&
      Cup.timeAttack(this.cup) &&
      this.localPlayerId !== null &&
      !Cup.roundDone(this.cup, this.localPlayerId) &&
      this.now() >= (this.cup.runtime?.startsAt ?? Infinity);
    if (attempt) {
      this.#raceTimeOffset = 0;
      this.#raceClockRound = this.cup.runtime!.id;
    }
    if (
      (this.cup.phase === 'warmup' || attempt) &&
      !this.#chatTyping &&
      !this.#info?.disposed &&
      this.localPlayerId !== null &&
      Cup.racingIds(this.cup).includes(this.localPlayerId) &&
      this.gameInfo.sessionId === this.cup.runtime?.sessionId
    ) {
      this.#native.reset(game);
      this.#info = this.#native.read(game);
    }
    return true;
  }
  shouldBlockRestart(game: NativeGame) {
    return (
      !!this.#state &&
      game === this.#game &&
      this.cup.phase !== 'warmup' &&
      !(this.cup.phase === 'racing' && Cup.timeAttack(this.cup))
    );
  }
  restartHotkey(event: KeyboardEvent) {
    if (this.#chatTyping) return false;
    const s = this.#state,
      run = s?.runtime;
    if (
      this.localPlayerId === null ||
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event
        .composedPath()
        .some(
          (e) =>
            ['INPUT', 'TEXTAREA', 'SELECT'].includes((e as HTMLElement).tagName) ||
            (e as HTMLElement).isContentEditable,
        ) ||
      !this.#game ||
      this.#info?.disposed ||
      s?.phase !== 'racing' ||
      !run ||
      this.#info?.sessionId !== run.sessionId ||
      run.startsAt === null ||
      this.now() < run.startsAt ||
      !Cup.racingIds(s).includes(this.localPlayerId) ||
      Cup.roundDone(s, this.localPlayerId) ||
      Cup.timeAttack(s) ||
      !this.#native.restartPressed(this.#game, event)
    )
      return false;
    // Not So Weekly Shorts: the first press only warns; a second press within 2 s retires.
    if (Date.now() - this.#retireArmed > RETIRE_CONFIRM_MS) {
      this.#retireArmed = Date.now();
      this.onRetireWarning?.();
      return true;
    }
    this.#retireArmed = 0;
    // Do not attach this to the native restart routine: checkpoint reset can
    // call that same routine when no checkpoint is available.
    this.action('dnf', run.id)?.catch((error) => this.fail(error));
    return true;
  }
  checkpointHotkey(event: KeyboardEvent) {
    if (this.#chatTyping) return false;
    const state = this.#state,
      run = state?.runtime,
      id = this.localPlayerId;
    if (
      !this.#game ||
      this.#info?.disposed ||
      id === null ||
      state?.phase !== 'racing' ||
      !run ||
      this.#info?.sessionId !== run.sessionId ||
      run.startsAt === null ||
      this.now() < run.startsAt ||
      !Cup.racingIds(state).includes(id) ||
      Cup.roundDone(state, id) ||
      Cup.timeAttack(state) ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isEditing(event)
    )
      return false;
    if (!this.#native.startRespawnPressed(this.#game, event)) return false;
    if (event.repeat) return true;
    this.captureInputs();
    // Keep time spent on earlier attempts, including the car replacement interval.
    this.#raceTimeOffset = Math.max(
      this.lapFrames(this.gameInfo.car.getTime().numberOfFrames),
      Math.floor(this.now() - run.startsAt),
    );
    this.#raceClockRound = run.id;
    this.#native.reset(this.#game);
    this.observeGame(this.#game);
    return true;
  }
  lapFrames(frames: number) {
    return frames + (this.#raceClockRound === this.#state?.runtime?.id ? this.#raceTimeOffset : 0);
  }
  hookFinish(car: NativeCar, run: Round) {
    let checkpoint: number | null = null;
    const checkpointIndex = this.gameInfo.checkpointCount - 2;
    car.addCheckpointCallback((index) => {
      if (index === checkpointIndex && checkpointIndex >= 0)
        checkpoint = this.lapFrames(car.getTime().numberOfFrames);
      if (
        this.localPlayerId === null ||
        this.#state?.phase !== 'racing' ||
        this.cup.runtime?.id !== run.id ||
        this.#info?.sessionId !== run.sessionId ||
        this.#info.car !== car
      )
        return;
      // The native callback receives the previous index. Read the current
      // progress so a frame crossing several checkpoints reports the furthest.
      const reached = car.getNextCheckpointIndex() - 1;
      if (reached < 0 || reached > checkpointIndex) return;
      const message: CheckpointMessage = {
        type: 'checkpoint',
        cupId: this.cup.id,
        roundId: run.id,
        sessionId: run.sessionId,
        index: reached,
        frames: this.lapFrames(car.getTime().numberOfFrames),
      };
      if (this.#raceTimeOffset > 0)
        this.#native.showRoundCheckpoint?.(this.activeGame, message.frames);
      if (this.#isHost) this.receiveCheckpoint(this.localPlayerId, message);
      else {
        if (this.#checkpointSender !== this.localPlayerId) this.#pendingCheckpoints.clear();
        this.#checkpointSender = this.localPlayerId;
        // Checkpoint resets can revisit an earlier gate; retain its first crossing time.
        const pending = this.#pendingCheckpoints.get(reached);
        if (
          !pending ||
          pending.cupId !== message.cupId ||
          pending.roundId !== message.roundId ||
          pending.sessionId !== message.sessionId
        )
          this.#pendingCheckpoints.set(reached, message);
        this.flushCheckpoints();
      }
    });
    car.addFinishCallback(() => {
      if (
        this.localPlayerId === null ||
        this.#state?.phase !== 'racing' ||
        this.cup.runtime?.id !== run.id
      )
        return;
      this.flushInputs();
      const message: FinishMessage = {
        type: 'finish',
        roundId: run.id,
        sessionId: run.sessionId,
        frames: this.lapFrames(car.getTime().numberOfFrames),
        checkpoint,
      };
      if (!rulesFor(this.#state).collisions) {
        try {
          const recording = car.getRecording?.()?.serialize();
          if (recording && recording.length <= 50000) {
            const attempt = (car.getFinishTime() ?? car.getTime()).numberOfFrames;
            if (!this.#isHost) {
              message.recording = recording;
              message.attempt = attempt;
            }
            this.rememberRun(run, recording, attempt, message.frames);
          }
        } catch {}
      }
      if (this.#raceTimeOffset > 0) this.#native.showRoundFinish?.(this.activeGame, message.frames);
      if (this.#isHost) this.receiveFinish(this.localPlayerId, message);
      else this.#transport.send(0, message);
    });
  }
  receiveFinish(id: number, m: FinishMessage) {
    const run = this.#state?.runtime;
    if (!run || m.roundId !== run.id || m.sessionId !== run.sessionId) return;
    const before = standings(this.cup).map((r) => r.id);
    if (Cup.recordFinish(this.cup, id, m.frames, this.now())) {
      if (
        typeof m.checkpoint === 'number' &&
        Number.isSafeInteger(m.checkpoint) &&
        m.checkpoint >= 0 &&
        m.checkpoint <= m.frames
      )
        run.checkpoints[id] = m.checkpoint;
      updateLiveMovement(this.cup, before);
      this.verifyFinish(id, m);
      this.broadcast();
    }
  }
  flushCheckpoints() {
    if (!this.#pendingCheckpoints.size) return;
    const state = this.#state,
      run = state?.runtime,
      id = this.localPlayerId;
    if (
      this.#isHost ||
      !state ||
      state.phase !== 'racing' ||
      !run ||
      id === null ||
      id !== this.#checkpointSender ||
      this.#info?.sessionId !== run.sessionId ||
      !Cup.racingIds(state).includes(id) ||
      Cup.roundDone(state, id)
    ) {
      this.#pendingCheckpoints.clear();
      return;
    }
    // A successful send only queues bytes. The host's standings acknowledge receipt.
    for (const [index, message] of this.#pendingCheckpoints)
      if (
        message.cupId !== state.id ||
        message.roundId !== run.id ||
        message.sessionId !== run.sessionId ||
        (run.splits?.[id]?.index ?? -1) >= index
      )
        this.#pendingCheckpoints.delete(index);
    const now = performance.now();
    if (now - this.#lastCheckpointSend < 500) return;
    this.#lastCheckpointSend = now;
    let sent = 0;
    for (const message of this.#pendingCheckpoints.values()) {
      if (!this.#transport.send(0, message) || ++sent >= 4) break;
    }
  }
  receiveCheckpoint(id: number, m: CheckpointMessage) {
    const run = this.#state?.runtime;
    if (
      !this.#isHost ||
      !run ||
      m.cupId !== this.cup.id ||
      m.roundId !== run.id ||
      m.sessionId !== run.sessionId ||
      this.#info?.sessionId !== run.sessionId
    )
      return;
    if (
      this.#checkpointProgress.record(
        this.cup,
        id,
        m.index,
        m.frames,
        this.now(),
        this.gameInfo.checkpointCount,
      )
    ) {
      this.ensureReview();
      this.#review.checkpoint(run.id, id, m.index, m.frames);
      this.broadcast();
    }
  }
  ensureReview() {
    if (!this.#isHost || !this.#state) return;
    if (this.#review.cupId !== this.cup.id) this.#review = new ReviewLog(this.cup.id);
    if (
      this.cup.phase === 'racing' ||
      (this.cup.phase === 'countdown' && this.now() >= (this.cup.runtime?.startsAt ?? Infinity))
    )
      this.#review.begin(this.#state, this.#info?.checkpointCount ?? 0);
  }
  inputContext(): InputContext | null {
    const s = this.#state,
      r = s?.runtime;
    if (
      !r ||
      r.sessionId !== this.#info?.sessionId ||
      this.#info?.disposed ||
      !(
        s.phase === 'warmup' ||
        (['countdown', 'racing'].includes(s.phase) &&
          r.startsAt !== null &&
          this.now() >= r.startsAt)
      )
    )
      return null;
    return {
      cupId: s.id,
      roundId: r.id,
      sessionId: r.sessionId,
      stage: s.phase === 'warmup' ? 'warmup' : 'race',
    };
  }
  syncInputScope(context: InputContext | null) {
    const scope = JSON.stringify(context);
    if (scope !== this.#inputScope) {
      this.#inputScope = scope;
      this.#inputCapture = null;
      this.#liveInputs.clear();
      this.#inputSequences.clear();
    }
  }
  captureInputs() {
    if (this.localPlayerId === null) return;
    const context = this.inputContext();
    this.syncInputScope(context);
    if (
      !context ||
      !Cup.racingIds(this.#state).includes(this.localPlayerId) ||
      Cup.roundDone(this.#state, this.localPlayerId) ||
      !this.#native?.readInputs
    )
      return;
    this.#inputCapture ??= new InputCapture(context);
    try {
      const sample = this.#native.readInputs(this.activeGame);
      this.#inputCapture.capture(this.lapFrames(sample.frames), inputMask(sample.controls));
    } catch {
      // Evidence capture must never interrupt the native render/control loop.
      this.#inputCapture.markGap();
    }
  }
  flushInputs() {
    if (this.localPlayerId === null) return;
    this.captureInputs();
    if (
      !this.#inputCapture ||
      !this.inputContext() ||
      Cup.roundDone(this.#state, this.localPlayerId)
    )
      return;
    const actor = this.localPlayerId;
    return this.#inputCapture.flush((message) =>
      this.#isHost ? this.receiveInputs(actor, message) : this.#transport.send(0, message),
    );
  }
  receiveInputs(id: number, m: InputPacket) {
    const context = this.inputContext();
    if (
      !this.#isHost ||
      !context ||
      !Object.entries(context).every(([k, v]) => m[k as keyof InputContext] === v) ||
      (id !== this.#selfId && !this.#hello.has(id)) ||
      !Cup.racingIds(this.#state).includes(id) ||
      Cup.roundDone(this.#state, id) ||
      !Number.isSafeInteger(m.seq) ||
      m.seq < 0 ||
      !frameNumber(m.through) ||
      typeof m.gap !== 'boolean' ||
      !Number.isSafeInteger(m.attempt) ||
      m.attempt < 0 ||
      (context.stage === 'race' && m.attempt !== 0 && !Cup.timeAttack(this.#state)) ||
      !validInputEvents(m.events, m.through) ||
      (context.stage === 'race' && m.through > this.now() - this.round.startsAt! + 2000)
    )
      return false;
    this.syncInputScope(context);
    if (m.seq <= (this.#inputSequences.get(id) ?? -1)) return false;
    let timeline = this.#liveInputs.get(id) ?? new InputTimeline();
    if (m.attempt < timeline.attempt) return false;
    if (m.attempt > timeline.attempt) {
      timeline = new InputTimeline(m.attempt);
    }
    if (
      m.through < timeline.through ||
      (m.events.length && m.events[0][0] < (timeline.events.at(-1)?.[0] ?? 0))
    )
      return false;
    if (context.stage === 'race' && !Cup.timeAttack(this.#state)) {
      this.ensureReview();
      if (!this.#review.inputs(m.roundId, id, m)) return false;
    }
    this.#inputSequences.set(id, m.seq);
    timeline.push(m.events, m.through, this.now());
    this.#liveInputs.set(id, timeline);
    for (const [spectator, watched] of this.#subscriptions)
      if (
        (watched === id || this.#handoffSubscriptions.get(spectator) === id) &&
        Cup.mayWatch(this.#state, spectator)
      )
        this.#transport.send(spectator, {
          type: 'input-view',
          ...context,
          racerId: id,
          attempt: m.attempt,
          through: m.through,
          events: m.events,
        });
    return true;
  }
  receiveInputView(id: number, m: InputViewMessage) {
    const context = this.inputContext();
    if (
      this.#isHost ||
      id !== 0 ||
      !context ||
      !this.canSpectate() ||
      (m.racerId !== this.#watchId && m.racerId !== this.#followingId) ||
      !Object.entries(context).every(([k, v]) => m[k as keyof InputContext] === v) ||
      !Number.isSafeInteger(m.attempt) ||
      m.attempt < 0 ||
      (context.stage === 'race' && m.attempt !== 0 && !Cup.timeAttack(this.#state)) ||
      !frameNumber(m.through) ||
      !validInputEvents(m.events, m.through)
    )
      return;
    this.syncInputScope(context);
    let timeline = this.#liveInputs.get(m.racerId) ?? new InputTimeline();
    if (m.attempt < timeline.attempt) return;
    if (m.attempt > timeline.attempt) {
      timeline = new InputTimeline(m.attempt);
    }
    if (timeline.push(m.events, m.through, this.now())) this.#liveInputs.set(m.racerId, timeline);
  }
  watchedInputs() {
    return this.canSpectate() && this.#watchedPose
      ? (this.#liveInputs.get(this.watchId!)?.sample(this.#watchedPose.frames, this.now()) ?? null)
      : null;
  }
  freecamHotkey(event: KeyboardEvent) {
    if (
      !this.#state ||
      !this.#game ||
      this.#chatTyping ||
      isEditing(event) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      !this.#native.freecamPressed?.(this.#game, event) ||
      !Cup.mayWatch(this.#state, this.#selfId)
    )
      return false;
    if (event.repeat) return true;
    if (rulesFor(this.#state).allowSpectatorFreecam === false) return true;
    this.#freecam = !this.#freecam;
    this.#freecamGame = null;
    this.#lastSubscribe = 0;
    if (this.#freecam) {
      this.#followingGame = null;
      this.#followingId = null;
      if (!this.#isHost) this.#transport.send(0, { type: 'watch', value: null });
    }
    this.#onChange();
    return true;
  }
  canSpectate() {
    if (this.#freecam) return false;
    if (!this.#state?.runtime) return false;
    if (this.#info && this.#info.sessionId !== this.#state.runtime.sessionId) return false;
    if (this.localPlayerId === null) return false;
    if (!Cup.mayWatch(this.#state, this.#selfId)) return false;
    if (!Cup.racingIds(this.#state).includes(this.localPlayerId)) return true;
    return (
      this.#manualWatchRound === this.cup.runtime?.id ||
      (!!this.#game && (this.#native?.autoSpectate?.(this.#game) ?? true))
    );
  }
  watchRemaining() {
    if (this.localPlayerId === null) return;
    if (!Cup.roundDone(this.#state, this.localPlayerId)) return;
    this.#manualWatchRound = this.round.id;
    this.#onChange();
  }
  toggleGhosts() {
    if (!this.#state || rulesFor(this.#state).collisions) return;
    this.#hideOtherGhosts = !this.#hideOtherGhosts;
    this.#onChange();
  }
  get ghostsHidden() {
    return this.#hideOtherGhosts && !!this.#state && !rulesFor(this.#state).collisions;
  }
  watchable() {
    return this.#state && this.cup.phase !== 'complete'
      ? Cup.racingIds(this.#state).filter(
          (id) => !Cup.roundDone(this.#state, id) && this.#lobby.some((p) => p.id === id),
        )
      : [];
  }
  cycleWatch(delta: number) {
    const ids = this.watchable();
    if (!this.canSpectate() || !ids.length) return;
    const i = ids.indexOf(this.#watchId!);
    this.selectWatch(ids[(i + delta + ids.length) % ids.length]);
  }
  selectWatch(id: number) {
    if (!this.canSpectate() || !this.watchable().includes(id)) return;
    if (!this.#isHost)
      for (const racer of this.#liveInputs.keys())
        if (racer !== id && racer !== this.#followingId) this.#liveInputs.delete(racer);
    this.#watchId = id;
    this.#lastSubscribe = 0;
    if (this.#followingId === null) {
      this.#watchedPose = null;
      this.#lastWatchPose = null;
    }
    this.#onChange();
  }
  stopWatchSubscription() {
    if (
      !this.#isHost &&
      Date.now() - this.#lastSubscribe > 1000 &&
      this.#transport.send(0, { type: 'watch', value: null })
    )
      this.#lastSubscribe = Date.now();
  }
  beforeRender(game: NativeGame) {
    if (game !== this.#game) return;
    this.captureInputs();
    if (
      this.#freecam &&
      (!Cup.mayWatch(this.#state, this.#selfId) ||
        rulesFor(this.#state).allowSpectatorFreecam === false)
    ) {
      this.#freecam = false;
      this.#freecamGame = null;
    }
    if (this.#freecam && this.#state && !this.#info?.disposed && this.#selfId !== null) {
      this.stopWatchSubscription();
      if (this.#freecamGame !== game) {
        this.#native.enterFreecam?.(game);
        this.#freecamGame = game;
      }
      this.#native.presentation?.(game, true, true);
      this.#native.visibility(
        game,
        this.ghostsHidden ? [] : Cup.racingIds(this.#state),
        this.#selfId,
      );
      this.#filteredCars = true;
      this.#onSpectatorInputs?.();
      return;
    }
    const spectating = !this.#info?.disposed && this.canSpectate() && this.watchable().length > 0;
    // Native session-end screens still render after the session stops accepting
    // controls. Update their presentation before the disposed-session guard.
    this.#native.presentation?.(game, !!this.#state, spectating);
    if (this.#info?.disposed || this.localPlayerId === null) {
      this.#native.collisions?.(game, null);
      return;
    }
    if (!this.#state) {
      this.#native.collisions?.(game, null);
      if (this.#filteredCars) this.#native.visibility(game, null, this.localPlayerId);
      this.#filteredCars = false;
      return;
    }
    const now = this.now(),
      active = Cup.racingIds(this.#state);
    // Not So Weekly Shorts: in a collision cup the local car hits every racer still on the track.
    const state = this.#state,
      self = this.localPlayerId;
    this.#native.collisions?.(
      game,
      rulesFor(state).collisions &&
        state.phase === 'racing' &&
        active.includes(self) &&
        !Cup.roundDone(state, self) &&
        this.gameInfo.sessionId === state.runtime?.sessionId
        ? active.filter((id) => id !== self && !(id in (state.runtime?.finishes ?? {})) && !state.runtime?.dnfs.includes(id))
        : null,
    );
    if (this.canSpectate() && !this.watchable().includes(this.#watchId!))
      this.selectWatch(this.watchable()[0]);
    if (!spectating && this.#followingGame === game) {
      this.#native.release(game, this.#drivingView);
      this.#followingGame = null;
      this.#lastWatchPose = null;
    }
    if (
      active.includes(this.localPlayerId) &&
      !Cup.roundDone(this.#state, this.localPlayerId) &&
      now - this.#lastPose >= 50 &&
      !this.gameInfo.spectator.isEnabled
    ) {
      this.#lastPose = now;
      const pose = { ...this.#native.camera(game), at: now };
      pose.frames = this.lapFrames(pose.frames);
      if (this.#isHost) this.relayCamera(this.localPlayerId, pose);
      else this.#cameraTransport.send(0, { type: 'camera', pose });
    }
    if (!spectating) {
      this.stopWatchSubscription();
      if (this.#raceTimeOffset > 0 && this.#raceClockRound === this.#state.runtime?.id)
        this.#native.showRoundTime?.(
          game,
          this.lapFrames(
            (this.gameInfo.car.getFinishTime?.() ?? this.gameInfo.car.getTime()).numberOfFrames,
          ),
        );
      this.#followingId = null;
      this.#watchedPose = null;
      this.#native.visibility(
        game,
        this.ghostsHidden ? [this.localPlayerId] : active,
        this.localPlayerId,
      );
      this.#filteredCars = true;
      this.#onSpectatorInputs?.();
      return;
    }
    if (!this.#isHost && Date.now() - this.#lastSubscribe > 1000) {
      if (
        this.#transport.send(0, {
          type: 'watch',
          value: this.#watchId,
          previous: this.#followingId !== this.#watchId ? this.#followingId : null,
        })
      )
        this.#lastSubscribe = Date.now();
    }
    const tick = performance.now();
    let pose = this.#cameraBuffers
      .get(this.#watchId!)
      ?.playback(now, this.gameInfo.sessionId, tick);
    if (pose && this.#followingId !== this.#watchId) {
      this.#followingId = this.#watchId;
      this.#lastSubscribe = 0;
      this.#onChange();
    } else if (!pose && this.#followingId !== null && this.#followingId !== this.#watchId) {
      pose = this.#cameraBuffers
        .get(this.#followingId)
        ?.playback(now, this.gameInfo.sessionId, tick);
    }
    const viewed = this.watchId!;
    this.#native.visibility(
      game,
      this.ghostsHidden ? active.filter((id) => id === viewed) : active,
      this.localPlayerId,
    );
    this.#filteredCars = true;
    this.#watchedPose = pose ?? null;
    this.#watchStatus = pose ? 'Buffered POV' : 'Waiting for racer camera';
    if (pose) this.#lastWatchPose = pose;
    else if (!this.#lastWatchPose || this.#lastWatchPose.sessionId !== this.gameInfo.sessionId)
      this.#lastWatchPose = {
        ...this.#native.camera(game),
        carPosition: undefined,
        carQuaternion: undefined,
      };
    this.#native.follow(game, this.#lastWatchPose!, viewed);
    this.#followingGame = game;
    this.#onSpectatorInputs?.();
  }
  receiveCamera(id: number, message: Extract<Message, { type: 'camera' }>) {
    if (
      message.type !== 'camera' ||
      !validPose(message.pose) ||
      !this.#state ||
      Math.abs(message.pose.at - this.now()) > 5000 ||
      message.pose.sessionId !== this.#info?.sessionId
    )
      return;
    if (this.#isHost) {
      if (
        this.#hello.has(id) &&
        Cup.racingIds(this.#state).includes(id) &&
        !Cup.roundDone(this.#state, id)
      )
        this.relayCamera(id, message.pose);
    } else if (
      id === 0 &&
      (message.racerId === this.#watchId || message.racerId === this.#followingId)
    )
      this.bufferCamera(message.racerId, message.pose);
  }
  bufferCamera(id: number, pose: CameraPose) {
    if (!this.#cameraBuffers.has(id)) this.#cameraBuffers.set(id, new CameraBuffer());
    this.#cameraBuffers.get(id)!.push(pose, this.now());
  }
  relayCamera(id: number, pose: CameraPose) {
    this.bufferCamera(id, pose);
    for (const [spectator, watched] of this.#subscriptions)
      if (
        (watched === id || this.#handoffSubscriptions.get(spectator) === id) &&
        Cup.mayWatch(this.#state, spectator)
      )
        this.#cameraTransport.send(spectator, { type: 'camera', racerId: id, pose });
  }
  tick() {
    try {
      if (!this.#connection || !this.#native) return;
      this.#native.pruneClosedPeers?.(this.#connection);
      if (this.#game) this.#info = this.#native.read(this.#game);
      this.#lobby = this.#connection.getPlayers();
      this.#selfId = this.#lobby.find((p) => p.isSelf)?.id ?? null;
      if (this.#selfId === null) {
        this.#onChange();
        return;
      }
      this.#transport.sync(this.#native.peers(this.#connection));
      this.#cameraTransport.sync(this.#native.peers(this.#connection));
      this.syncReconnect();
      this.syncDiagnostics();
      this.#chat.tick();
      // Not So Weekly Shorts: every message costs a Cloudflare request, so after the first few
      // seconds an idle page says hello every 5 s instead of 2 s.
      if (Date.now() - this.#lastHello > (this.#helloCount < 5 ? 2000 : 5000)) {
        this.#lastHello = Date.now();
        if (!this.#isHost && this.#transport.send(0, { type: 'hello', version: Cup.VERSION, sentAt: Date.now() }))
          this.#helloCount++;
      }
      this.sendBumps();
      this.syncMyRuns();
      if (!this.#state) {
        if (this.#isHost && Date.now() - this.#lastBroadcast > 1000) this.broadcast();
        this.#onChange();
        return;
      }
      if (this.#game && this.#info && !this.#info.disposed) {
        this.sendReady();
        this.flushCheckpoints();
        this.ensureReview();
        this.flushInputs();
        this.refreshRecords();
      }
      for (const [id, upload] of this.#trackUploads)
        if (upload.until < Date.now()) this.#trackUploads.delete(id);
      if (this.#isHost) {
        for (const racer of this.cup.roster) {
          const peer = this.#lobby.find((p) => p.id === racer.id);
          if (!peer) continue;
          const country =
            typeof peer.countryCode === 'string' && /^[a-z]{2}$/i.test(peer.countryCode)
              ? peer.countryCode.toLowerCase()
              : null;
          if (racer.countryCode !== country) {
            racer.countryCode = country;
            Cup.touch(this.cup);
          }
        }
        this.checkDisconnects();
        this.prepareNextRandomTrack();
        this.applyReconnects();
        this.admitRacers();
        this.advanceClock();
        if (this.cup.phase === 'racing' && !this.#removingTrack) {
          const run = this.round;
          if (
            (Cup.allFinished(this.#state) ||
              (run.deadline !== null && this.now() >= run.deadline + 1500)) &&
            !this.verificationPending()
          )
            this.finishRound();
        }
        this.watchLoading();
        if (
          this.#startSoon &&
          this.cup.phase === 'between-rounds' &&
          !this.#removingTrack &&
          this.canStartRound()
        ) {
          this.#startSoon = false;
          this.runRound()?.catch((error) => this.fail(error));
        }
        if (
          this.#auto &&
          this.cup.phase === 'between-rounds' &&
          this.#nextAuto &&
          Date.now() >= this.#nextAuto
        ) {
          if (this.canStartRound())
            this.runRound()?.catch((error) => {
              this.#autoStopped = this.#auto;
              this.#auto = false;
              this.fail(error);
            });
          else this.#setNextAuto(Date.now() + 1000, false);
        }
        if (Date.now() - this.#lastBroadcast > 1000 || this.#sentRevision !== this.cup.revision)
          this.broadcast();
      }
      this.#onChange();
    } catch (error) {
      if (this.#auto) this.#autoStopped = true;
      this.#auto = false;
      this.fail(error);
    }
  }
  // Not So Weekly Shorts: automatic rounds stopped because of an error (the UI says so once).
  #autoStopped = false;
  takeAutoStopped() {
    const value = this.#autoStopped;
    this.#autoStopped = false;
    return value;
  }
  create(name: string) {
    this.#setupDepartures.clear();
    this.#physicsReports.clear();
    this.#lastPhysics = 0;
    this.#enrolling.clear();
    this.#resumeRacers.clear();
    this.#preparingRandom = null;
    this.requireHost();
    this.#state = Cup.newCup(name);
    this.#startingCup = null;
    this.#tracks.clear();
    this.#error = '';
    resetDraft(this.#state);
    this.#needsRebind = new Set();
    this.#unavailableSince.clear();
    this.#pendingReconnects.clear();
    this.#trackUploads.clear();
    this.#recordRequests.clear();
    this.#auto = true;
    // Not So Weekly Shorts: the organizer starts on the grid; Spectate moves them off it.
    const self = this.#lobby.find((p) => p.isSelf);
    if (self) Cup.addPlayer(this.#state, self.id, self.nickname);
    this.broadcast();
    this.#onChange();
    this.ensureReview();
  }
  requireHost() {
    if (!this.#isHost || !this.#connection)
      throw new Error('Host a cup from Competitions first.');
  }
  beginBans() {
    this.requireHost();
    this.requireStartRacers();
    const rules = rulesFor(this.cup);
    const pool = this.allowedTracks().filter((t) => t.category !== 'custom');
    const available = new Set(pool.map((t) => t.id)).size;
    const needed =
      this.cup.roster.length * rules.bansPerRacer +
      (rules.pool.includes('custom') ? 0 : rules.picksPerRacer);
    if (available < needed)
      throw new Error(
        'Not enough tracks for these bans and picks. Expand the pool or reduce the counts.',
      );
    this.change((s) => beginBans(s));
    this.#tracks.clear();
    this.#trackUploads.clear();
  }
  reopenRoster() {
    this.#startingCup = null;
    this.change((s) => resetDraft(s));
    this.#tracks.clear();
    this.#trackUploads.clear();
  }
  setPreset(preset: CupPreset) {
    if (this.#startingCup) throw new Error('Wait for Cup preparation to finish.');
    this.change((s) => Cup.applyPreset(s, preset));
    this.#tracks.clear();
    this.#trackUploads.clear();
  }
  requestPanel(open: boolean, message: string = '') {
    this.#panelRequest = { revision: this.#panelRequest.revision + 1, open, message };
  }
  async rematch(newTracks = false) {
    this.#preparingRandom = null;
    this.requireHost();
    if (this.#state?.phase !== 'complete')
      throw new Error('Finish the Cup before starting a rematch.');
    const next = Cup.rematch(this.#state, newTracks);
    const online = new Set(this.#lobby.map((p) => p.id));
    if (next.roster.some((p) => !online.has(p.id))) {
      resetDraft(next);
      for (const p of [...next.roster]) if (!online.has(p.id)) Cup.removePlayer(next, p.id);
    }
    const needsDraft = rulesFor(next).selection === 'draft' && next.draft?.stage === 'roster';
    const launch = !newTracks && !needsDraft && next.roster.length >= 2;
    if (launch) {
      this.requireStartRacers();
      if (this.cup.tracks.some((t) => !this.#tracks.has(t.id)))
        throw new Error('A rematch track is missing. Choose new tracks instead.');
    }
    this.#freecam = false;
    this.#freecamGame = null;
    this.#state = next;
    this.#setupDepartures.clear();
    this.#needsRebind.clear();
    this.#pendingReconnects.clear();
    this.#unavailableSince.clear();
    this.#startingCup = null;
    if (newTracks || needsDraft) this.#tracks.clear();
    this.#enrolling.clear();
    this.#resumeRacers.clear();
    this.#trackUploads.clear();
    this.#recordRequests.clear();
    this.#cameraBuffers.clear();
    this.#subscriptions.clear();
    this.#handoffSubscriptions.clear();
    this.#followingId = null;
    this.#watchId = null;
    this.#lastWatchPose = null;
    this.#manualWatchRound = null;
    this.#auto = true;
    this.#setNextAuto(null);
    this.#loadingSession = undefined;
    this.#error = '';
    this.broadcast();
    this.#onChange();
    if (launch) await this.startCup();
    else if (!newTracks && needsDraft)
      this.requestPanel(true, 'The racer roster changed. Set up bans and picks for the next Cup.');
  }
  syncRoundPanel() {
    const s = this.#state,
      run = s?.runtime;
    const key = JSON.stringify([s?.id, s?.phase, run?.id, run?.sessionId]);
    if (key === this.#roundViewKey) return;
    this.#roundViewKey = key;
    if (run && ['loading', 'warmup', 'countdown', 'racing'].includes(s.phase)) {
      this.requestPanel(false);
    } else if (s && this.#viewCupId !== s.id) {
      this.requestPanel(true);
    }
    this.#viewCupId = s?.id ?? null;
  }
  releaseCup(message: string) {
    this.#freecam = false;
    this.#freecamGame = null;
    this.#enrolling.clear();
    this.#resumeRacers.clear();
    this.#preparingRandom = null;
    this.#heldDrivingInputs.clear();
    this.#inputRestoredGame = null;
    this.#reconnect.reset('');
    this.#reconnectPending = false;
    this.#pendingReconnects.clear();
    this.#unavailableSince.clear();
    this.#identity = null;
    this.#identityCup = '';
    this.#state = null;
    this.#startingCup = null;
    this.#auto = false;
    this.#nextAuto = null;
    this.#loadingSession = undefined;
    this.#resetKey = '';
    this.#startKey = '';
    this.#readyKey = '';
    this.#error = '';
    this.#cameraBuffers.clear();
    this.#subscriptions.clear();
    this.#handoffSubscriptions.clear();
    this.#followingId = null;
    this.#recordRequests.clear();
    this.#trackUploads.clear();
    this.#watchId = null;
    this.#watchedPose = null;
    this.#lastWatchPose = null;
    this.#watchStatus = '';
    this.#followingGame = null;
    this.#manualWatchRound = null;
    this.#actions.cancel('The Cup ended.');
    if (this.#pendingUpload) this.#pendingUpload.error = 'The Cup ended.';
    this.#transferProgress = '';
    this.#roundViewKey = '';
    this.#viewCupId = null;
    if (this.#game) this.#native?.presentation?.(this.#game, false, false);
    if (this.#game) this.#native?.leaderboardUploads?.(this.#game);
    if (this.#game && !this.#info?.disposed && this.localPlayerId !== null) {
      this.#native?.release?.(this.#game);
      if (this.#info?.spectator) this.gameInfo.spectator.isEnabled = false;
      this.#native?.visibility?.(this.#game, null, this.localPlayerId);
      this.#filteredCars = false;
    }
    this.requestPanel(false, message);
    this.syncInputScope(null);
    this.#onSpectatorInputs?.();
  }
  // Not So Weekly Shorts: ending a cup sends everyone in it back to the menu (polycup/nsws/hub.ts).
  onCupEnded?: (byMe: boolean) => void;
  endCup() {
    this.requireHost();
    if (!this.#state) return;
    this.#review.close(this.#state, 'interrupted');
    this.releaseCup('Cup ended');
    this.broadcast();
    this.#onChange();
    this.onCupEnded?.(true);
  }
  acceptTrack(actor: number, code: string) {
    const state = this.cup;
    if (!picksOpen(state) || !Cup.player(state, actor))
      throw new Error('Join as a racer and wait for the picking phase.');
    if (typeof code !== 'string' || code.length > 2000000)
      throw new Error('The track code is too large.');
    const track = this.#native.parse(code.trim());
    if (!track?.trackData?.hasStartingPoint())
      throw new Error('The code must contain a valid PolyTrack track with a start.');
    const id = track.trackData.getId();
    const category = this.#native.trackLibrary?.isOfficialTrack(id)
      ? 'official'
      : this.#native.trackLibrary?.isCommunityTrack(id)
        ? 'community'
        : 'custom';
    if (category === 'custom' && (rulesFor(state).bansPerRacer > 0 || banEntries(state).length))
      throw new Error('Custom tracks are disabled while bans are enabled.');
    if (state.preset && !poolAllows(rulesFor(state), category))
      throw new Error('That track category is not allowed by this preset.');
    Cup.chooseTrack(state, actor, { id, name: track.trackMetadata.name });
    this.#tracks.set(id, { ...track, code: code.trim() });
    this.pruneTrackData();
    this.broadcast();
  }
  pruneTrackData() {
    for (const id of this.#tracks.keys())
      if (!this.cup.tracks.some((t) => t.id === id)) this.#tracks.delete(id);
  }
  async importTrack(code: string) {
    if (
      this.localPlayerId === null ||
      this.#state?.phase !== 'registration' ||
      !Cup.player(this.#state, this.localPlayerId)
    )
      throw new Error('Join as a racer before choosing a track.');
    if (typeof code !== 'string' || !code.trim() || code.length > 2000000)
      throw new Error('Choose a valid track of up to 2 MB.');
    if (this.#isHost) {
      this.acceptTrack(this.localPlayerId, code);
      return;
    }
    if (this.#pendingUpload) throw new Error('Your previous track is still uploading.');
    const cupId = this.cup.id,
      connection = this.#connection,
      transferId = crypto.randomUUID();
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const pending = { transferId, done: false, error: null };
    this.#pendingUpload = pending;
    this.#transferProgress = 'Sending track…';
    this.#onChange();
    const send = async (
      message:
        | { type: 'track-begin'; length: number }
        | { type: 'track-chunk'; seq: number; data: string }
        | { type: 'track-end' },
    ) => {
      const deadline = Date.now() + 5000;
      while (true) {
        if (
          this.#connection !== connection ||
          this.#state?.id !== cupId ||
          this.cup.phase !== 'registration'
        )
          throw new Error('The Cup changed during track upload.');
        if (pending.error) throw new Error(pending.error);
        if (this.#transport.send(0, { ...message, cupId, transferId })) return;
        if (Date.now() > deadline) throw new Error('Track upload lost its connection. Try again.');
        await sleep(100);
      }
    };
    try {
      await send({ type: 'track-begin', length: code.length });
      for (let offset = 0, seq = 0; offset < code.length; offset += 24000, seq++) {
        await sleep(100);
        await send({ type: 'track-chunk', seq, data: code.slice(offset, offset + 24000) });
        this.#transferProgress = `Sending track · ${Math.min(100, Math.round(((offset + 24000) / code.length) * 100))}%`;
        this.#onChange();
      }
      await send({ type: 'track-end' });
      this.#transferProgress = 'Checking track with organizer…';
      this.#onChange();
      const deadline = Date.now() + 15000;
      while (!pending.done && !pending.error && Date.now() < deadline) await sleep(100);
      if (pending.error) throw new Error(pending.error);
      if (!pending.done) throw new Error('The organizer did not confirm the track. Try again.');
    } finally {
      this.#pendingUpload = null;
      this.#transferProgress = '';
      this.#onChange();
    }
  }
  receiveTrack(id: number, m: TrackMessage) {
    if (
      !this.#hello.has(id) ||
      !this.#state ||
      !picksOpen(this.#state) ||
      m.cupId !== this.cup.id ||
      !Cup.player(this.#state, id)
    )
      return;
    if (typeof m.transferId !== 'string' || m.transferId.length > 64) return;
    try {
      if (m.type === 'track-begin') {
        if (!Number.isSafeInteger(m.length) || m.length < 1 || m.length > 2000000)
          throw new Error('Invalid track size.');
        this.#trackUploads.set(id, {
          transferId: m.transferId,
          cupId: m.cupId,
          length: m.length,
          data: '',
          seq: 0,
          until: Date.now() + 30000,
        });
        return;
      }
      const u = this.#trackUploads.get(id);
      if (!u || u.transferId !== m.transferId || u.cupId !== m.cupId || u.until < Date.now())
        throw new Error('Track transfer expired. Select the track again.');
      if (m.type === 'track-chunk') {
        if (
          m.seq !== u.seq ||
          typeof m.data !== 'string' ||
          !m.data.length ||
          m.data.length > 24000 ||
          u.data.length + m.data.length > u.length
        )
          throw new Error('Invalid track chunk.');
        u.data += m.data;
        u.seq++;
        return;
      }
      if (m.type === 'track-end') {
        if (u.data.length !== u.length) throw new Error('Incomplete track upload. Try again.');
        this.#trackUploads.delete(id);
        this.acceptTrack(id, u.data);
        this.#transport.send(id, { type: 'track-ack', transferId: m.transferId });
      }
    } catch (e) {
      this.#trackUploads.delete(id);
      this.#transport.send(id, {
        type: 'track-ack',
        transferId: m.transferId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  availableTracks() {
    if (!this.#native?.trackLibrary)
      throw new Error(
        'The game track library is not ready. Open the normal track selector once, then try again.',
      );
    const tracks: LibraryTrack[] = [];
    this.#native.trackLibrary.forEachTrack(
      (id, metadata, category, _environment, load, thumbnail) => {
        tracks.push({
          id,
          name: metadata.name,
          author: metadata.author,
          category,
          thumbnail,
          load,
        });
      },
    );
    return tracks;
  }
  allowedTracks() {
    return this.availableTracks().filter(
      (t) => poolAllows(rulesFor(this.cup), t.category) && !this.cup.removedTracks?.includes(t.id),
    );
  }
  async loadRandomTrack(state: CupState, timeoutMs = 20000, excluded?: string) {
    const pool = this.allowedTracks().filter((t) => t.id !== excluded);
    const previous = Cup.currentMatch(state)?.randomTrack?.id;
    const choices = pool.length > 1 ? pool.filter((t) => t.id !== previous) : pool;
    if (!choices.length) throw new Error('No tracks are available in the preset’s track pool.');
    return this.loadTrackEntry(state, choices[Math.floor(Math.random() * choices.length)], timeoutMs);
  }
  async loadTrackEntry(state: CupState, entry: LibraryTrack, timeoutMs = 20000) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const track = await Promise.race([
      entry.load(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error('The random track took too long to load. Try starting the round again.'),
            ),
          timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    if (track.trackData.getId() !== entry.id || !track.trackData.hasStartingPoint())
      throw new Error('The selected random track could not be loaded. Try again.');
    const r = rulesFor(state);
    const wr =
      r.warmup !== 'off' && r.warmupTiming === 'wr'
        ? await this.worldRecordForStart(entry.id)
        : (state.records[entry.id]?.wr ?? { status: 'unavailable' as const });
    return {
      entry,
      track: { ...track, code: track.trackData.toExportString(track.trackMetadata) },
      wr,
    };
  }
  async addLibraryTrack(entry: LibraryTrack) {
    const state = this.#state,
      connection = this.#connection;
    if (state?.phase !== 'registration')
      throw new Error('Tracks can only be selected during registration.');
    const track = await entry.load();
    if (this.#state !== state || this.#connection !== connection || state.phase !== 'registration')
      throw new Error('The tournament changed while the track was loading. Select it again.');
    // Export the actual native track, so native multiplayer transfers work even when
    // other players have never installed this custom track.
    await this.importTrack(track.trackData.toExportString(track.trackMetadata));
    this.#error = '';
    this.#onChange();
  }
  change(fn: StateMutation) {
    this.requireHost();
    const before = this.cup.runtime ? structuredClone(this.cup.runtime) : null;
    const undone = fn === Cup.undoRound ? Cup.currentMatch(this.cup)?.roundsLog.at(-1) : null;
    this.ensureReview();
    fn(this.cup);
    if (before && [Cup.completeRound, Cup.voidRound].includes(fn))
      this.#review.close({ runtime: before }, fn === Cup.completeRound ? 'scored' : 'void');
    if (undone) this.#review.undo(undone.round, undone.trackId);
    this.#error = '';
    this.broadcast();
    this.#onChange();
  }
  syncReconnect() {
    const state = this.#state,
      connection = this.#connection;
    this.#reconnect.reset(state?.id ?? '');
    if (!state || !connection) {
      return;
    }
    if (this.#isHost) {
      this.#reconnect.sync(
        this.#lobby.map((p) => p.id),
        state.roster.map((p) => p.id),
      );
      return;
    }
    if (Cup.player(state, this.#selfId)) {
      this.#reconnectPending = false;
    }
    if (!this.#native.reconnectIdentity || !this.#game || this.#selfId === null) return;
    if (this.#identityCup !== state.id) {
      this.#identityCup = state.id;
      this.#lastIdentity = 0;
      this.#identity = this.#native.reconnectIdentity(this.#game, state.id);
      // Never fall back to nickname matching when profile proof is unavailable.
      void this.#identity.catch(() => {});
    }
    // Not So Weekly Shorts: a racer already on the roster has nothing to prove; others repeat slowly.
    if (Cup.player(state, this.#selfId) && !state.withdrawn?.includes(this.#selfId)) return;
    if (Date.now() - this.#lastIdentity < 4000) return;
    this.#lastIdentity = Date.now();
    void this.#identity
      ?.then((identity) => {
        if (this.#connection === connection && this.#state?.id === state.id)
          this.#transport.send(0, {
            type: 'identity-open',
            cupId: state.id,
            publicKey: identity.publicKey,
          });
      })
      .catch(() => {});
  }
  restoreRacer(id: number) {
    const s = this.#state,
      owner = this.#reconnect.owner(id);
    const key = this.#reconnect.key(id);
    if (
      s &&
      rosterOpen(s) &&
      key &&
      this.#setupDepartures.get(key) === s.id &&
      !Cup.player(s, id) &&
      s.roster.length < 8 &&
      !s.roster.some((p) => this.#reconnect.key(p.id) === key)
    ) {
      const peer = this.#lobby.find((p) => p.id === id);
      if (peer) {
        Cup.addPlayer(s, id, peer.nickname);
        this.#setupDepartures.delete(key);
        this.broadcast();
      }
    }
    if (
      !s ||
      s.phase === 'complete' ||
      owner === null ||
      owner === id ||
      !Cup.player(s, owner) ||
      Cup.player(s, id) ||
      this.#lobby.some((p) => p.id === owner)
    )
      return;
    this.#pendingReconnects.set(id, owner);
    if (s.runtime)
      this.#transport.send(id, { type: 'reconnect-queued', cupId: s.id, racerId: owner });
    else this.applyReconnects();
  }
  async receiveReconnect(id: number, message: Message) {
    if (!('cupId' in message) || message.cupId !== this.#state?.id || !this.#state) return;
    const state = this.#state,
      connection = this.#connection;
    if (this.#isHost) {
      if (!this.#hello.has(id) || !this.#lobby.some((p) => p.id === id)) return;
      this.#reconnect.reset(state.id);
      if (message.type === 'identity-open' && validPublicKey(message.publicKey)) {
        if (this.#reconnect.verified(id, message.publicKey)) {
          this.restoreRacer(id);
          return;
        }
        const nonce = this.#reconnect.challenge(id, message.publicKey);
        if (nonce) this.#transport.send(id, { type: 'identity-challenge', cupId: state.id, nonce });
      } else if (
        message.type === 'identity-proof' &&
        typeof message.nonce === 'string' &&
        typeof message.signature === 'string'
      ) {
        if (!(await this.#reconnect.prove(id, message.nonce, message.signature))) return;
        if (
          this.#state !== state ||
          this.#connection !== connection ||
          !this.#lobby.some((p) => p.id === id)
        )
          return;
        this.#reconnect.sync(
          this.#lobby.map((p) => p.id),
          state.roster.map((p) => p.id),
        );
        this.restoreRacer(id);
      }
    } else if (id === 0) {
      if (
        message.type === 'reconnect-queued' &&
        Cup.player(state, message.racerId) &&
        !Cup.player(state, this.#selfId)
      ) {
        if (this.#reconnectPending) return;
        this.#reconnectPending = true;
        this.requestPanel(false);
        this.#onChange();
        return;
      }
      if (
        message.type === 'identity-challenge' &&
        typeof message.nonce === 'string' &&
        /^[a-f0-9]{64}$/.test(message.nonce)
      ) {
        if (this.#identityCup !== state.id || !this.#identity) return;
        const identity = await this.#identity,
          signature = await identity.sign(message.nonce);
        if (this.#state?.id === state.id && this.#connection === connection)
          this.#transport.send(0, {
            type: 'identity-proof',
            cupId: state.id,
            nonce: message.nonce,
            signature,
          });
      }
    }
  }
  recoveryRacers() {
    return (
      this.#state?.roster.filter(
        (p) =>
          !this.#state?.withdrawn?.includes(p.id) &&
          (this.#needsRebind.has(p.id) || !this.#lobby.some((l) => l.id === p.id)),
      ) ?? []
    );
  }
  applyReconnects() {
    if (!this.#state || this.#state.runtime || this.#state.phase === 'complete') return;
    for (const [id, owner] of this.#pendingReconnects) {
      if (
        !this.#lobby.some((p) => p.id === id) ||
        this.#reconnect.owner(id) !== owner ||
        !Cup.player(this.#state, owner) ||
        Cup.player(this.#state, id)
      ) {
        this.#pendingReconnects.delete(id);
        continue;
      }
      if (this.#lobby.some((p) => p.id === owner) || !this.#transport.has(id)) continue;
      const name = this.#lobby.find((p) => p.id === id)!.nickname;
      this.rebindRacer(owner, id, name);
      if (
        this.#resumeRacers.delete(owner) &&
        this.cup.withdrawn?.includes(id) &&
        Cup.occupiedSlots(this.cup) < 8
      )
        Cup.enterRunningCup(this.cup, id, name);
      this.#pendingReconnects.delete(id);
    }
  }
  rebindRacer(oldId: number, newId: number, name: string) {
    this.requireHost();
    if (this.cup.runtime) throw new Error('Void the round before reconnecting a racer.');
    if (!this.#needsRebind.has(oldId) && this.#reconnect.owner(newId) !== oldId)
      throw new Error('The returning player has not proved ownership of this racer.');
    if (!this.#lobby.some((p) => p.id === newId)) throw new Error('Choose a connected player.');
    if (newId !== this.#selfId && (!this.#hello.has(newId) || !this.#transport.has(newId)))
      throw new Error('Wait for the returning player to load PolyCup.');
    if (oldId !== newId && this.#lobby.some((p) => p.id === oldId) && !this.#needsRebind.has(oldId))
      throw new Error('That racer is still connected.');
    if (oldId !== newId) Cup.rebindPlayer(this.cup, oldId, newId, name);
    else Cup.touch(this.cup);
    if (oldId !== newId) this.#review.rebind(oldId, newId);
    this.#reconnect.rebind(oldId, newId);
    this.#needsRebind.delete(oldId);
    this.#unavailableSince.delete(oldId);
    this.#error = '';
    this.broadcast();
    this.#onChange();
  }
  action(type: ActionType, value?: string) {
    if (this.localPlayerId === null) return;
    if (type === 'dnf') this.flushInputs();
    if (this.#isHost)
      this.handleAction(this.localPlayerId, { type, value, cupId: this.#state?.id });
    else
      return this.#actions.run(type, (requestId) =>
        this.#transport.send(0, { type, value, cupId: this.#state?.id, requestId }),
      );
  }
  handleAction(actor: number, m: ActionMessage) {
    if (!this.#state || (!this.#hello.has(actor) && actor !== this.localPlayerId)) return false;
    if (m.cupId !== this.cup.id) return false;
    if (m.type === 'join') {
      const p = this.#lobby.find((p) => p.id === actor);
      if (!p) return false;
      if (this.#state.phase === 'registration') {
        Cup.addPlayer(this.#state, actor, p.nickname);
        this.#reconnect.sync(
          this.#lobby.map((p) => p.id),
          this.#state.roster.map((p) => p.id),
        );
      } else Cup.enterRunningCup(this.#state, actor, p.nickname);
    } else if (m.type === 'leave') {
      if (this.#state.phase === 'registration') {
        Cup.removePlayer(this.#state, actor);
        this.pruneTrackData();
      } else {
        this.#resumeRacers.delete(actor);
        Cup.leaveRunningCup(this.#state, actor);
      }
    } else if (m.type === 'remove-pick') {
      Cup.removePick(this.#state, actor, m.value ?? '');
      this.pruneTrackData();
    } else if (m.type === 'ban') {
      const track = this.allowedTracks().find(
        (t) => t.id === m.value && ['official', 'community'].includes(t.category),
      );
      banTrack(this.#state, actor, track);
    } else if (m.type === 'dnf' && m.value === this.cup.runtime?.id) {
      const before = standings(this.cup).map((r) => r.id);
      Cup.markDNF(this.#state, actor);
      updateLiveMovement(this.cup, before);
    } else if (m.type === 'practice-ready') {
      if (!Cup.practiceReady(this.#state, actor, m.value ?? '')) return false;
      this.advanceClock();
    } else if (m.type === 'skip-vote') {
      if (m.value !== Cup.skipTarget(this.#state)) return false;
      if (Cup.voteSkip(this.#state, actor)) {
        const run = this.#state.runtime;
        // Not So Weekly Shorts: once someone has finished, the round still counts and the vote ends
        // the track after it.
        if (this.#state.phase === 'racing' && run && Object.keys(run.finishes).length) {
          this.#state.skipVote!.passed = true;
          Cup.note(this.#state, 'Racers voted to skip the track. This round still counts; it is the last one here.');
          Cup.touch(this.#state);
        } else {
          this.skipTrack();
          return true;
        }
      }
    } else if (m.type === 'track-vote') {
      const v = this.#state.trackVote;
      if (!v || !v.options.some((t) => t.id === m.value) || !Cup.activeIds(this.#state).includes(actor))
        return false;
      if (v.mode !== 'vote' && actor !== v.picker)
        throw new Error('Another racer is picking the next track.');
      v.votes[actor] = m.value!;
      Cup.touch(this.#state);
      this.settleTrackVote(this.#state);
    } else return false;
    this.broadcast();
    return true;
  }
  async enrollRacer(id: number, action: ActionMessage) {
    const state = this.#state,
      connection = this.#connection;
    if (!this.#hello.has(id)) throw new Error('The connection to the cup changed.');
    if (
      !state ||
      action.cupId !== state.id ||
      (state.phase !== 'registration' && !rulesFor(state).allowRacerChanges)
    )
      throw new Error('This preset locks the racer roster during the Cup.');
    const deadline = Date.now() + 10000;
    while (!this.#reconnect.authenticated(id) && !Cup.player(state, id)) {
      if (
        this.#state !== state ||
        this.#connection !== connection ||
        !this.#lobby.some((p) => p.id === id)
      )
        throw new Error('The connection to the cup changed.');
      if (Date.now() > deadline)
        throw new Error('Could not verify your profile. Rejoin the lobby and try again.');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.#state !== state || this.#connection !== connection || !this.#hello.has(id))
      throw new Error('The Cup changed.');
    if (Cup.activeIds(state).includes(id) || state.pendingRacers?.includes(id)) return;
    const owner = this.#reconnect.owner(id);
    if (owner !== null && owner !== id && Cup.player(state, owner)) {
      if (this.#lobby.some((p) => p.id === owner))
        throw new Error('This profile is already connected to the Cup.');
      if (state.withdrawn?.includes(owner) && Cup.occupiedSlots(state) >= 8)
        throw new Error('All eight racer places are filled.');
      this.#resumeRacers.add(owner);
      this.restoreRacer(id);
    } else this.handleAction(id, action);
  }
  receive(id: number, m: Message) {
    if (m.type === 'physics') {
      if (
        this.#isHost &&
        this.#hello.has(id) &&
        m.cupId === this.#state?.id &&
        validPhysicsReport(m.report)
      )
        this.#physicsReports.set(id, { cupId: m.cupId, report: { ...m.report } });
      return;
    }
    if (m.type === 'viewers') {
      if (
        !this.#isHost &&
        id === 0 &&
        m.cupId === this.#state?.id &&
        m.roundId === this.#state?.runtime?.id &&
        Number.isSafeInteger(m.count) &&
        m.count >= 0 &&
        m.count <= 128
      ) {
        this.#viewerCount = m.count;
        this.#viewerRound = m.roundId;
      }
      return;
    }
    if (
      ['identity-open', 'identity-challenge', 'identity-proof', 'reconnect-queued'].includes(m.type)
    ) {
      void this.receiveReconnect(id, m).catch(() => {});
      return;
    }
    if (this.#isHost) {
      if (m.type === 'hello' && m.version === Cup.VERSION && Number.isFinite(m.sentAt)) {
        const fresh = !this.#hello.has(id);
        this.#hello.add(id);
        this.#transport.send(id, {
          type: 'hello-ack',
          version: Cup.VERSION,
          sentAt: m.sentAt,
          hostAt: Date.now(),
        });
        // Later states arrive with every broadcast.
        if (fresh) this.#transport.send(id, this.syncMessage());
      } else if (m.type === 'ready' && this.#hello.has(id)) this.markReady(id, m);
      else if (m.type === 'finish' && this.#hello.has(id)) this.receiveFinish(id, m);
      else if (m.type === 'checkpoint' && this.#hello.has(id)) this.receiveCheckpoint(id, m);
      else if (m.type === 'inputs') this.receiveInputs(id, m);
      else if (m.type === 'watch' && this.#hello.has(id)) {
        if (
          m.value !== null &&
          Cup.mayWatch(this.#state, id) &&
          this.watchable().includes(m.value)
        ) {
          if (
            m.previous !== undefined &&
            m.previous !== null &&
            m.previous !== m.value &&
            (this.#subscriptions.get(id) === m.previous ||
              this.#handoffSubscriptions.get(id) === m.previous) &&
            this.watchable().includes(m.previous)
          )
            this.#handoffSubscriptions.set(id, m.previous);
          else this.#handoffSubscriptions.delete(id);
          this.#subscriptions.set(id, m.value);
          const context = this.inputContext(),
            timeline = this.#liveInputs.get(m.value);
          if (context && timeline)
            this.#transport.send(id, {
              type: 'input-view',
              ...context,
              racerId: m.value,
              ...timeline.snapshot(),
            });
        } else {
          this.#subscriptions.delete(id);
          this.#handoffSubscriptions.delete(id);
        }
      } else if (m.type === 'pb' && this.#hello.has(id)) this.receivePB(id, m);
      else if (['track-begin', 'track-chunk', 'track-end'].includes(m.type))
        this.receiveTrack(id, m as TrackMessage);
      else if (m.type === 'bump' && this.#hello.has(id)) this.relayBump(id, m);
      else if (['join', 'leave', 'dnf', 'practice-ready', 'ban', 'remove-pick', 'skip-vote', 'track-vote'].includes(m.type)) {
        const action = m as ActionMessage;
        if (
          action.requestId !== undefined &&
          (typeof action.requestId !== 'string' || action.requestId.length > 80)
        )
          return;
        if (action.type === 'join' && !Cup.player(this.#state, id)) {
          if (this.#enrolling.has(id)) return;
          this.#enrolling.add(id);
          void this.enrollRacer(id, action)
            .then(() => {
              if (action.requestId)
                this.#transport.send(id, { type: 'action-ack', requestId: action.requestId });
            })
            .catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              this.#transport.send(
                id,
                action.requestId
                  ? { type: 'action-ack', requestId: action.requestId, error: message }
                  : { type: 'error', message },
              );
            })
            .finally(() => this.#enrolling.delete(id));
          return;
        }
        let error: string | undefined;
        try {
          if (!this.handleAction(id, action))
            error = 'This action is no longer available. Please try again.';
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        if (action.requestId)
          this.#transport.send(id, { type: 'action-ack', requestId: action.requestId, error });
        else if (error) this.#transport.send(id, { type: 'error', message: error });
      }
    } else if (id === 0) {
      if (m.type === 'action-ack') {
        const acknowledged = this.#actions.acknowledge(
          m.requestId,
          m.error ? String(m.error).slice(0, 200) : undefined,
        );
        if (acknowledged && m.error) {
          this.#error = String(m.error).slice(0, 200);
          this.#errorAt = Date.now();
        }
      } else if (m.type === 'input-view') this.receiveInputView(id, m);
      else if (m.type === 'bump' && m.cupId === this.#state?.id && m.roundId === this.#state?.runtime?.id && Array.isArray(m.impulse) && m.impulse.length === 3 && m.impulse.every((n) => Number.isFinite(n) && Math.abs(n) <= 40))
        this.receiveBump(m.impulse);
      else if (m.type === 'track-ack' && this.#pendingUpload?.transferId === m.transferId) {
        this.#pendingUpload.done = !m.error;
        this.#pendingUpload.error = m.error ? String(m.error).slice(0, 200) : null;
      } else if (m.type === 'hello-ack' && Number.isFinite(m.sentAt) && Number.isFinite(m.hostAt)) {
        const rtt = Date.now() - m.sentAt;
        if (rtt >= 0 && rtt < this.#bestRtt) {
          this.#bestRtt = rtt;
          this.#offset = m.hostAt + rtt / 2 - Date.now();
        }
      } else if (
        m.type === 'state' &&
        Number.isSafeInteger(m.sequence) &&
        m.sequence > this.#receivedSequence &&
        (m.state === null || validSnapshot(m.state))
      ) {
        this.#receivedSequence = m.sequence;
        if (m.state === null) {
          if (this.#state) {
            this.releaseCup('The organizer ended the cup');
            this.onCupEnded?.(false);
          }
        } else {
          this.#state = { ...m.state, history: [] };
          // Not So Weekly Shorts: an error stays readable for a while instead of vanishing with the
          // next state (about once a second).
          if (Date.now() - this.#errorAt > 6000) this.#error = '';
        }
        this.syncRoundPanel();
      } else if (m.type === 'error') {
        this.#error = String(m.message).slice(0, 200);
        this.#errorAt = Date.now();
      }
    }
    this.#onChange();
  }
  refreshRecords() {
    if (this.localPlayerId === null) return;
    if (Date.now() - this.#lastRecordPoll < 5000 || !this.#native?.personalBest || !this.#state)
      return;
    this.#lastRecordPoll = Date.now();
    const state = this.#state,
      cupId = state.id,
      connection = this.#connection;
    const trackId = state.runtime?.trackId ?? Cup.nextTrack(state);
    if (!trackId) return;
    const stillCurrent = () => this.#state?.id === cupId && this.#connection === connection;
    const launch = (key: string, interval: number, fn: () => Promise<void>) => {
      const old = this.#recordRequests.get(key);
      if (old && (old.pending || old.until > Date.now())) return;
      const request = { pending: true, until: Date.now() + interval };
      this.#recordRequests.set(key, request);
      Promise.resolve()
        .then(fn)
        .catch(() => {})
        .finally(() => {
          request.pending = false;
        });
    };
    if (Cup.player(state, this.localPlayerId)) {
      const actor = this.localPlayerId;
      launch(`${cupId}:pb:${trackId}:${actor}`, 5000, async () => {
        const pb = await this.#native.personalBest(this.activeGame, trackId);
        if (!stillCurrent() || this.#selfId !== actor || !validPB(pb)) return;
        const message: Extract<Message, { type: 'pb' }> = { type: 'pb', cupId, trackId, pb };
        if (this.#isHost) this.receivePB(actor, message);
        else this.#transport.send(0, message);
      });
    }
    if (this.#isHost)
      launch(`${cupId}:wr:${trackId}`, 120000, async () => {
        const wr = await this.#native.worldRecord(this.activeGame, trackId);
        if (!stillCurrent() || !this.cup.tracks.some((t) => t.id === trackId)) return;
        const records = (this.cup.records[trackId] ??= { pbs: {} });
        if (JSON.stringify(records.wr) !== JSON.stringify(wr)) {
          records.wr = wr;
          Cup.touch(this.cup);
          this.broadcast();
        }
      });
  }
  receivePB(actor: number, m: Extract<Message, { type: 'pb' }>) {
    const s = this.#state;
    if (
      !s ||
      m.cupId !== s.id ||
      !Cup.player(s, actor) ||
      !s.tracks.some((t) => t.id === m.trackId) ||
      !validPB(m.pb)
    )
      return;
    const pb: RaceRecord =
      m.pb.status === 'ready'
        ? { status: 'ready', frames: m.pb.frames, source: m.pb.source }
        : { status: m.pb.status };
    const r = (s.records[m.trackId] ??= { pbs: {} });
    if (JSON.stringify(r.pbs[actor]) !== JSON.stringify(pb)) {
      r.pbs[actor] = pb;
      Cup.touch(s);
      this.broadcast();
    }
  }
  async worldRecordForStart(
    trackId: string,
    game: NativeGame | null = this.#game,
    timeoutMs = 5000,
  ): Promise<RaceRecord> {
    let timer;
    try {
      const wr = await Promise.race([
        Promise.resolve().then(() => this.#native.worldRecord(game!, trackId)),
        new Promise<RaceRecord>((resolve) => {
          timer = setTimeout(() => resolve({ status: 'unavailable' }), timeoutMs);
        }),
      ]);
      return validWR(wr) ? wr : { status: 'unavailable' };
    } catch {
      return { status: 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }
  async startCup() {
    this.requireHost();
    if (this.#startingCup) return;
    if (this.#state?.phase !== 'registration') throw new Error('The Cup has already started.');
    const state = this.#state,
      connection = this.#connection,
      game = this.#game;
    const setup = () =>
      JSON.stringify([
        state.roster.map((p) => p.id),
        state.picks,
        state.selections,
        state.draft,
        state.preset,
      ]);
    const before = setup();
    // Validate before any requests, then again after they settle in case a racer left.
    const random = rulesFor(state).selection === 'random';
    if (!random) Cup.lockRegistration(structuredClone(state));
    else if (state.roster.length < 2) throw new Error('Two to eight racers can start a Cup.');
    this.requireStartRacers();
    const request = {};
    this.#startingCup = request;
    this.#error = '';
    this.#onChange();
    try {
      if (random) {
        const { entry, track, wr } = await this.loadRandomTrack(state);
        if (
          this.#state !== state ||
          this.#connection !== connection ||
          setup() !== before ||
          this.#startingCup !== request
        )
          throw new Error('The lobby or preset changed. Start the Cup again.');
        state.tracks = [{ id: entry.id, name: entry.name }];
        state.records = { [entry.id]: { pbs: {}, wr } };
        this.#tracks.set(entry.id, track);
      }
      const records = await Promise.all(
        state.tracks.map(
          async (t) =>
            [
              t.id,
              random ? state.records[t.id].wr! : await this.worldRecordForStart(t.id, game),
            ] as const,
        ),
      );
      if (
        this.#startingCup !== request ||
        this.#state !== state ||
        this.#connection !== connection ||
        state.phase !== 'registration'
      )
        return;
      if (setup() !== before)
        throw new Error('Racers or track picks changed. Start the Cup again.');
      this.requireStartRacers();
      for (const [id, wr] of records) (state.records[id] ??= { pbs: {} }).wr = wr;
      Cup.lockRegistration(state);
      this.#trackUploads.clear();
      this.broadcast();
      await this.runRound();
    } finally {
      if (this.#startingCup === request) {
        this.#startingCup = null;
        this.#onChange();
      }
    }
  }
  requireStartRacers() {
    if (
      this.cup.roster
        .filter((p) => !this.cup.withdrawn?.includes(p.id))
        .some(
          (p) =>
            this.#needsRebind?.has(p.id) ||
            !this.#lobby.some((l) => l.id === p.id) ||
            (p.id !== this.#selfId && (!this.#hello.has(p.id) || !this.#transport.has(p.id))),
        )
    )
      throw new Error('Every racer must be connected with the current mod before starting.');
  }
  networkState() {
    const state = Cup.publicState(this.cup);
    const racers = new Set([...Cup.activeIds(this.cup), ...(state.pendingRacers ?? [])]);
    for (const record of Object.values(state.records))
      record.pbs = Object.fromEntries(
        Object.entries(record.pbs).filter(([id]) => racers.has(Number(id))),
      );
    // The complete journal stays on the host/export; live peers need only the latest round.
    state.audit = state.audit.slice(-8);
    state.matches.forEach((m) => {
      m.roundsLog = m.roundsLog.slice(-1);
    });
    if (rulesFor(this.cup).selection === 'random') {
      const keep = new Set([
        state.runtime?.trackId,
        ...state.matches.flatMap((m) => [m.randomTrack?.id, ...m.roundsLog.map((r) => r.trackId)]),
      ]);
      state.tracks = state.tracks.filter((t) => keep.has(t.id));
      state.records = Object.fromEntries(
        Object.entries(state.records).filter(([id]) => keep.has(id)),
      );
      for (const m of state.matches) {
        m.order = m.order.filter((id) => keep.has(id));
        if (m.trackRounds)
          m.trackRounds = Object.fromEntries(
            Object.entries(m.trackRounds).filter(([id]) => keep.has(id)),
          );
        if (m.trackWarmups)
          m.trackWarmups = Object.fromEntries(
            Object.entries(m.trackWarmups).filter(([id]) => keep.has(id)),
          );
      }
    }
    return state;
  }
  broadcast() {
    this.#transport.broadcast(this.syncMessage());
    this.#sentRevision = this.#state?.revision;
    this.#lastBroadcast = Date.now();
  }
  syncMessage(): Extract<Message, { type: 'state' }> {
    this.syncRoundPanel();
    return {
      type: 'state',
      sequence: ++this.#syncSequence,
      state: this.#state ? this.networkState() : null,
    };
  }
  async removeTrack() {
    this.requireHost();
    const state = this.cup,
      visit = Cup.currentTrackVisit(state),
      connection = this.#connection;
    if (!visit || this.#removingTrack) return;
    this.#removingTrack = true;
    this.#setNextAuto(null);
    try {
      const match = Cup.currentMatch(state);
      const needsReplacement =
        rulesFor(state).selection === 'random' ||
        !match.order.some((id) => id !== visit.trackId && !state.removedTracks?.includes(id));
      const replacement = needsReplacement
        ? await this.loadRandomTrack(state, 20000, visit.trackId)
        : null;
      if (
        state !== this.#state ||
        connection !== this.#connection ||
        Cup.currentTrackVisit(state)?.trackId !== visit.trackId
      )
        throw new Error('The Cup changed while preparing the next track.');
      this.#review.close(state, 'void');
      if (replacement) this.#tracks.set(replacement.entry.id, replacement.track);
      Cup.removeCurrentTrack(
        state,
        replacement ? { id: replacement.entry.id, name: replacement.entry.name } : undefined,
        replacement?.wr,
      );
      this.#review.undoTrackVisit(visit.trackId, visit.fromRound);
      this.#loadingSession = undefined;
      this.broadcast();
    } finally {
      this.#removingTrack = false;
      this.#onChange();
    }
    // Not So Weekly Shorts: if the game isn't ready to start yet, the next round starts as soon as it is.
    try {
      return await this.runRound();
    } catch {
      this.#startSoon = true;
    }
  }
  runRound(): void | Promise<void> {
    if (this.#removingTrack) return;
    this.requireHost();
    if (this.#preparingRandom === this.#prefetch && this.#prefetch)
      return this.#prefetch.then(() => {
        if (this.#state?.phase === 'between-rounds' && !this.#preparingRandom) return this.runRound();
      });
    // Not So Weekly Shorts: a track still loading (vote, skip) starts the round once it is ready.
    if (this.#preparingRandom)
      return this.#preparingRandom.then(() => {
        if (this.#state?.phase === 'between-rounds' && !this.#preparingRandom) return this.runRound();
      });
    if (this.cup.roster.some((p) => this.#needsRebind?.has(p.id)))
      throw new Error('Confirm every saved racer’s lobby identity in Racers before resuming.');
    this.updateAvailability();
    this.applyReconnects();
    this.admitRacers();
    if (!this.canStartRound()) {
      // Not So Weekly Shorts: start as soon as everyone (and the game) is ready, instead of failing.
      this.#startSoon = true;
      this.#onChange();
      return;
    }
    if (rulesFor(this.cup).selection === 'random' && !Cup.nextTrack(this.cup)) {
      const state = this.cup,
        connection = this.#connection;
      this.#setNextAuto(null);
      // Not So Weekly Shorts: racers choose the next track first when the preset says so.
      if (this.voting(state)) {
        this.#startSoon = true;
        if (!state.trackVote) this.openTrackVote(state);
        return;
      }
      const request = this.loadRandomTrack(state)
        .then(({ entry, track, wr }) => {
          if (
            this.#state !== state ||
            this.#connection !== connection ||
            state.phase !== 'between-rounds'
          )
            return;
          this.#tracks.set(entry.id, track);
          Cup.scheduleRandomTrack(state, { id: entry.id, name: entry.name }, wr);
          this.#preparingRandom = null;
          return this.runRound();
        })
        .finally(() => {
          if (this.#preparingRandom === request) this.#preparingRandom = null;
          this.#onChange();
        });
      this.#preparingRandom = request;
      this.#onChange();
      return request;
    }
    const track = this.#tracks.get(Cup.nextTrack(this.cup)!);
    if (!track) throw new Error('The selected track is missing from this organizer’s saved pack.');
    Cup.beginRound(this.cup);
    for (const id of Cup.activeIds(this.cup))
      if (!this.racerAvailable(id)) Cup.sitOut(this.cup, id);
    this.#readyKey = '';
    this.#lastReady = 0;
    this.#loadingSince = 0;
    this.#nextAuto = null;
    this.#retireArmed = 0;
    this.#loadingSession = this.gameInfo.sessionId;
    this.broadcast();
    const mode = rulesFor(this.cup).uploadLeaderboardTimes === true ? 0 : 1;
    this.#loadingStart = { at: Date.now(), roundId: this.cup.runtime!.id, mode, track };
    this.#connection!.startNewSession(mode, track.trackMetadata, track.trackData);
  }
  // Not So Weekly Shorts: if the game's new session never arrives (the round would sit on "Preparing
  // next round..."), ask for it again.
  #loadingStart: { at: number; roundId: string; mode: number; track: LoadedTrack } | null = null;
  watchLoading() {
    const run = this.cup.runtime,
      start = this.#loadingStart;
    if (!start || !run || this.cup.phase !== 'loading' || run.id !== start.roundId || run.sessionId !== null)
      return;
    if (Date.now() - start.at < 8000) return;
    start.at = Date.now();
    this.#loadingSession = this.gameInfo.sessionId;
    this.#connection?.startNewSession(start.mode, start.track.trackMetadata, start.track.trackData);
  }
  // Not So Weekly Shorts: start the next round as soon as the game allows (after a restart, or
  // when the organizer has automatic rounds off).
  #startSoon = false;
  restartRound() {
    this.requireHost();
    if (!this.cup.runtime) return;
    this.voidRound();
    this.cup.audit.pop();
    Cup.note(this.cup, 'The organizer restarted the round. Nobody scored the stopped attempt.');
    Cup.touch(this.cup);
    this.#setNextAuto(null);
    this.#startSoon = true;
  }
  racerAvailable(id: number) {
    return (
      !this.#needsRebind.has(id) &&
      this.#lobby.some((p) => p.id === id) &&
      (id === this.#selfId || (this.#hello.has(id) && this.#transport.has(id)))
    );
  }
  admitRacers() {
    const s = this.cup;
    if (s.runtime || s.phase !== 'between-rounds') return;
    for (const id of s.pendingRacers ?? [])
      if (!this.#lobby.some((p) => p.id === id)) this.#resumeRacers.add(id);
    Cup.admitPendingRacers(
      s,
      this.#lobby.map((p) => p.id),
    );
  }
  updateAvailability() {
    for (const id of Cup.activeIds(this.#state)) {
      if (this.racerAvailable(id)) this.#unavailableSince.delete(id);
      else if (!this.#unavailableSince.has(id)) this.#unavailableSince.set(id, this.now());
    }
  }
  canStartRound() {
    const ids = Cup.activeIds(this.#state);
    return (
      !!this.#info &&
      !this.#info.disposed &&
      !this.#needsRebind.size &&
      ids.some((id) => this.racerAvailable(id)) &&
      ids.every(
        (id) =>
          this.racerAvailable(id) ||
          this.now() - (this.#unavailableSince.get(id) ?? this.now()) >= RECONNECT_GRACE_MS,
      )
    );
  }
  waitingForRacers() {
    return (
      this.#state?.phase === 'between-rounds' &&
      (this.#needsRebind.size > 0 ||
        !Cup.activeIds(this.#state).some((id) => this.#lobby.some((p) => p.id === id)))
    );
  }
  checkDisconnects() {
    const s = this.#state;
    if (s?.phase === 'registration') {
      const missing = s.roster.filter((p) => !this.#lobby.some((peer) => peer.id === p.id));
      if (missing.length) {
        if (!rosterOpen(s)) resetDraft(s);
        for (const p of missing) {
          const key = this.#reconnect.ownerKey(p.id);
          if (key) this.#setupDepartures.set(key, s.id);
          Cup.removePlayer(s, p.id);
          this.#needsRebind.delete(p.id);
          this.#unavailableSince.delete(p.id);
        }
        this.pruneTrackData();
        this.broadcast();
      }
      return;
    }
    this.updateAvailability();
    if (s && rulesFor(s).allowRacerChanges && !['registration', 'complete'].includes(s.phase)) {
      for (const id of this.#resumeRacers) {
        if (s.withdrawn?.includes(id) && this.racerAvailable(id) && Cup.occupiedSlots(s) < 8) {
          Cup.enterRunningCup(s, id, Cup.player(s, id)!.name);
          this.#resumeRacers.delete(id);
        }
      }
    }
    if (s && rulesFor(s).allowRacerChanges && !['registration', 'complete'].includes(s.phase)) {
      for (const id of Cup.activeIds(s))
        if (
          this.#unavailableSince.has(id) &&
          this.now() - this.#unavailableSince.get(id)! >= RECONNECT_GRACE_MS
        ) {
          this.#resumeRacers.add(id);
          Cup.leaveRunningCup(s, id);
        }
    }
    if (!s?.runtime) return;
    // Not So Weekly Shorts: a racer who leaves gets a DNF for this round straight away and everyone
    // else keeps racing; one whose connection only stutters gets the usual grace period first.
    const missing = Cup.racingIds(s).filter(
      (id) =>
        this.#unavailableSince.has(id) &&
        (!this.#lobby.some((p) => p.id === id) ||
          this.now() - this.#unavailableSince.get(id)! >= RECONNECT_GRACE_MS) &&
        !(id in s.runtime!.finishes) &&
        !s.runtime!.dnfs.includes(id),
    );
    if (!missing.length) return;
    const before = standings(s).map((r) => r.id);
    for (const id of missing) Cup.sitOut(s, id);
    updateLiveMovement(s, before);
    Cup.note(s, 'Racers who left sit out this round.');
  }
  sendReady() {
    if (this.localPlayerId === null || !this.#info || this.#info.disposed) return;
    const s = this.cup,
      run = s.runtime;
    if (s.phase !== 'loading' || !run || this.gameInfo.trackData.getId() !== run.trackId) return;
    if (this.#isHost && run.sessionId === null) {
      // startNewSession takes a moment (1 s on this site). Wait for the new native game instance/session.
      if (this.#loadingSession === undefined) {
        this.#loadingSession = this.gameInfo.sessionId;
        return;
      }
      if (this.gameInfo.sessionId === this.#loadingSession) return;
      run.sessionId = this.gameInfo.sessionId;
      this.#loadingSince = this.now();
      Cup.touch(s);
      this.broadcast();
    }
    // Not So Weekly Shorts: if a retried session start produced a newer session, follow it.
    if (
      this.#isHost &&
      run.sessionId !== null &&
      this.gameInfo.sessionId !== run.sessionId &&
      this.gameInfo.sessionId !== this.#loadingSession &&
      this.#loadingStart?.roundId === run.id
    ) {
      run.sessionId = this.gameInfo.sessionId;
      run.ready = [];
      this.#loadingSince = this.now();
      Cup.touch(s);
      this.broadcast();
    }
    if (this.gameInfo.sessionId !== run.sessionId || !Cup.racingIds(s).includes(this.localPlayerId))
      return;
    const key = `${run.id}:${run.sessionId}`;
    if (run.ready.includes(this.localPlayerId)) return;
    if (this.#readyKey === key && this.now() - this.#lastReady < 1000) return;
    const m: ReadyMessage = {
      type: 'ready',
      roundId: run.id,
      sessionId: run.sessionId!,
      trackId: run.trackId,
    };
    if (this.#isHost) this.markReady(this.localPlayerId, m);
    else if (!this.#transport.send(0, m)) return;
    this.#readyKey = key;
    this.#lastReady = this.now();
  }
  markReady(id: number, m: ReadyMessage) {
    const run = this.#state?.runtime;
    if (
      this.#state?.phase !== 'loading' ||
      !run ||
      m.roundId !== run.id ||
      m.sessionId !== run.sessionId ||
      m.trackId !== run.trackId ||
      !Cup.racingIds(this.#state).includes(id) ||
      run.ready.includes(id)
    )
      return;
    run.ready.push(id);
    Cup.touch(this.#state);
  }
  advanceClock() {
    if (this.#removingTrack) return;
    const s = this.#state,
      run = s?.runtime;
    if (!run) return;
    if (s.phase === 'loading' && run.sessionId !== null) {
      if (!this.#loadingSince) this.#loadingSince = this.now();
      if (this.now() - this.#loadingSince >= LOAD_GRACE_MS) {
        for (const id of Cup.racingIds(s)) if (!run.ready.includes(id)) Cup.sitOut(s, id);
      }
    }
    if (['loading', 'warmup', 'countdown'].includes(s.phase) && !Cup.racingIds(s).length) {
      this.#review.close(s, 'void');
      Cup.voidRound(s);
      s.audit.pop();
      Cup.note(s, 'Nobody was left to race the round, so it was voided.');
      this.#setNextAuto(
        this.#auto ? Date.now() + rulesFor(this.#state).roundBreakSeconds * 1000 : null,
      );
      this.broadcast();
      return;
    }
    if (
      s.phase === 'loading' &&
      run.sessionId !== null &&
      Cup.racingIds(s).every((id) => run.ready.includes(id))
    ) {
      s.phase = run.warmup ? 'warmup' : 'countdown';
      run.startsAt =
        this.now() +
        (run.warmup
          ? (Cup.currentMatch(s).trackWarmups?.[run.trackId] ?? Cup.RULES.warmupMs)
          : 3000);
      Cup.touch(s);
      this.broadcast();
    } else if (
      s.phase === 'warmup' &&
      ((run.startsAt !== null && this.now() >= run.startsAt) ||
        (rulesFor(s).readyEndsWarmup &&
          Cup.racingIds(s).every((id) => run.practiceReady?.includes(id))))
    ) {
      s.phase = 'countdown';
      run.startsAt = this.now() + 3000;
      Cup.touch(s);
      this.broadcast();
    } else if (s.phase === 'countdown' && run.startsAt !== null && this.now() >= run.startsAt) {
      Cup.startRace(s, run.startsAt!);
      this.broadcast();
    }
  }
  finishRound() {
    const roundId = this.cup.runtime?.id;
    this.change(Cup.completeRound);
    this.#loadingSession = undefined;
    for (const key of [...this.#verifiedBest.keys()])
      if (key.startsWith(`${roundId}:`)) this.#verifiedBest.delete(key);
    this.#verifying.clear();
    this.#setNextAuto(
      this.#auto && this.cup.phase === 'between-rounds'
        ? Date.now() + rulesFor(this.cup).roundBreakSeconds * 1000
        : null,
    );
    // Not So Weekly Shorts: a skip vote that passed during the round ends the track now.
    if (this.cup.phase === 'between-rounds' && this.cup.skipVote?.passed) this.skipTrack();
    this.broadcast();
  }
  voidRound() {
    this.change(Cup.voidRound);
    this.#loadingSession = undefined;
    this.#loadingStart = null;
    this.#verifying.clear();
    // Not So Weekly Shorts: automatic rounds carry on after a void.
    this.#setNextAuto(this.#auto ? Date.now() + rulesFor(this.cup).roundBreakSeconds * 1000 : null);
  }
  // Not So Weekly Shorts: the next random track loads during the break between rounds, not after it.
  prepareNextRandomTrack() {
    const state = this.#state,
      connection = this.#connection;
    if (
      !state ||
      !this.#isHost ||
      this.#preparingRandom ||
      this.#removingTrack ||
      state.phase !== 'between-rounds' ||
      rulesFor(state).selection !== 'random'
    )
      return;
    if (state.trackVote) {
      this.settleTrackVote(state);
      return;
    }
    if (Cup.nextTrack(state)) return;
    if (this.voting(state)) {
      this.openTrackVote(state);
      return;
    }
    const request = this.loadRandomTrack(state)
      .then(({ entry, track, wr }) => {
        if (
          this.#state !== state ||
          this.#connection !== connection ||
          state.phase !== 'between-rounds' ||
          Cup.nextTrack(state)
        )
          return;
        this.#tracks.set(entry.id, track);
        Cup.scheduleRandomTrack(state, { id: entry.id, name: entry.name }, wr);
        this.broadcast();
      })
      .catch(() => {})
      .finally(() => {
        if (this.#preparingRandom === request) this.#preparingRandom = null;
        if (this.#prefetch === request) this.#prefetch = null;
        this.#onChange();
      });
    this.#preparingRandom = this.#prefetch = request;
  }
  #prefetch: Promise<void> | null = null;
  // Not So Weekly Shorts: a passed skip vote ends the track's block and draws another track.
  skipTrack() {
    const state = this.cup,
      connection = this.#connection;
    if (state.runtime) {
      this.voidRound();
      state.audit.pop();
    }
    if (!state.skipVote?.passed) Cup.note(state, 'Racers voted to skip the track.');
    delete state.skipVote;
    Cup.touch(state);
    this.#setNextAuto(null);
    if (this.voting(state)) {
      this.openTrackVote(state);
      if (this.#auto) this.#startSoon = true;
      this.broadcast();
      this.#onChange();
      return;
    }
    const request = this.loadRandomTrack(state)
      .then(({ entry, track, wr }) => {
        if (this.#state !== state || this.#connection !== connection || state.phase !== 'between-rounds')
          return;
        this.#tracks.set(entry.id, track);
        Cup.scheduleRandomTrack(state, { id: entry.id, name: entry.name }, wr);
        if (this.#auto) this.#setNextAuto(Date.now() + rulesFor(state).roundBreakSeconds * 1000);
      })
      .catch((error) => {
        this.fail(error);
        // Not So Weekly Shorts: the next round draws a random track itself, so keep going.
        if (this.#auto && this.#state === state)
          this.#setNextAuto(Date.now() + rulesFor(state).roundBreakSeconds * 1000);
      })
      .finally(() => {
        if (this.#preparingRandom === request) this.#preparingRandom = null;
        if (this.#state === state) this.broadcast();
        this.#onChange();
      });
    this.#preparingRandom = request;
    this.broadcast();
    this.#onChange();
  }
  // Not So Weekly Shorts: choosing the next random track (preset "Next track": vote / winner / last).
  voting(state: CupState) {
    return rulesFor(state).selection === 'random' && rulesFor(state).nextTrack !== 'random';
  }
  openTrackVote(state: CupState) {
    const rules = rulesFor(state),
      m = Cup.currentMatch(state);
    const previous = m.randomTrack?.id;
    const pool = this.allowedTracks();
    const choices = pool.length > 1 ? pool.filter((t) => t.id !== previous) : pool;
    if (!choices.length) throw new Error('No tracks are available in the preset’s track pool.');
    const options: LibraryTrack[] = [];
    for (const t of [...choices].sort(() => Math.random() - 0.5))
      if (!options.some((o) => o.id === t.id) && options.push(t) >= 3) break;
    const active = Cup.activeIds(state).filter((id) => this.racerAvailable(id));
    const last = m.roundsLog.at(-1);
    let picker: number | null = null;
    if (rules.nextTrack !== 'vote' && last) {
      const finished = Object.keys(last.finishes)
        .map(Number)
        .filter((id) => active.includes(id))
        .sort((a, b) => last.finishes[a] - last.finishes[b]);
      const unfinished = active.filter((id) => !(id in last.finishes));
      picker =
        rules.nextTrack === 'winner'
          ? (finished[0] ?? null)
          : (unfinished.at(-1) ?? finished.at(-1) ?? null);
    }
    this.#voteEntries = new Map(options.map((t) => [t.id, t]));
    state.trackVote = {
      id: crypto.randomUUID(),
      mode: picker === null ? 'vote' : rules.nextTrack === 'winner' ? 'winner' : 'last',
      picker,
      options: options.map((t) => ({ id: t.id, name: String(t.name).slice(0, 64) })),
      votes: {},
      endsAt: this.now() + TRACK_VOTE_MS,
    };
    Cup.touch(state);
    this.broadcast();
  }
  settleTrackVote(state: CupState) {
    const v = state.trackVote;
    if (!v) return;
    const voters = Cup.activeIds(state).filter((id) => this.racerAvailable(id));
    const done =
      v.mode === 'vote'
        ? voters.length > 0 && voters.every((id) => id in v.votes)
        : v.picker !== null && (v.picker in v.votes || !voters.includes(v.picker));
    if (!done && this.now() < v.endsAt) return;
    const counts = new Map(v.options.map((t) => [t.id, 0]));
    for (const choice of Object.values(v.votes)) counts.set(choice, (counts.get(choice) ?? 0) + 1);
    const most = Math.max(...counts.values());
    const best = v.options.filter((t) => counts.get(t.id) === most);
    const chosen = best[Math.floor(Math.random() * best.length)];
    const entry =
      this.#voteEntries.get(chosen.id) ?? this.allowedTracks().find((t) => t.id === chosen.id);
    const connection = this.#connection;
    if (!entry) {
      state.trackVote = null;
      Cup.touch(state);
      return;
    }
    const request = this.loadTrackEntry(state, entry)
      .then(({ track, wr }) => {
        if (this.#state !== state || this.#connection !== connection || state.phase !== 'between-rounds')
          return;
        this.#tracks.set(entry.id, track);
        Cup.scheduleRandomTrack(state, { id: entry.id, name: entry.name }, wr);
        Cup.note(
          state,
          v.mode === 'vote'
            ? `Racers chose ${entry.name}.`
            : v.picker !== null && v.picker in v.votes
              ? `${Cup.player(state, v.picker)?.name ?? 'A racer'} picked ${entry.name}.`
              : `Next track: ${entry.name}.`,
        );
        this.broadcast();
      })
      .catch((error) => {
        if (this.#state === state) {
          state.trackVote = null;
          Cup.touch(state);
        }
        this.fail(error);
      })
      .finally(() => {
        if (this.#preparingRandom === request) this.#preparingRandom = null;
        this.#onChange();
      });
    this.#preparingRandom = request;
  }
  // Not So Weekly Shorts: the organizer replays each racer's finish through the game's physics.
  verifyFinish(id: number, m: FinishMessage) {
    const state = this.cup,
      run = state.runtime!;
    if (id === this.#selfId || rulesFor(state).collisions || !this.#native.verifyRun || !this.#game)
      return;
    const key = `${run.id}:${id}`,
      roundId = run.id;
    const failed = (reason: string) => {
      const live = this.#state?.runtime;
      if (!live || live.id !== roundId || live.finishes[id] !== m.frames) return;
      const before = standings(this.cup).map((r) => r.id);
      Cup.rejectFinish(this.cup, id, this.#verifiedBest.get(key) ?? null);
      updateLiveMovement(this.cup, before);
      Cup.note(this.cup, `${Cup.player(this.cup, id)?.name ?? 'A racer'}'s finish ${reason} and doesn't count.`);
      this.broadcast();
    };
    if (
      typeof m.recording !== 'string' ||
      !m.recording ||
      m.recording.length > 50000 ||
      !Number.isSafeInteger(m.attempt) ||
      m.attempt! <= 0 ||
      m.attempt! > m.frames
    ) {
      failed('came without its replay');
      return;
    }
    this.#verifying.set(key, (this.#verifying.get(key) ?? 0) + 1);
    this.#verifyStarted = Date.now();
    this.syncVerifying();
    this.#native
      .verifyRun(this.#game, m.recording, m.attempt!)
      .then(
        (ok) => {
          if (ok === false) failed('didn’t match the physics replay');
          else if (ok && this.#state?.runtime?.finishes[id] === m.frames) this.#verifiedBest.set(key, m.frames);
        },
        () => {},
      )
      .finally(() => {
        const left = (this.#verifying.get(key) ?? 1) - 1;
        if (left > 0) this.#verifying.set(key, left);
        else this.#verifying.delete(key);
        if (this.#state?.runtime?.id === roundId) {
          this.syncVerifying();
          this.broadcast();
        }
        this.#onChange();
      });
  }
  syncVerifying() {
    const run = this.#state?.runtime;
    if (!run) return;
    const ids = [...new Set([...this.#verifying.keys()].filter((k) => k.startsWith(`${run.id}:`)).map((k) => Number(k.split(':')[1])))].filter(
      (id) => Cup.player(this.#state, id),
    );
    if (JSON.stringify(run.verifying ?? []) !== JSON.stringify(ids)) {
      if (ids.length) run.verifying = ids;
      else delete run.verifying;
      Cup.touch(this.cup);
    }
  }
  verificationPending() {
    return !!this.#state?.runtime?.verifying?.length && Date.now() - this.#verifyStarted < VERIFY_WAIT_MS;
  }
  // Not So Weekly Shorts: collision cups pass each hit to the racer who was hit (via the organizer).
  sendBumps() {
    const s = this.#state,
      run = s?.runtime,
      game = this.#game;
    if (!s || !run || !game || !rulesFor(s).collisions || !this.#native.bumps) return;
    for (const hit of this.#native.bumps(game)) {
      if (!Cup.racingIds(s).includes(hit.id) || hit.id === this.#selfId) continue;
      const message = { type: 'bump' as const, cupId: s.id, roundId: run.id, to: hit.id, impulse: hit.impulse };
      if (this.#isHost) this.relayBump(this.#selfId!, message);
      else this.#transport.send(0, message);
    }
  }
  relayBump(from: number, m: Extract<Message, { type: 'bump' }>) {
    const s = this.#state;
    if (!s || m.cupId !== s.id || m.roundId !== s.runtime?.id || typeof m.to !== 'number') return;
    if (!Cup.racingIds(s).includes(from) || !Cup.racingIds(s).includes(m.to)) return;
    if (!Array.isArray(m.impulse) || m.impulse.length !== 3 || !m.impulse.every((n) => Number.isFinite(n) && Math.abs(n) <= 40))
      return;
    if (m.to === this.#selfId) this.receiveBump(m.impulse);
    else this.#transport.send(m.to, { type: 'bump', cupId: s.id, roundId: m.roundId, from, impulse: m.impulse });
  }
  receiveBump(impulse: number[]) {
    const s = this.#state;
    if (!s || !this.#game || !rulesFor(s).collisions || s.phase !== 'racing') return;
    if (this.localPlayerId === null || Cup.roundDone(s, this.localPlayerId)) return;
    this.#native.bump?.(this.#game, impulse);
    this.onBump?.();
  }
}
export { validPB, validSnapshot } from './validation.ts';
