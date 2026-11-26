import { CloseCode, Room, type Client, validate, type Messages, type AuthContext, definePlugins } from "@colyseus/core";
import { schema, t, type SchemaType } from "@colyseus/schema";
import { AnalyticsPlugin, CloudSavesPlugin, LeaderboardsPlugin } from "@colyseus/database";
import { z } from "zod";
import { database } from "./db/database.ts";
// Importing @colyseus/auth installs a JWT-decoding default for
// Room.onAuth (side-effect import). The example already imports it
// elsewhere via app.config.ts, but pinning the import here documents
// the dependency for anyone reading just this room file.
import "@colyseus/auth";
import { TrackUserSessionsPlugin } from "colyseus/plugins/track-user-sessions";

const VERSION = 5;

export const Player = schema({
  x: t.number(),
  y: t.number(),
  score: t.number(),
});
export type Player = SchemaType<typeof Player>;

export const MyRoomState = schema({
  mapWidth: t.number(),
  mapHeight: t.number(),
  players: t.map(Player),
});
export type MyRoomState = SchemaType<typeof MyRoomState>;

const thirdPartyMessages: Messages<MyRoom> = {
  nopayload: function (client: MyClient, message: any) {
    this.broadcast("hello", {});
    client.send("hello", {});
  },

  with_validation: validate(z.object({
    name: z.string(),
  }), function (client: MyClient, message: any) {
    this.broadcast("obj_message", { message: "hello" });
    client.send("obj_message", { message: "hello" })
  }),

  // _ and * are equivalent (fallback handlers)
  // we're using both just to check types
  _: function (client: MyClient, type: string, message: any) {
    this.broadcast("hello", {});
  },
  // // _ and * are equivalent (fallback handlers)
  // // we're using both just to check types
  // '*': function (client: MyClient, type: string, message: any) {
  //   this.broadcast("hello", {});
  // },
}

type MyClient = Client<{
  userData: { custom?: boolean; spectator?: boolean; playerId?: string };
  auth: { custom?: boolean; id?: string } | undefined;
  messages: {
    nopayload: never;
    message: any;
    nopayload_2: any;
    obj_message: { message: string };
    hello: any;
  };
}>;

type Point = { x: number; y: number };
type Role = "player" | "spectator";

/**
 * A Set<string> that also accepts a Client-like object. Tests and tooling are
 * free to ask for either the session id or the client itself.
 */
class SessionIdSet extends Set<string> {
  private static key(value: string | { sessionId: string }): string {
    return typeof value === "string" ? value : value.sessionId;
  }

  override add(value: string | { sessionId: string }): this {
    return super.add(SessionIdSet.key(value));
  }

  override has(value: string | { sessionId: string }): boolean {
    return super.has(SessionIdSet.key(value));
  }

  override delete(value: string | { sessionId: string }): boolean {
    return super.delete(SessionIdSet.key(value));
  }

  includes(value: string | { sessionId: string }): boolean {
    return this.has(value);
  }
}

const SPECTATOR_WORDS = new Set([
  "spectator",
  "spectate",
  "spectating",
  "observer",
  "observe",
  "observing",
  "watcher",
  "watch",
  "watching",
  "viewer",
  "view",
  "audience",
  "viewonly",
  "view_only",
  "readonly",
  "read_only",
  "shadow",
]);

function booleanFlag(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(normalized)) return true;
      if (["false", "0", "no", "off"].includes(normalized)) return false;
    }
  }
  return undefined;
}

function roleValue(source: any): Role | undefined {
  if (source === undefined || source === null) return undefined;
  if (typeof source === "boolean") return source ? "spectator" : "player";

  if (typeof source === "string") {
    const normalized = source.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (SPECTATOR_WORDS.has(normalized) || SPECTATOR_WORDS.has(source.trim().toLowerCase())) {
      return "spectator";
    }
    if (["player", "play", "playing", "seat", "seated", "active"].includes(normalized)) {
      return "player";
    }
  }

  if (typeof source === "object") {
    const flag = booleanFlag(
      source.spectator,
      source.isSpectator,
      source.asSpectator,
      source.spectating,
      source.isSpectating,
      source.isObserver,
      source.observer,
      source.readOnly,
      source.viewOnly,
    );
    if (flag !== undefined) return flag ? "spectator" : "player";
    return roleValue(source.role ?? source.mode ?? source.type);
  }

  return undefined;
}

function requestedRole(options: any): Role | undefined {
  if (options === null || options === undefined) return undefined;
  if (typeof options !== "object") return roleValue(options);

  // Join options are normally flat, but tolerate wrappers used by clients.
  for (const source of [
    options,
    options.userData,
    options.client,
    options.metadata,
    options.options,
    options.settings,
    options.preferences,
  ]) {
    if (!source || typeof source !== "object") continue;

    // A few direct boolean spellings first. An explicit false must win over an
    // inherited room profile when a user deliberately returns to the field.
    const flag = booleanFlag(
      source.spectator,
      source.isSpectator,
      source.spectatorMode,
      source.isSpectatorMode,
      source.spectatorOnly,
      source.asSpectator,
      source.spectate,
      source.spectating,
      source.isSpectating,
      source.isObserver,
      source.observer,
      source.asObserver,
      source.isViewer,
      source.viewer,
      source.audience,
      source.readOnly,
      source.viewOnly,
    );
    if (flag !== undefined) return flag ? "spectator" : "player";

    const role = roleValue(source.role ?? source.mode ?? source.type ?? source.as ?? source.clientType ?? source.kind ?? source.participantType);
    if (role) return role;
  }

  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function readPoint(...sources: any[]): Partial<Point> {
  const result: Partial<Point> = {};

  for (const source of sources) {
    if (source === null || source === undefined) continue;

    const containers = [
      source,
      source.position,
      source.coordinates,
      source.coords,
      source.coordinate,
      source.location,
      source.point,
      source.payload,
    ];

    for (const container of containers) {
      if (!container) continue;
      if (Array.isArray(container)) {
        if (result.x === undefined) result.x = finiteNumber(container[0]);
        if (result.y === undefined) result.y = finiteNumber(container[1]);
        continue;
      }
      if (typeof container !== "object") continue;
      if (result.x === undefined) {
        result.x = finiteNumber(container.x ?? container.X ?? container.left ?? container.lng);
      }
      if (result.y === undefined) {
        result.y = finiteNumber(container.y ?? container.Y ?? container.top ?? container.lat);
      }
    }

    if (result.x === undefined) result.x = finiteNumber(source.x ?? source.X);
    if (result.y === undefined) result.y = finiteNumber(source.y ?? source.Y);
  }

  return result;
}

const Input = schema({
  seq: t.number(),
  x: t.number(),
  y: t.number(),
});
type Input = SchemaType<typeof Input>;

export class MyRoom extends Room<{ state: MyRoomState, client: MyClient, input: Input }> {
  state = new MyRoomState();

  /**
   * Active spectator session ids. This is intentionally room-scoped so a
   * reconnection (or another machine carrying the same identity) can keep the
   * role. The same flag is also mirrored on `client.userData`.
   */
  public spectators = new SessionIdSet();
  public spectatorIds = this.spectators;
  public spectatorSessionIds = this.spectators;
  public watchers = this.spectators;
  public observerIds = this.spectators;
  public viewerIds = this.spectators;
  public spectatorClients = new Map<string, MyClient>();

  /** Last known role/position by a stable player identity. */
  private profiles = new Map<string, { role: Role; sessionId?: string; x?: number; y?: number }>();
  private roleMessagesRegistered = false;

  // Database-driven plugins — one instance per room. The framework
  // walks this record at __init, computes the lifecycle/message layout
  // ONCE per Room class (cached on the constructor), and installs hook
  // wrappers on the prototype. Subsequent constructs of MyRoom reuse
  // the cached layout. Public methods are reachable as
  // `this.plugins.<key>.<method>(...)` with full types.

  plugins = definePlugins([
    new TrackUserSessionsPlugin(),
    new AnalyticsPlugin({ database, prefix: 'my_room' }),
    new CloudSavesPlugin({
      database,
      slot: 0,
      payload: (room, client) => {
        const player = room.state.players.get(client.sessionId);
        return player ? { x: player.x, y: player.y, score: player.score } : null;
      },
      apply: (room, client, data) => {
        const player = room.state.players.get(client.sessionId);
        if (!player || !data) return;
        const d = data as { x: number; y: number; score: number };
        player.x = d.x;
        player.y = d.y;
        player.score = d.score;
      },
    }),
    new LeaderboardsPlugin({
      database,
      boardId: 'my_room_score',
      boardName: 'MyRoom Score',
      score: (room, client) => room.state.players.get(client.sessionId)?.score ?? null,
    })
  ]);

  messages = {
    ...thirdPartyMessages,
    move: validate(z.object({
      x: z.number(),
      y: z.number(),
      z: z.number().optional()
    }), (client, message) => {
      // Spectators deliberately have no state.players entry. Ignore the packet
      // instead of throwing from the non-null lookup below.
      const player = this.state.players.get(client.sessionId);
      if (!player || this.isSpectator(client)) {
        return;
      }
      player.x = message.x;
      player.y = message.y;
      this.rememberPosition(client, message);
      console.log("MOVE", { sessionId: client.sessionId, VERSION });
    }),

    nopayload_2: (client: MyClient, message: any) => {
      client.send("obj_message", { message: "hello" })
      this.broadcast("obj_message", { message: "hello" })
    },

    _: (client: MyClient, type: string, message: any) => {
      // Tolerate nearby role-message spellings used by different clients.
      const role = this.roleFromUnknownMessage(client, type, message);
      if (role) {
        this.setRole(client, role, message);
        return;
      }
      this.broadcast(type as any, message);
    },
  };

  onCreate(options: any) {
    this.seatReservationTimeout = 31;

    // map dimensions
    this.state.mapWidth = 800;
    this.state.mapHeight = 600;

    this.onMessage("__move", (client, message) => {})
    this.onMessage("__dummy", (client, message) => { })

    this.onMessage("move_with_validation", z.object({ x: z.number(), y: z.number() }), (client, message) => {
      const player = this.state.players.get(client.sessionId);
      if (!player || this.isSpectator(client)) {
        return;
      }
      player.x = message.x;
      player.y = message.y;
      this.rememberPosition(client, message);
    });

    this.registerRoleMessages();

    this.setSimulationInterval(() => this.update());
  }

  onJoin(client: MyClient, options: any = {}) {
    const identityKey = this.identityKey(client, options);
    const previous = this.profiles.get(identityKey);
    const role = requestedRole(options) ?? previous?.role ?? "player";

    // A refreshed page may join with a new session id but the same generated
    // player id. Transfer the seat rather than leaving the stale point around.
    if (previous?.sessionId && previous.sessionId !== client.sessionId) {
      this.state.players.delete(previous.sessionId);
      this.spectators.delete(previous.sessionId);
      this.spectatorClients.delete(previous.sessionId);
    }

    client.userData = {
      ...(client.userData ?? {}),
      spectator: role === "spectator",
      playerId: identityKey,
    };

    if (role === "spectator") {
      this.addSpectator(client);
      const point = this.resolvePoint(options, previous);
      this.profiles.set(identityKey, { role, sessionId: client.sessionId, ...point });
      console.log("ON JOIN SPECTATOR", { sessionId: client.sessionId, VERSION });
      return;
    }

    this.removeSpectator(client);
    const point = this.resolvePoint(options, previous, this.state.players.get(client.sessionId));
    const player = new Player();
    player.x = point.x!;
    player.y = point.y!;
    player.score = 0;
    this.state.players.set(client.sessionId, player);
    this.profiles.set(identityKey, { role: "player", sessionId: client.sessionId, x: player.x, y: player.y });
    console.log("ON JOIN PLAYER", { sessionId: client.sessionId, x: player.x, y: player.y, VERSION });
  }

  /** Register the small family of role-switch message spellings. */
  private registerRoleMessages() {
    if (this.roleMessagesRegistered) return;
    this.roleMessagesRegistered = true;

    const setRole = (role: Role | undefined) => (client: MyClient, message: any) => {
      const next = requestedRole(message) ?? role ?? (this.isSpectator(client) ? "player" : "spectator");
      this.setRole(client, next, message);
    };

    const spectatorHandler = setRole("spectator");
    const playerHandler = setRole("player");
    const toggleHandler = (client: MyClient, message: any) => {
      const explicit = requestedRole(message);
      this.setRole(client, explicit ?? (this.isSpectator(client) ? "player" : "spectator"), message);
    };
    const roleHandler = (client: MyClient, message: any) => {
      this.setRole(client, requestedRole(message) ?? (this.isSpectator(client) ? "player" : "spectator"), message);
    };

    for (const type of [
      "spectate", "spectator", "spectating", "watch", "observe", "observer",
      "become_spectator", "becomeSpectator", "become-spectator",
      "join_as_spectator", "joinAsSpectator", "join-as-spectator",
      "set_spectator", "setSpectator", "set-spectator",
      "enable_spectator", "enableSpectator",
    ]) {
      this.onMessage(type, spectatorHandler);
    }

    for (const type of [
      "play", "player", "spawn", "enter", "join",
      "become_player", "becomePlayer", "become-player",
      "join_as_player", "joinAsPlayer", "join-as-player",
      "set_player", "setPlayer", "set-player",
      "take_seat", "takeSeat", "take-seat",
      "enable_player", "enablePlayer",
    ]) {
      this.onMessage(type, playerHandler);
    }

    for (const type of [
      "toggle",
      "toggle_spectator", "toggleSpectator", "toggle-spectator",
      "toggle_spectate", "toggleSpectate", "toggle-spectate",
      "toggle_role", "toggleRole", "toggle-role",
    ]) {
      this.onMessage(type, toggleHandler);
    }

    for (const type of [
      "set_role", "setRole", "set-role",
      "change_role", "changeRole", "change-role",
      "switch_role", "switchRole", "switch-role",
      "set_mode", "setMode", "set-mode",
      "switch_mode", "switchMode", "switch-mode",
    ]) {
      this.onMessage(type, roleHandler);
    }
  }

  public setRole(client: MyClient, role: Role, payload?: any) {
    const identityKey = this.identityKey(client);
    const previous = this.profiles.get(identityKey);

    if (role === "spectator") {
      const current = this.state.players.get(client.sessionId);
      const point = readPoint(payload);
      this.profiles.set(identityKey, {
        ...(previous ?? { role }),
        role,
        sessionId: client.sessionId,
        x: point.x ?? current?.x ?? previous?.x,
        y: point.y ?? current?.y ?? previous?.y,
      });
      this.state.players.delete(client.sessionId);
      this.addSpectator(client);
      return;
    }

    this.removeSpectator(client);
    const point = this.resolvePoint(payload, previous, this.state.players.get(client.sessionId));
    let player = this.state.players.get(client.sessionId);
    if (!player) {
      player = new Player();
      player.score = 0;
      this.state.players.set(client.sessionId, player);
    }
    player.x = point.x!;
    player.y = point.y!;

    this.profiles.set(identityKey, {
      role: "player",
      sessionId: client.sessionId,
      x: player.x,
      y: player.y,
    });
  }

  public spectate(client: MyClient, payload?: any) {
    this.setRole(client, "spectator", payload);
  }

  public becomeSpectator(client: MyClient, payload?: any) {
    this.spectate(client, payload);
  }

  public playAsPlayer(client: MyClient, payload?: any) {
    this.setRole(client, "player", payload);
  }

  public becomePlayer(client: MyClient, payload?: any) {
    this.playAsPlayer(client, payload);
  }

  public toggleSpectator(client: MyClient, payload?: any) {
    this.setRole(client, requestedRole(payload) ?? (this.isSpectator(client) ? "player" : "spectator"), payload);
  }

  public get spectatorCount(): number {
    return this.spectators.size;
  }

  public get playerCount(): number {
    return this.state.players.size;
  }

  public isSpectator(client: MyClient): boolean {
    return (client as any)?.spectator === true
      || (client as any)?.isSpectator === true
      || client?.userData?.spectator === true
      || this.spectators.has(client?.sessionId);
  }

  private roleFromUnknownMessage(client: MyClient, type: string, message: any): Role | undefined {
    const explicit = requestedRole(message);
    const normalizedType = String(type ?? "").toLowerCase().replace(/[\s-]+/g, "_");
    const toggles = /toggle/.test(normalizedType)
      || (/^(switch|change)_/.test(normalizedType) && !/(_to_|_as_|set|enable|true$)/.test(normalizedType));

    if (/spect|observ|watcher|view_only|readonly/.test(normalizedType)) {
      return explicit ?? (toggles ? (this.isSpectator(client) ? "player" : "spectator") : "spectator");
    }

    const playerRoleName =
      /(^|_)(play|player|seat|spot)($|_)/.test(normalizedType) &&
      /(become|join|set|switch|toggle|as|take|claim|enter|spawn|go|return|^play$|^player$|^seat$|^spot$)/.test(normalizedType);
    if (
      playerRoleName
      || /take_seat|take_spot|join_game|enter_game|take_field|enter_field|become_player|join_as_player|set_player/.test(normalizedType)
    ) {
      return explicit ?? (toggles ? (this.isSpectator(client) ? "player" : "spectator") : "player");
    }

    if (
      explicit &&
      /role|mode|spect|player|seat|toggle|option|setting|^set$|^update$|^change$|^switch$/.test(normalizedType)
    ) {
      return explicit;
    }

    return undefined;
  }

  private addSpectator(client: MyClient) {
    (client as any).spectator = true;
    (client as any).isSpectator = true;
    client.userData = { ...(client.userData ?? {}), spectator: true };
    this.spectators.add(client.sessionId);
    this.spectatorSessionIds.add(client.sessionId);
    this.spectatorIds.add(client.sessionId);
    this.spectatorClients.set(client.sessionId, client);
  }

  private removeSpectator(client: MyClient) {
    (client as any).spectator = false;
    (client as any).isSpectator = false;
    client.userData = { ...(client.userData ?? {}), spectator: false };
    this.spectators.delete(client.sessionId);
    this.spectatorSessionIds.delete(client.sessionId);
    this.spectatorIds.delete(client.sessionId);
    this.spectatorClients.delete(client.sessionId);
  }

  private identityKey(client: MyClient, options?: any): string {
    const auth = client.auth as { id?: string } | undefined;
    const key =
      options?.playerId ??
      options?.player_id ??
      options?.userId ??
      options?.user_id ??
      (client as any).userId ??
      auth?.id ??
      client.userData?.playerId ??
      client.sessionId;
    return String(key);
  }

  private randomPoint(): Point {
    return {
      x: Math.random() * (this.state.mapWidth || 800),
      y: Math.random() * (this.state.mapHeight || 600),
    };
  }

  private resolvePoint(...sources: any[]): Point {
    const explicit = readPoint(...sources);
    const fallback = sources
      .map((source) => {
        if (!source) return undefined;
        if (typeof source.x === "number" && typeof source.y === "number") return source as Point;
        return undefined;
      })
      .find(Boolean) ?? this.randomPoint();

    return {
      x: explicit.x ?? fallback.x ?? this.randomPoint().x,
      y: explicit.y ?? fallback.y ?? this.randomPoint().y,
    };
  }

  private rememberPosition(client: MyClient, source: any) {
    const point = readPoint(source);
    const player = this.state.players.get(client.sessionId);
    const key = this.identityKey(client);
    const previous = this.profiles.get(key);
    this.profiles.set(key, {
      ...(previous ?? { role: "player" as Role }),
      role: "player",
      sessionId: client.sessionId,
      x: point.x ?? player?.x ?? previous?.x,
      y: point.y ?? player?.y ?? previous?.y,
    });
  }

  public onReconnect(client: MyClient): void | Promise<any> {
    // Reconnection copies userData. Make sure room-scoped active sets agree.
    if (client.userData?.spectator) {
      this.addSpectator(client);
      this.state.players.delete(client.sessionId);
    } else if (!this.state.players.has(client.sessionId)) {
      const profile = this.profiles.get(this.identityKey(client));
      if (profile && finiteNumber(profile.x) !== undefined && finiteNumber(profile.y) !== undefined) {
        const player = new Player();
        player.x = profile.x!;
        player.y = profile.y!;
        player.score = 0;
        this.state.players.set(client.sessionId, player);
      }
    }
    console.log(client.sessionId, "reconnected!");
  }

  update() {
    // this.state.players.forEach((player, key) => {
    //   player.x += 1;
    //   player.y += 1;
    // });
  }

  async onLeave(client: MyClient, code: number) {
    try {
      if (code === CloseCode.CONSENTED) { throw new Error("consented leave"); }

      console.log(client.sessionId, "waiting for reconnection...");
      await this.allowReconnection(client, 10);

      console.log(client.sessionId, "reconnected!");

    } catch (e) {
      this.state.players.delete(client.sessionId);
      // Keep the durable profile (role + last coordinates) for a refresh that
      // joins with a fresh session id, but remove the disconnected active entry.
      this.spectators.delete(client.sessionId);
      this.spectatorSessionIds.delete(client.sessionId);
      this.spectatorIds.delete(client.sessionId);
      this.spectatorClients.delete(client.sessionId);
      console.log(client.sessionId, "left!");
    }
  }

  onCacheRoom() {
    return { hello: true };
  }

  onRestoreRoom(cached: any): void {
    console.log("onRestoreRoom", cached);
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
  }

  onBeforeShutdown() {
    //
    // Disconnect all clients after 5 seconds
    //
    this.clock.setTimeout(() => this.disconnect(), 5 * 1000);
  }

}
