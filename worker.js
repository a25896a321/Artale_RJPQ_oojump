const BOT_NAMES = ['💀A', '💀B', '💀C'];
const BASE_COLORS = ['#7B241C', '#A04000', '#1D8348', '#1B4F72'];

function initMapData() {
  return Array(10).fill(null).map(() =>
    Array(4).fill(null).map(() => ({
      v: 0, owner: null, ownerColor: null, ownerTextColor: null,
      errors: [], maybe: [], certain: false
    }))
  );
}

function getStats(env) {
  return env.STATS.get(env.STATS.idFromName('global'));
}

// ===== Admin purge secret =====
// Change this value before deploying, then remove the route entirely after use (Step 4).
const PURGE_SECRET = 'artale-purge-9517';

// ===== Main Worker =====
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket room endpoint
    if (path.startsWith('/room/')) {
      const roomId = path.slice(6).split('/')[0];
      if (!roomId || !/^\d{8}$/.test(roomId)) {
        return new Response('Invalid room ID', { status: 400 });
      }
      const stub = env.ROOM.get(env.ROOM.idFromName(roomId));
      return stub.fetch(request);
    }

    // Real-time stats via WebSocket (each connection = 1 request; updates are free)
    if (path === '/stats-ws') {
      return getStats(env).fetch(request);
    }

    // Legacy HTTP stats (kept for backward compat)
    if (path === '/api/stats') {
      return getStats(env).fetch(new Request('http://stats/get'));
    }

    // ── Admin purge endpoint ──────────────────────────────────────────────────
    // Usage: GET /admin/purge?key=artale-purge-9517
    // Clears the Stats DO (rooms/users counters).
    // Room DOs self-destruct via destroyRoom() when the last player leaves;
    // orphaned instances (if any) cannot be enumerated from the Worker and will
    // be garbage-collected by Cloudflare after months of inactivity.
    // REMOVE THIS BLOCK after use and redeploy (Step 4).
    if (path === '/admin/purge') {
      if (url.searchParams.get('key') !== PURGE_SECRET) {
        return new Response('403 Forbidden', { status: 403 });
      }
      // Purge Stats DO
      let statsResult = 'unknown';
      try {
        const res = await getStats(env).fetch(new Request('http://stats/purge'));
        statsResult = res.ok ? 'cleared' : `error ${res.status}`;
      } catch (e) {
        statsResult = `exception: ${e.message}`;
      }
      const html = `<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="UTF-8">
<title>Admin Purge</title>
<style>body{font-family:monospace;background:#0f0f1a;color:#e2e8f0;padding:40px;max-width:600px;margin:0 auto}
h2{color:#a855f7}table{border-collapse:collapse;width:100%;margin-top:16px}
td,th{border:1px solid #333;padding:8px 12px;text-align:left}
th{background:#1a1a2e;color:#94a3b8}.ok{color:#22c55e}.warn{color:#f59e0b}</style>
</head><body>
<h2>🧹 Durable Objects 清理結果</h2>
<table>
<tr><th>DO 類別</th><th>實例</th><th>結果</th></tr>
<tr><td>Stats</td><td>global</td><td class="${statsResult === 'cleared' ? 'ok' : 'warn'}">${statsResult}</td></tr>
<tr><td>Room</td><td>所有實例</td><td class="warn">⚠️ 無法從 Worker 列舉；已離線的房間均已自動 deleteAll()，孤兒實例由 Cloudflare 定期回收</td></tr>
</table>
<p style="margin-top:24px;color:#94a3b8;font-size:12px">
完成後請移除 /admin/purge 路由並重新部署（Step 4）。
</p>
</body></html>`;
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html;charset=UTF-8' }
      });
    }
    // ── End admin purge endpoint ──────────────────────────────────────────────

    return env.ASSETS.fetch(request);
  }
};

// ===== Room Durable Object =====
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.password = '';
    this.options = { auto: true, members: true, chat: false, seq: '1234' };
    this.mapData = null;
    this.roomCreated = false;
    // { nick: { color, textColor, wasHost } } — players who disconnected accidentally
    this.disconnectedPlayers = {};
    // Monotonically increasing per-session message sequence counter
    this.msgSeq = 0;

    // Restore persisted state from SQLite before handling any requests
    this.state.blockConcurrencyWhile(async () => {
      const [config, map, disconnected] = await Promise.all([
        this.state.storage.get('config'),
        this.state.storage.get('mapData'),
        this.state.storage.get('disconnectedPlayers')
      ]);
      if (config) {
        this.password = config.password || '';
        this.options = config.options || this.options;
        this.roomCreated = config.roomCreated !== undefined ? config.roomCreated : true;
      }
      this.mapData = map || initMapData();
      this.disconnectedPlayers = disconnected || {};
    });
  }

  // ── Session helpers ──────────────────────────────────────────────────────────

  getActiveSessions() {
    return this.state.getWebSockets().filter(ws => ws.deserializeAttachment()?.joined === true);
  }

  /** Returns all "game participants": active + disconnected + bot fillers (always 4 total). */
  getPlayers() {
    const active = this.getActiveSessions().map(ws => {
      const d = ws.deserializeAttachment();
      return { nick: d.nick, color: d.color, textColor: d.textColor || '#ffffff',
               isHost: !!d.isHost, isBot: false, isDisconnected: false };
    });
    const disconnected = Object.entries(this.disconnectedPlayers).map(([nick, info]) => ({
      nick, color: info.color, textColor: info.textColor || '#ffffff',
      isHost: false, isBot: false, isDisconnected: true
    }));
    const real = [...active, ...disconnected];
    const botCount = Math.max(0, 4 - real.length);
    const bots = BOT_NAMES.slice(0, botCount).map(name => ({
      nick: name, color: '#4a4a5a', textColor: '#888899', isHost: false, isBot: true, isDisconnected: false
    }));
    return [...real, ...bots];
  }

  broadcast(msg, excludeWs = null) {
    const str = JSON.stringify(msg);
    for (const ws of this.getActiveSessions()) {
      if (ws === excludeWs) continue;
      try { ws.send(str); } catch (e) {}
    }
  }

  broadcastAll(msg) {
    const str = JSON.stringify(msg);
    for (const ws of this.getActiveSessions()) {
      try { ws.send(str); } catch (e) {}
    }
  }

  /** Atomically increment and return the next sequence number. */
  nextSeq() { return ++this.msgSeq; }

  // ── Game logic ───────────────────────────────────────────────────────────────

  recalcMaybe(f) {
    if (!this.options.auto) return;
    const allPlayers = this.getPlayers().map(p => p.nick);
    for (let d = 0; d < 4; d++) { this.mapData[f][d].maybe = []; this.mapData[f][d].certain = false; }

    const passOwners = new Set();
    for (let d = 0; d < 4; d++) {
      if (this.mapData[f][d].v === 1 && this.mapData[f][d].owner) passOwners.add(this.mapData[f][d].owner);
    }

    const activePlayers = allPlayers.filter(p => !passOwners.has(p));
    const unpassedIdx = [];
    for (let d = 0; d < 4; d++) if (this.mapData[f][d].v !== 1) unpassedIdx.push(d);

    if (activePlayers.length === 0 || unpassedIdx.length === 0) return;

    const hasPassedPlayers = passOwners.size > 0;
    const anyActiveErrors = activePlayers.some(p => unpassedIdx.some(d => this.mapData[f][d].errors.includes(p)));
    if (!hasPassedPlayers && !anyActiveErrors) return;

    const possible = {};
    for (const p of activePlayers) {
      possible[p] = {};
      for (const d of unpassedIdx) possible[p][d] = !this.mapData[f][d].errors.includes(p);
    }

    // Tier 2 + 3: iterative Pigeonhole + cascade elimination
    let changed = true;
    while (changed) {
      changed = false;
      for (const d of unpassedIdx) {
        const pp = activePlayers.filter(p => possible[p][d]);
        if (pp.length === 1) {
          for (const d2 of unpassedIdx) {
            if (d2 !== d && possible[pp[0]][d2]) { possible[pp[0]][d2] = false; changed = true; }
          }
        }
      }
      for (const p of activePlayers) {
        const pc = unpassedIdx.filter(d => possible[p][d]);
        if (pc.length === 1) {
          for (const p2 of activePlayers) {
            if (p2 !== p && possible[p2][pc[0]]) { possible[p2][pc[0]] = false; changed = true; }
          }
        }
      }
    }

    for (const d of unpassedIdx) {
      const pp = activePlayers.filter(p => possible[p][d]);
      if (pp.length > 0) { this.mapData[f][d].maybe = pp; this.mapData[f][d].certain = pp.length === 1; }
    }
  }

  applySync(data) {
    const c = this.mapData[data.f][data.d];
    if (data.action === 'pass') {
      for (let d = 0; d < 4; d++) {
        if (this.mapData[data.f][d].owner === data.owner && d !== data.d) {
          this.mapData[data.f][d].v = 0; this.mapData[data.f][d].owner = null;
          this.mapData[data.f][d].ownerColor = null; this.mapData[data.f][d].ownerTextColor = null;
        }
      }
      c.v = 1; c.owner = data.owner; c.ownerColor = data.color; c.ownerTextColor = data.textColor || '#ffffff';
      if (this.options.auto) {
        for (let d = 0; d < 4; d++) {
          if (d !== data.d && !this.mapData[data.f][d].errors.includes(data.owner)) {
            this.mapData[data.f][d].errors.push(data.owner);
          }
        }
      }
    } else if (data.action === 'unpass') {
      c.v = 0; c.owner = null; c.ownerColor = null; c.ownerTextColor = null;
      if (this.options.auto) {
        for (let d = 0; d < 4; d++) {
          if (d !== data.d) this.mapData[data.f][d].errors = this.mapData[data.f][d].errors.filter(n => n !== data.owner);
        }
      }
    } else if (data.action === 'error') {
      if (!c.errors.includes(data.owner)) c.errors.push(data.owner);
    } else if (data.action === 'unerror') {
      c.errors = c.errors.filter(n => n !== data.owner);
    }
    if (this.options.auto) this.recalcMaybe(data.f);
  }

  removePlayerMarkers(nick) {
    for (let f = 0; f < 10; f++) {
      for (let d = 0; d < 4; d++) {
        const cell = this.mapData[f][d];
        if (cell.owner === nick) {
          cell.v = 0; cell.owner = null; cell.ownerColor = null; cell.ownerTextColor = null;
        }
        cell.errors = cell.errors.filter(n => n !== nick);
      }
    }
    if (this.options.auto) for (let f = 0; f < 10; f++) this.recalcMaybe(f);
  }

  getMaybeState(f) {
    return { type: 'MAYBE_STATE', f, state: this.mapData[f].map(c => ({ maybe: c.maybe, certain: c.certain })) };
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  async saveConfig() {
    await this.state.storage.put('config', {
      password: this.password, options: this.options, roomCreated: this.roomCreated
    });
  }

  async saveMapData() {
    await this.state.storage.put('mapData', this.mapData);
  }

  async saveDisconnected() {
    await this.state.storage.put('disconnectedPlayers', this.disconnectedPlayers);
  }

  /** Delete all SQLite data for this room and update global stats. */
  async destroyRoom() {
    this.roomCreated = false;
    this.disconnectedPlayers = {};
    this.mapData = initMapData();
    await this.state.storage.deleteAll();
    try { await getStats(this.env).fetch(new Request('http://stats/dec-room')); } catch (e) {}
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────────────────

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Upgrade to WebSocket required', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Use Hibernation API — DO hibernates between messages; no setTimeout needed
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ joined: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }
    const session = ws.deserializeAttachment() || {};

    switch (data.type) {

      case 'CREATE': {
        const active = this.getActiveSessions();
        if (this.roomCreated && active.length > 0) {
          await this._doJoin(ws, session, data);
          return;
        }
        this.roomCreated = true;
        this.password = data.password || '';
        this.options = {
          auto: data.options?.auto !== false,
          members: data.options?.members !== false,
          chat: data.options?.chat !== false,
          seq: data.options?.seq || '1234'
        };
        const createNick = (data.nick && data.nick.trim()) ? data.nick.trim() : '未命名1';
        const sess = {
          joined: true, nick: createNick, color: BASE_COLORS[0],
          textColor: data.textColor || '#ffffff', isHost: true
        };
        ws.serializeAttachment(sess);
        await this.saveConfig();
        await this.saveMapData();
        try { await getStats(this.env).fetch(new Request('http://stats/inc-room')); } catch (e) {}
        try { await getStats(this.env).fetch(new Request('http://stats/inc-user')); } catch (e) {}
        ws.send(JSON.stringify({
          type: 'WELCOME', isHost: true, myNick: sess.nick, myColor: sess.color, myTextColor: sess.textColor,
          state: this.mapData, players: this.getPlayers(),
          options: this.options, hasPw: !!this.password, password: this.password
        }));
        break;
      }

      case 'JOIN': {
        await this._doJoin(ws, session, data);
        break;
      }

      case 'JOIN_PW': {
        const pending = session.pendingJoin;
        if (!pending) return;
        await this._doJoin(ws, { ...session, pendingJoin: undefined }, { ...pending, password: data.password });
        break;
      }

      case 'SYNC': {
        if (!session.joined) return;
        this.applySync(data);
        const syncSeq = this.nextSeq();
        this.broadcast({ type: 'SYNC', seq: syncSeq, ...data }, ws);
        if (this.options.auto) {
          const maybeSeq = this.nextSeq();
          this.broadcastAll({ ...this.getMaybeState(data.f), seq: maybeSeq });
        }
        await this.saveMapData();
        break;
      }

      case 'CHAT': {
        if (!session.joined || !this.options.chat) return;
        this.broadcastAll({ type: 'CHAT', nick: session.nick, color: session.color, msg: data.msg });
        break;
      }

      case 'UPDATE_NICK': {
        if (!session.joined) return;
        ws.serializeAttachment({ ...session, nick: data.nick, color: data.color, textColor: data.textColor });
        this.broadcastAll({ type: 'NICK_LIST', players: this.getPlayers() });
        break;
      }

      case 'RESET': {
        if (!session.isHost) return;
        this.mapData = initMapData();
        await this.saveMapData();
        this.broadcastAll({ type: 'RESET' });
        break;
      }

      case 'KICK': {
        if (!session.isHost) return;
        // Try to kick an active (connected) player
        let kicked = false;
        for (const other of this.state.getWebSockets()) {
          const d = other.deserializeAttachment();
          if (d?.nick === data.nick && other !== ws) {
            try { other.send(JSON.stringify({ type: 'KICK' })); } catch (e) {}
            try { other.close(1000, 'Kicked'); } catch (e) {}
            kicked = true;
            break;
          }
        }
        // Fallback: kick a disconnected player (no active WebSocket)
        if (!kicked && this.disconnectedPlayers[data.nick]) {
          this.removePlayerMarkers(data.nick);
          delete this.disconnectedPlayers[data.nick];
          await this.saveDisconnected();
          await this.saveMapData();
          const players = this.getPlayers();
          this.broadcastAll({ type: 'PLAYER_LEFT', nick: data.nick, players });
          if (this.options.auto) {
            for (let f = 0; f < 10; f++) {
              this.broadcastAll({ ...this.getMaybeState(f), seq: this.nextSeq() });
            }
          }
        }
        break;
      }

      case 'UPDATE_PW': {
        if (!session.isHost) return;
        this.password = data.password || '';
        await this.saveConfig();
        this.broadcastAll({ type: 'UPDATE_ROOM', hasPw: !!this.password, password: this.password });
        break;
      }

      case 'PING': {
        try { ws.send(JSON.stringify({ type: 'PONG' })); } catch (e) {}
        break;
      }
    }
  }

  async _doJoin(ws, session, data) {
    const active = this.getActiveSessions();
    const requestedNick = (data.nick && data.nick.trim()) ? data.nick.trim() : '';

    // ── Reconnect path: nick found in disconnectedPlayers ──────────────────────
    if (requestedNick && this.disconnectedPlayers[requestedNick]) {
      const info = this.disconnectedPlayers[requestedNick];
      if (this.password && data.password !== this.password) {
        ws.serializeAttachment({ ...session, pendingJoin: data });
        ws.send(JSON.stringify({ type: 'NEED_PW' }));
        return;
      }
      // Restore: remove from disconnected, mark as active again
      delete this.disconnectedPlayers[requestedNick];
      await this.saveDisconnected();
      const sess = {
        joined: true, nick: requestedNick,
        color: info.color, textColor: data.textColor || info.textColor,
        isHost: false
      };
      ws.serializeAttachment(sess);
      if (this.options.auto) for (let f = 0; f < 10; f++) this.recalcMaybe(f);
      const players = this.getPlayers();
      try { await getStats(this.env).fetch(new Request('http://stats/inc-user')); } catch (e) {}
      ws.send(JSON.stringify({
        type: 'WELCOME', isHost: false, myNick: requestedNick, myColor: info.color,
        myTextColor: sess.textColor, state: this.mapData, players,
        options: this.options, hasPw: !!this.password, password: this.password
      }));
      this.broadcast({ type: 'PLAYER_JOINED', nick: requestedNick, players }, ws);
      if (this.options.auto) {
        for (let f = 0; f < 10; f++) {
          this.broadcastAll({ ...this.getMaybeState(f), seq: this.nextSeq() });
        }
      }
      return;
    }

    // ── New player path ────────────────────────────────────────────────────────
    // Hard cap: only active sessions count — a disconnected slot can be displaced
    if (active.length >= 4) {
      ws.send(JSON.stringify({ type: 'REJECT', reason: '房間已滿（最多4人）。' }));
      return;
    }
    if (this.password && data.password !== this.password) {
      ws.serializeAttachment({ ...session, pendingJoin: data });
      ws.send(JSON.stringify({ type: 'NEED_PW' }));
      return;
    }

    // Auto-evict the oldest disconnected player when total would exceed 4
    if (active.length + Object.keys(this.disconnectedPlayers).length >= 4) {
      const evictNick = Object.keys(this.disconnectedPlayers)[0];
      if (evictNick) {
        this.removePlayerMarkers(evictNick);
        delete this.disconnectedPlayers[evictNick];
        await this.saveDisconnected();
        await this.saveMapData();
        this.broadcastAll({ type: 'PLAYER_LEFT', nick: evictNick, players: this.getPlayers() });
      }
    }

    // Nick uniqueness across active + remaining disconnected (after any eviction)
    const usedNicks = [
      ...active.map(s => s.deserializeAttachment()?.nick || ''),
      ...Object.keys(this.disconnectedPlayers)
    ];
    let nick = requestedNick;
    if (!nick) {
      for (let n = 1; n <= 4; n++) {
        const candidate = `未命名${n}`;
        if (!usedNicks.includes(candidate)) { nick = candidate; break; }
      }
      if (!nick) nick = `未命名${Date.now() % 100}`;
    } else if (usedNicks.includes(nick)) {
      ws.send(JSON.stringify({ type: 'REJECT', reason: `暱稱「${nick}」已有人使用。` }));
      return;
    }

    const usedColors = active.map(s => s.deserializeAttachment()?.color || '');
    const color = BASE_COLORS.find(c => !usedColors.includes(c)) || data.color || '#94a3b8';
    const isFirstAndNoRoom =
      !this.roomCreated || (active.length === 0 && Object.keys(this.disconnectedPlayers).length === 0);
    if (isFirstAndNoRoom) {
      this.roomCreated = true;
      await this.saveConfig();
    }
    const sess = { joined: true, nick, color, textColor: data.textColor || '#ffffff', isHost: isFirstAndNoRoom };
    ws.serializeAttachment(sess);
    if (this.options.auto) for (let f = 0; f < 10; f++) this.recalcMaybe(f);
    const players = this.getPlayers();
    try { await getStats(this.env).fetch(new Request('http://stats/inc-user')); } catch (e) {}
    ws.send(JSON.stringify({
      type: 'WELCOME', isHost: sess.isHost, myNick: nick, myColor: color, myTextColor: sess.textColor,
      state: this.mapData, players, options: this.options, hasPw: !!this.password, password: this.password
    }));
    this.broadcast({ type: 'NICK_LIST', players }, ws);
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const session = ws.deserializeAttachment();
    if (!session?.joined) return;

    // code 1000/1001 = intentional leave; anything else = accidental disconnect
    const isIntentional = (code === 1000 || code === 1001);

    if (isIntentional) {
      // Clean leave: wipe this player's marks from the shared board
      this.removePlayerMarkers(session.nick);
      await this.saveMapData();
    } else {
      // Accidental disconnect: preserve marks in mapData; save player info for reconnect
      this.disconnectedPlayers[session.nick] = {
        color: session.color, textColor: session.textColor, wasHost: session.isHost
      };
      await this.saveDisconnected();
    }

    try { await getStats(this.env).fetch(new Request('http://stats/dec-user')); } catch (e) {}

    const players = this.getPlayers();
    const msgType = isIntentional ? 'PLAYER_LEFT' : 'PLAYER_DISCONNECTED';
    this.broadcast({ type: msgType, nick: session.nick, players });

    // Recalc after intentional leave (marks removed → board changed)
    if (isIntentional && this.options.auto) {
      for (let f = 0; f < 10; f++) this.broadcast(this.getMaybeState(f));
    }

    // Host transfer
    if (session.isHost) {
      const remaining = this.getActiveSessions();
      if (remaining.length > 0) {
        const newHostWs = remaining[0];
        const nd = newHostWs.deserializeAttachment();
        newHostWs.serializeAttachment({ ...nd, isHost: true });
        try { newHostWs.send(JSON.stringify({ type: 'HOST_TRANSFER' })); } catch (e) {}
        this.broadcastAll({ type: 'NICK_LIST', players: this.getPlayers() });
      }
    }

    // Room destruction logic
    // Regardless of intentional/accidental, once the last active session is gone
    // there is no room to reconnect to — destroy and clear SQLite immediately.
    const remaining = this.getActiveSessions();
    if (remaining.length === 0 && this.roomCreated) {
      await this.destroyRoom();
    }
  }

  async webSocketError(ws, error) {
    // Treat WebSocket errors as accidental disconnects (non-1000)
    await this.webSocketClose(ws, 1011, 'Error', false);
  }
}

// ===== Stats Durable Object =====
// Tracks global room + user counts.
// Supports both HTTP subrequests (from Room DOs) and WebSocket push (for client display).
export class Stats {
  constructor(state, env) {
    this.state = state;
    this.data = { rooms: 0, users: 0 };
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get('data');
      if (stored) this.data = stored;
    });
  }

  /** Push current stats to all connected WebSocket clients instantly. */
  broadcastStats() {
    const msg = JSON.stringify({ type: 'STATS_UPDATE', rooms: this.data.rooms, users: this.data.users });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(msg); } catch (e) {}
    }
  }

  async fetch(request) {
    // WebSocket upgrade → real-time stats subscription (Hibernation API)
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      // Send current snapshot immediately after handshake
      server.send(JSON.stringify({ type: 'STATS_UPDATE', ...this.data }));
      return new Response(null, { status: 101, webSocket: client });
    }

    const url = new URL(request.url);
    switch (url.pathname) {
      case '/inc-room': this.data.rooms = Math.max(0, this.data.rooms + 1); break;
      case '/dec-room': this.data.rooms = Math.max(0, this.data.rooms - 1); break;
      case '/inc-user': this.data.users = Math.max(0, this.data.users + 1); break;
      case '/dec-user': this.data.users = Math.max(0, this.data.users - 1); break;
      case '/get':
        return new Response(JSON.stringify(this.data), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      case '/purge':
        // Full reset: wipe SQLite storage and zero in-memory counters
        this.data = { rooms: 0, users: 0 };
        await this.state.storage.deleteAll();
        this.broadcastStats();
        return new Response('Stats DO cleared', { status: 200 });
      default:
        return new Response('Not found', { status: 404 });
    }
    await this.state.storage.put('data', this.data);
    this.broadcastStats(); // Push update to all stats subscribers
    return new Response('ok');
  }

  // Stats clients are read-only; no inbound messages expected
  webSocketMessage(ws, message) {}
  webSocketClose(ws, code, reason, wasClean) {}
  webSocketError(ws, error) {}
}
