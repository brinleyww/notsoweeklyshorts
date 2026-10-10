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
export class Controller {
  #enrolling = new Set<number>();
  #resumeRacers = new Set<number>();
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
    this.#nextAuto =
      this.#auto && this.#state?.phase === 'between-rounds'
        ? Date.now() + rulesFor(this.#state).roundBreakSeconds * 1000
        : null;
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
        if (this.checkpointHotkey(event)) {
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
    this.#timer = setInterval(() => this.tick(), 100);
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
      this.save(true);
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
    this.requestPanel(false, 'Left multiplayer lobby');
    this.#onChange();
  }
  fail(error: unknown) {
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
      this.#actions.cancel('The multiplayer connection changed.');
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
    this.#native.leaderboardUploads?.(
      game,
      this.#state ? rulesFor(this.#state).uploadLeaderboardTimes === true : undefined,
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
        this.#startKey = run.id;
        this.#startedCar = this.gameInfo.car;
        this.#native.release?.(game);
        this.gameInfo.spectator.isEnabled = false;
        this.#native.applyDrivingInput?.(game, this.#heldDrivingInputs.controls());
        // Background tabs may process GO late. Count that delay in every Cup time,
        // while keeping the native recording clock unchanged.
        this.#raceTimeOffset = Math.max(
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
      !(this.localPlayerId in this.round.finishes) &&
      !this.round.dnfs.includes(this.localPlayerId)
    );
  }
  handleRestart(game: NativeGame) {
    if (!this.#state || game !== this.#game) return false;
    if (
      this.cup.phase === 'warmup' &&
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
    return !!this.#state && game === this.#game && this.cup.phase !== 'warmup';
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
      !this.#native.restartPressed(this.#game, event)
    )
      return false;
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
      event.repeat ||
      event.isComposing ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isEditing(event)
    )
      return false;
    if (!this.#native.startRespawnPressed(this.#game, event)) return false;
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
      (context.stage === 'race' && m.attempt !== 0) ||
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
    if (context.stage === 'race') {
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
      (context.stage === 'race' && m.attempt !== 0) ||
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
  canSpectate() {
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
    if (!this.#state) return;
    this.#hideOtherGhosts = !this.#hideOtherGhosts;
    this.#onChange();
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
  beforeRender(game: NativeGame) {
    if (game !== this.#game) return;
    this.captureInputs();
    const spectating = !this.#info?.disposed && this.canSpectate() && this.watchable().length > 0;
    // Native session-end screens still render after the session stops accepting
    // controls. Update their presentation before the disposed-session guard.
    this.#native.presentation?.(game, !!this.#state, spectating);
    if (this.#info?.disposed || this.localPlayerId === null) return;
    if (!this.#state) {
      if (this.#filteredCars) this.#native.visibility(game, null, this.localPlayerId);
      this.#filteredCars = false;
      return;
    }
    const now = this.now(),
      active = Cup.racingIds(this.#state);
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
        this.#hideOtherGhosts ? [this.localPlayerId] : active,
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
      this.#hideOtherGhosts ? active.filter((id) => id === viewed) : active,
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
      this.#chat.tick();
      if (Date.now() - this.#lastHello > 2000) {
        this.#lastHello = Date.now();
        if (!this.#isHost)
          this.#transport.send(0, { type: 'hello', version: Cup.VERSION, sentAt: Date.now() });
      }
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
        this.applyReconnects();
        this.admitRacers();
        this.advanceClock();
        if (this.cup.phase === 'racing') {
          const run = this.round;
          if (
            Cup.allFinished(this.#state) ||
            (run.deadline !== null && this.now() >= run.deadline + 1500)
          )
            this.finishRound();
        }
        if (
          this.#auto &&
          this.cup.phase === 'between-rounds' &&
          this.#nextAuto &&
          Date.now() >= this.#nextAuto
        ) {
          if (this.canStartRound())
            this.runRound()?.catch((error) => {
              this.#auto = false;
              this.fail(error);
            });
          else this.#nextAuto = Date.now() + 1000;
        }
        if (Date.now() - this.#lastBroadcast > 1000 || this.#sentRevision !== this.cup.revision)
          this.broadcast();
        this.save();
      }
      this.#onChange();
    } catch (error) {
      this.#auto = false;
      this.fail(error);
    }
  }
  create(name: string) {
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
    this.broadcast();
    this.#onChange();
    this.ensureReview();
  }
  requireHost() {
    if (!this.#isHost || !this.#connection)
      throw new Error('Host a PolyTrack multiplayer lobby first.');
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
    this.save(true);
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
    const needsDraft = rulesFor(next).selection === 'draft' && next.draft?.stage === 'roster';
    const launch = !newTracks && !needsDraft && next.roster.length >= 2;
    if (launch) {
      this.requireStartRacers();
      if (this.cup.tracks.some((t) => !this.#tracks.has(t.id)))
        throw new Error('A rematch track is missing. Choose new tracks instead.');
    }
    this.save();
    this.#state = next;
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
    this.#nextAuto = null;
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
  endCup() {
    this.requireHost();
    if (!this.#state) return;
    this.#review.close(this.#state, 'interrupted');
    this.save(true);
    this.releaseCup('Cup ended · Normal multiplayer');
    this.broadcast();
    this.#onChange();
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
    return this.availableTracks().filter((t) =>
      poolAllows(rulesFor(this.cup), t.category),
    );
  }
  async loadRandomTrack(state: CupState, timeoutMs = 20000) {
    const pool = this.allowedTracks();
    const previous = Cup.currentMatch(state)?.randomTrack?.id;
    const choices = pool.length > 1 ? pool.filter((t) => t.id !== previous) : pool;
    if (!choices.length) throw new Error('No tracks are available in the preset’s track pool.');
    const entry = choices[Math.floor(Math.random() * choices.length)];
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
    // Export the actual native track, so autosaves and native multiplayer transfers
    // work even when other players have never installed this custom track.
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
    if (Date.now() - this.#lastIdentity < 2000) return;
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
    this.save(true);
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
      if (this.#state.phase === 'registration') Cup.addPlayer(this.#state, actor, p.nickname);
      else Cup.enterRunningCup(this.#state, actor, p.nickname);
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
        this.skipTrack();
        return true;
      }
    } else return false;
    this.broadcast();
    if (this.#state.phase === 'between-rounds' && this.#auto)
      this.#nextAuto = Date.now() + rulesFor(this.#state).roundBreakSeconds * 1000;
    return true;
  }
  async enrollRacer(id: number, action: ActionMessage) {
    const state = this.#state,
      connection = this.#connection;
    if (!state || action.cupId !== state.id || !rulesFor(state).allowRacerChanges)
      throw new Error('This preset locks the racer roster during the Cup.');
    const deadline = Date.now() + 10000;
    while (!this.#reconnect.authenticated(id) && !Cup.player(state, id)) {
      if (
        this.#state !== state ||
        this.#connection !== connection ||
        !this.#lobby.some((p) => p.id === id)
      )
        throw new Error('The multiplayer connection changed.');
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
    if (
      ['identity-open', 'identity-challenge', 'identity-proof', 'reconnect-queued'].includes(m.type)
    ) {
      void this.receiveReconnect(id, m).catch(() => {});
      return;
    }
    if (this.#isHost) {
      if (m.type === 'hello' && m.version === Cup.VERSION && Number.isFinite(m.sentAt)) {
        this.#hello.add(id);
        this.#transport.send(id, {
          type: 'hello-ack',
          version: Cup.VERSION,
          sentAt: m.sentAt,
          hostAt: Date.now(),
        });
        this.#transport.send(id, this.syncMessage());
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
      else if (['join', 'leave', 'dnf', 'practice-ready', 'ban', 'remove-pick', 'skip-vote'].includes(m.type)) {
        const action = m as ActionMessage;
        if (
          action.requestId !== undefined &&
          (typeof action.requestId !== 'string' || action.requestId.length > 80)
        )
          return;
        if (
          action.type === 'join' &&
          this.#state?.phase !== 'registration' &&
          !Cup.player(this.#state, id)
        ) {
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
        if (acknowledged && m.error) this.#error = String(m.error).slice(0, 200);
      } else if (m.type === 'input-view') this.receiveInputView(id, m);
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
          if (this.#state) this.releaseCup('Organizer ended the Cup · Normal multiplayer');
        } else {
          this.#state = { ...m.state, history: [] };
          this.#error = '';
        }
        this.syncRoundPanel();
      } else if (m.type === 'error') this.#error = String(m.message).slice(0, 200);
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
      JSON.stringify([state.roster, state.picks, state.selections, state.draft, state.preset]);
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
  runRound(): void | Promise<void> {
    this.requireHost();
    if (this.#preparingRandom) return this.#preparingRandom;
    if (!['dnf', 'void'].includes(this.cup.disconnectPolicy))
      throw new Error('Choose a disconnect rule in Tournament before starting.');
    if (this.cup.roster.some((p) => this.#needsRebind?.has(p.id)))
      throw new Error('Confirm every saved racer’s lobby identity in Racers before resuming.');
    this.updateAvailability();
    this.applyReconnects();
    this.admitRacers();
    if (!this.canStartRound())
      throw new Error('Waiting for racers to reconnect or finish loading PolyCup.');
    if (rulesFor(this.cup).selection === 'random' && !Cup.nextTrack(this.cup)) {
      const state = this.cup,
        connection = this.#connection;
      this.#nextAuto = null;
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
    this.#loadingSession = this.gameInfo.sessionId;
    this.broadcast();
    const mode = rulesFor(this.cup).uploadLeaderboardTimes === true ? 0 : 1;
    this.#connection!.startNewSession(mode, track.trackMetadata, track.trackData);
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
    this.updateAvailability();
    if (s && rulesFor(s).allowRacerChanges && !['registration', 'complete'].includes(s.phase)) {
      for (const id of this.#resumeRacers) {
        if (s.withdrawn?.includes(id) && this.racerAvailable(id) && Cup.occupiedSlots(s) < 8) {
          Cup.enterRunningCup(s, id, Cup.player(s, id)!.name);
          this.#resumeRacers.delete(id);
        }
      }
    }
    if (
      s &&
      rulesFor(s).allowRacerChanges &&
      !['registration', 'complete'].includes(s.phase) &&
      (s.disconnectPolicy === 'dnf' || s.phase !== 'racing')
    ) {
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
    const missing = Cup.racingIds(s).filter(
      (id) =>
        this.#unavailableSince.has(id) &&
        this.now() - this.#unavailableSince.get(id)! >= RECONNECT_GRACE_MS &&
        !(id in s.runtime!.finishes) &&
        !s.runtime!.dnfs.includes(id),
    );
    if (!missing.length) return;
    if (s.disconnectPolicy === 'dnf' || s.phase !== 'racing') {
      const before = standings(s).map((r) => r.id);
      for (const id of missing) Cup.sitOut(s, id);
      updateLiveMovement(s, before);
      Cup.note(s, 'Disconnected racers sit out this round.');
    } else {
      this.#review.close(s, 'void');
      Cup.voidRound(s);
      this.#loadingSession = undefined;
      this.#nextAuto = this.#auto
        ? Date.now() + rulesFor(this.#state).roundBreakSeconds * 1000
        : null;
      this.#error = 'Round voided after a racer disconnected.';
    }
  }
  sendReady() {
    if (this.localPlayerId === null || !this.#info || this.#info.disposed) return;
    const s = this.cup,
      run = s.runtime;
    if (s.phase !== 'loading' || !run || this.gameInfo.trackData.getId() !== run.trackId) return;
    if (this.#isHost && run.sessionId === null) {
      // startNewSession takes five seconds. Wait for the new native game instance/session.
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
      this.#nextAuto = this.#auto
        ? Date.now() + rulesFor(this.#state).roundBreakSeconds * 1000
        : null;
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
    this.change(Cup.completeRound);
    this.#loadingSession = undefined;
    this.#nextAuto =
      this.#auto && this.cup.phase === 'between-rounds'
        ? Date.now() + rulesFor(this.cup).roundBreakSeconds * 1000
        : null;
  }
  voidRound() {
    this.change(Cup.voidRound);
    this.#loadingSession = undefined;
    this.#nextAuto = null;
  }
  // Not So Weekly Shorts: a passed skip vote ends the track's block and draws another track.
  skipTrack() {
    const state = this.cup,
      connection = this.#connection;
    if (state.runtime) this.voidRound();
    delete state.skipVote;
    Cup.note(state, 'Racers voted to skip the track.');
    Cup.touch(state);
    this.#nextAuto = null;
    const request = this.loadRandomTrack(state)
      .then(({ entry, track, wr }) => {
        if (this.#state !== state || this.#connection !== connection || state.phase !== 'between-rounds')
          return;
        this.#tracks.set(entry.id, track);
        Cup.scheduleRandomTrack(state, { id: entry.id, name: entry.name }, wr);
        if (this.#auto) this.#nextAuto = Date.now() + rulesFor(state).roundBreakSeconds * 1000;
      })
      .catch((error) => this.fail(error))
      .finally(() => {
        if (this.#preparingRandom === request) this.#preparingRandom = null;
        if (this.#state === state) this.broadcast();
        this.#onChange();
      });
    this.#preparingRandom = request;
    this.broadcast();
    this.#onChange();
  }
  exportData() {
    return {
      format: 'polytrack-world-cup',
      schema: 1,
      state: this.#state,
      ...(this.#isHost && this.#state ? { chat: this.#chat.archive() } : {}),
      ...(this.#isHost && this.#review.cupId === this.#state?.id
        ? { review: this.#review.data() }
        : {}),
      tracks: [...this.#tracks].map(([id, t]) => ({ id, code: t.code })),
    };
  }
  // Not So Weekly Shorts: no autosave or restore. A cup lives in its room and a new room has a new
  // code, so a restored cup can't reach its racers; serialising the cup on every change also costs
  // low-end devices. Export still saves the results.
  save(_force = false) {}
}
export { validPB, validSnapshot } from './validation.ts';
