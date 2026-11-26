import '@colyseus/sdk/debug';
import { Client, Callbacks, Room } from '@colyseus/sdk';

import type { server } from './server/vite.ts';
import type { MyRoom } from './MyRoom.ts';

const logElement = document.querySelector<HTMLPreElement>('#log');
const button = document.querySelector<HTMLButtonElement>('#connect');
const statusEl = document.querySelector<HTMLSpanElement>('#status');
const canvas = document.querySelector<HTMLCanvasElement>('#game');
const spectatorInput = document.querySelector<HTMLInputElement>('#spectator-mode');
const switchRoleButton = document.querySelector<HTMLButtonElement>('#switch-role');
const playerCountElement = document.querySelector<HTMLDivElement>('#player-count');
const joinXInput = document.querySelector<HTMLInputElement>('#join-x');
const joinYInput = document.querySelector<HTMLInputElement>('#join-y');
const ctx = canvas?.getContext('2d');

const ROOM_NAME = new URLSearchParams(location.search).get('room') ?? 'my_room';
const PLAYER_ID_KEY = 'gallery-seat-kit:player-id';
const SPECTATOR_KEY = 'gallery-seat-kit:spectator';
const TOKEN_KEY = 'gallery-seat-kit:reconnection-token';
const POSITION_KEY = 'gallery-seat-kit:last-position';

let room: Room<MyRoom> | null = null;
let drawLoopStarted = false;
const players = new Map<string, { x: number; y: number }>();
let isSpectating = readStored(SPECTATOR_KEY) === '1' || new URLSearchParams(location.search).get('spectator') === '1';
let lastOwnPosition: { x: number; y: number } | null = readStoredPosition();

// HTTP endpoint buttons — work without a room connection
const httpClient = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);

document.getElementById('btn-hello')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/hello');
  log(`/hello: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-time')?.addEventListener('click', async () => {
  const res = await httpClient.http.get('/time');
  log(`/time: ${JSON.stringify(res.data)}`);
});

document.getElementById('btn-express')?.addEventListener('click', async () => {
  const res = await fetch(`${location.origin}/express-hello`);
  log(`/express-hello: ${JSON.stringify(await res.json())}`);
});

function safeStorage(): Storage | null {
  try { return globalThis.localStorage; } catch { return null; }
}

function readStored(key: string): string | null {
  try { return safeStorage()?.getItem(key) ?? null; } catch { return null; }
}

function writeStored(key: string, value: string | null) {
  try {
    const storage = safeStorage();
    if (value === null) storage?.removeItem(key);
    else storage?.setItem(key, value);
  } catch { /* storage may be unavailable */ }
}

function getPlayerId(): string {
  const existing = readStored(PLAYER_ID_KEY);
  if (existing) return existing;
  const generated = globalThis.crypto?.randomUUID?.() ?? `p_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  writeStored(PLAYER_ID_KEY, generated);
  return generated;
}

function readStoredPosition(): { x: number; y: number } | null {
  const raw = readStored(POSITION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      return { x: parsed.x, y: parsed.y };
    }
  } catch { /* ignore malformed storage */ }
  return null;
}

function storePosition(point: { x: number; y: number } | null) {
  lastOwnPosition = point;
  if (point) writeStored(POSITION_KEY, JSON.stringify(point));
}

function readCoordinateInput(input: HTMLInputElement | null): number | undefined {
  if (!input || input.value.trim() === '') return undefined;
  const value = Number(input.value);
  return Number.isFinite(value) ? value : undefined;
}

function initialCoordinates(): { x?: number; y?: number } {
  const params = new URLSearchParams(location.search);
  const queryX = Number(params.get('x'));
  const queryY = Number(params.get('y'));
  const inputX = readCoordinateInput(joinXInput);
  const inputY = readCoordinateInput(joinYInput);
  return {
    x: inputX ?? (Number.isFinite(queryX) ? queryX : undefined),
    y: inputY ?? (Number.isFinite(queryY) ? queryY : undefined),
  };
}

function log(message: string) {
  if (logElement) {
    logElement.textContent = message;
  }
}

function setStatus(state: 'idle' | 'connecting' | 'connected' | 'disconnected', text: string) {
  if (!statusEl) return;
  statusEl.className = state;
  statusEl.innerHTML = `<span class="dot"></span>${text}`;
}

function updateRoleUI() {
  document.documentElement.dataset.role = isSpectating ? 'spectator' : 'player';
  if (canvas) canvas.dataset.myRole = isSpectating ? 'spectator' : 'player';
  if (spectatorInput) {
    spectatorInput.checked = isSpectating;
    spectatorInput.disabled = room !== null;
  }
  if (switchRoleButton) {
    switchRoleButton.hidden = room === null;
    switchRoleButton.textContent = isSpectating ? '下场 / Play here' : '旁观 / Spectate';
    switchRoleButton.dataset.mode = isSpectating ? 'player' : 'spectator';
  }
  if (button && room) {
    button.textContent = 'Leave';
  } else if (button) {
    button.textContent = isSpectating ? 'Join as spectator' : 'Join my_room';
  }
}

function draw() {
  if (!ctx || !canvas) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  canvas.dataset.playerCount = String(players.size);
  canvas.dataset.sessionIds = JSON.stringify([...players.keys()]);
  if (playerCountElement) {
    playerCountElement.textContent = `Points on canvas: ${players.size}`;
    playerCountElement.dataset.count = String(players.size);
  }

  players.forEach((player, sessionId) => {
    const isMe = sessionId === room?.sessionId;

    // Player circle
    ctx.beginPath();
    ctx.arc(player.x, player.y, 12, 0, Math.PI * 2);
    ctx.fillStyle = isMe ? '#2563eb' : '#6b7280';
    ctx.fill();

    // Session ID label
    ctx.fillStyle = '#9ca3af';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(sessionId.slice(0, 6), player.x, player.y + 24);
  });

  requestAnimationFrame(draw);
}

function attachRoomHandlers(joinedRoom: Room<MyRoom>) {
  room = joinedRoom;
  room.reconnection.minUptime = 0;
  writeStored(TOKEN_KEY, room.reconnectionToken);

  setStatus('connected', `Room ${room.roomId} | Session ${room.sessionId}`);
  if (button) {
    button.textContent = 'Leave';
    button.disabled = false;
  }
  updateRoleUI();

  // Sync players from state using Callbacks API. The state map contains only
  // active players, so a spectator intentionally never gets an onAdd for self.
  const callbacks = Callbacks.get(room);

  callbacks.onAdd("players", (player, sessionId) => {
    players.set(sessionId, { x: player.x, y: player.y });
    if (sessionId === room?.sessionId) {
      isSpectating = false;
      storePosition({ x: player.x, y: player.y });
      updateRoleUI();
    }
    callbacks.listen(player, "x", (value) => {
      const p = players.get(sessionId);
      if (p) p.x = value;
      if (sessionId === room?.sessionId) storePosition({ x: value, y: player.y });
    });
    callbacks.listen(player, "y", (value) => {
      const p = players.get(sessionId);
      if (p) p.y = value;
      if (sessionId === room?.sessionId) storePosition({ x: player.x, y: value });
    });
    log(`Player joined: ${sessionId}`);
  });

  callbacks.onRemove("players", (_, sessionId) => {
    players.delete(sessionId);
    if (sessionId === room?.sessionId) {
      isSpectating = true;
      updateRoleUI();
      log('You are now spectating.');
    } else {
      log(`Player left: ${sessionId}`);
    }
  });

  room.onLeave((code) => {
    setStatus('disconnected', `Disconnected (code: ${code})`);
    log(`Left room (code: ${code})`);
    if (button) {
      button.textContent = 'Join my_room';
      button.disabled = false;
    }
    room = null;
    players.clear();
    updateRoleUI();
  });

  room.onError((code, message) => {
    log(`Error ${code}: ${message}`);
  });

  // Arrow key movement. The server is authoritative about whether this
  // session has a point; spectator move messages are intentionally ignored.
  const speed = 5;
  const keys = new Set<string>();

  const onKeyDown = (e: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'w', 'a', 's', 'd'].includes(e.key)) {
      e.preventDefault();
      keys.add(e.key);
    }
  };
  const onKeyUp = (e: KeyboardEvent) => keys.delete(e.key);

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  const moveLoop = setInterval(() => {
    if (keys.size === 0 || !room) return;
    let dx = 0, dy = 0;
    if (keys.has('ArrowLeft') || keys.has('a')) dx -= speed;
    if (keys.has('ArrowRight') || keys.has('d')) dx += speed;
    if (keys.has('ArrowUp') || keys.has('w')) dy -= speed;
    if (keys.has('ArrowDown') || keys.has('s')) dy += speed;
    if (dx !== 0 || dy !== 0) {
      const me = players.get(room.sessionId);
      room.send('move', { x: (me?.x ?? lastOwnPosition?.x ?? 0) + dx, y: (me?.y ?? lastOwnPosition?.y ?? 0) + dy });
    }
  }, 1000 / 30);

  room.onLeave(() => {
    clearInterval(moveLoop);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  });

  if (!drawLoopStarted) {
    drawLoopStarted = true;
    requestAnimationFrame(draw);
  }
}

async function joinRoom() {
  if (room) {
    room.leave();
    writeStored(TOKEN_KEY, null);
    return;
  }

  button!.textContent = 'Connecting...';
  button!.disabled = true;
  setStatus('connecting', 'Connecting...');

  try {
    let client = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    const playerId = getPlayerId();

    // A refreshed page first tries the Colyseus reconnection token. The stable
    // playerId is a second layer: a fresh session still restores role/position.
    const token = readStored(TOKEN_KEY);
    if (token) {
      try {
        const reconnected = await client.reconnect(token);
        attachRoomHandlers(reconnected as Room<MyRoom>);
        log('Reconnected.');
        return;
      } catch {
        writeStored(TOKEN_KEY, null);
        client = new Client<typeof server>(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
      }
    }

    const coords = initialCoordinates();
    const joined = await client.joinOrCreate(ROOM_NAME, {
      playerId,
      spectator: isSpectating,
      ...(coords.x !== undefined ? { x: coords.x } : {}),
      ...(coords.y !== undefined ? { y: coords.y } : {}),
    });

    attachRoomHandlers(joined as Room<MyRoom>);
  } catch (e) {
    setStatus('disconnected', 'Connection failed');
    log(`Connection failed: ${e instanceof Error ? e.message : String(e)}`);
    if (button) {
      button.textContent = 'Join my_room';
      button.disabled = false;
    }
    room = null;
  }
}

button?.addEventListener('click', joinRoom);

spectatorInput?.addEventListener('change', () => {
  isSpectating = spectatorInput.checked;
  writeStored(SPECTATOR_KEY, isSpectating ? '1' : '0');

  if (room) {
    if (isSpectating) {
      room.send('spectate', {});
    } else {
      const coords = initialCoordinates();
      const point = {
        x: coords.x ?? lastOwnPosition?.x ?? Math.random() * (canvas?.width ?? 800),
        y: coords.y ?? lastOwnPosition?.y ?? Math.random() * (canvas?.height ?? 600),
      };
      room.send('play', point);
    }
  }
  updateRoleUI();
});

switchRoleButton?.addEventListener('click', () => {
  isSpectating = !isSpectating;
  writeStored(SPECTATOR_KEY, isSpectating ? '1' : '0');
  spectatorInput && (spectatorInput.checked = isSpectating);

  if (!room) return;
  if (isSpectating) {
    room.send('spectate', {});
  } else {
    const coords = initialCoordinates();
    const point = {
      x: coords.x ?? lastOwnPosition?.x ?? Math.random() * (canvas?.width ?? 800),
      y: coords.y ?? lastOwnPosition?.y ?? Math.random() * (canvas?.height ?? 600),
    };
    room.send('play', point);
  }
  updateRoleUI();
});

// Small debugging/automation surface. It does not replace the network API.
declare global {
  interface Window {
    __seatKit?: {
      join: typeof joinRoom;
      leave: () => void;
      move: (x: number, y: number) => void;
      spectate: () => void;
      play: (point?: { x: number; y: number }) => void;
      players: Map<string, { x: number; y: number }>;
      getRoom: () => Room<MyRoom> | null;
    };
  }
}

window.__seatKit = {
  join: joinRoom,
  leave: () => room?.leave(),
  move: (x: number, y: number) => room?.send('move', { x, y }),
  spectate: () => room?.send('spectate', {}),
  play: (point) => room?.send('play', point ?? lastOwnPosition ?? {
    x: Math.random() * 800,
    y: Math.random() * 600,
  }),
  players,
  getRoom: () => room,
};

// Convenient globals for manual debugging and browser automation.
Object.defineProperty(window, 'room', { configurable: true, get: () => room });
Object.defineProperty(window, 'players', { configurable: true, get: () => players });
(window as unknown as { game?: unknown }).game = window.__seatKit;

updateRoleUI();
