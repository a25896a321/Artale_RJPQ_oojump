const BOT_NAMES = ['💀A', '💀B', '💀C'];
const BASE_COLORS = ['#7B241C', '#A04000', '#1D8348', '#1B4F72'];
const IDLE_MS = 60 * 60 * 1000; // 1 hour

function initMapData() {
  return Array(10).fill(null).map(() =>
    Array(4).fill(null).map(() => ({
      v: 0, owner: null, ownerColor: null, ownerTextColor: null,
      errors: [], maybe: [], certain: false
    }))
  );
}

// ===== Stats Helpers =====
function getStats(env) {
  return env.STATS.get(env.STATS.idFromName('global'));
}

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

    // Stats API — 1 extra HTTP request per page load, no polling needed
    if (path === '/api/stats') {
      const stats = getStats(env);
      return stats.fetch(new Request('http://stats/get'));
    }

    // Serve static assets (index.html etc.)
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

    // Load persisted state before handling any requests
    this.state.blockConcurrencyWhile(async () => {
      const [config, map] = await Promise.all([
        this.state.storage.get('config'),
        this.state.storage.get('mapData')
      ]);
      if (config) {
        this.password = config.password || '';
        this.options = config.options || this.options;
        this.roomCreated = true;
      }
      this.mapData = map || initMapData();
    });
  }

  getActiveSessions() {
    return this.state.getWebSockets().filter(ws => {
      const d = ws.deserializeAttachment();
      return d?.joined === true;
    });
  }

  getPlayers() {
    const sessions = this.getActiveSessions();
    const real = sessions
      .map(ws => ws.deserializeAttachment())
      .map(d => ({
        nick: d.nick, color: d.color, textColor: d.textColor || '#ffffff',
        isHost: !!d.isHost, isBot: false
      }));
    const botCount = Math.max(0, 4 - real.length);
    const bots = BOT_NAMES.slice(0, botCount).map(name => ({
      nick: name, color: '#4a4a5a', textColor: '#888899', isHost: false, isBot: true
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

  async saveConfig() {
    await this.state.storage.put('config', { password: this.password, options: this.options });
  }

  async saveMapData() {
    await this.state.storage.put('mapData', this.mapData);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Upgrade to WebSocket required', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ joined: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }
    const session = ws.deserializeAttachment() || {};

    // Reset idle alarm
    await this.state.storage.setAlarm(Date.now() + IDLE_MS);

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
        // Auto-assign nick if empty
        const createNick = (data.nick && data.nick.trim()) ? data.nick.trim() : '未命名1';
        const sess = {
          joined: true, nick: createNick, color: BASE_COLORS[0],
          textColor: data.textColor || '#ffffff', isHost: true
        };
        ws.serializeAttachment(sess);
        await this.saveConfig();
        await this.saveMapData();
        await this.state.storage.setAlarm(Date.now() + IDLE_MS);
        // Update global stats
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
        this.broadcast({ type: 'SYNC', ...data }, ws);
        if (this.options.auto) {
          const msg = this.getMaybeState(data.f);
          this.broadcastAll(msg);
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
        for (const other of this.state.getWebSockets()) {
          const d = other.deserializeAttachment();
          if (d?.nick === data.nick && other !== ws) {
            try { other.send(JSON.stringify({ type: 'KICK' })); } catch (e) {}
            try { other.close(1000, 'Kicked'); } catch (e) {}
            break;
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

      case 'REBUILD': {
        if (!session.isHost) return;
        this.mapData = initMapData();
        await this.saveMapData();
        this.broadcast({ type: 'ROOM_CLOSED', reason: '房主已重建房間，請重新加入。' }, ws);
        for (const other of this.state.getWebSockets()) {
          if (other === ws) continue;
          try { other.close(1000, 'Rebuilt'); } catch (e) {}
        }
        this.roomCreated = false;
        this.password = '';
        await this.state.storage.delete('config');
        // Host stays, treated as fresh room creator
        ws.serializeAttachment({ ...session });
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
    if (active.length >= 4) {
      ws.send(JSON.stringify({ type: 'REJECT', reason: '房間已滿（最多4人）。' }));
      return;
    }
    if (this.password && data.password !== this.password) {
      ws.serializeAttachment({ ...session, pendingJoin: data });
      ws.send(JSON.stringify({ type: 'NEED_PW' }));
      return;
    }
    // Auto-assign nick if empty; avoid duplicates
    const usedNicks = active.map(s => s.deserializeAttachment()?.nick || '');
    let nick = (data.nick && data.nick.trim()) ? data.nick.trim() : '';
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
    const isFirstAndNoRoom = !this.roomCreated || active.length === 0;
    if (isFirstAndNoRoom) {
      this.roomCreated = true;
      await this.saveConfig();
    }
    const sess = { joined: true, nick, color, textColor: data.textColor || '#ffffff', isHost: isFirstAndNoRoom };
    ws.serializeAttachment(sess);
    if (this.options.auto) for (let f = 0; f < 10; f++) this.recalcMaybe(f);
    const players = this.getPlayers();
    // Update global stats
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
    this.removePlayerMarkers(session.nick);
    await this.saveMapData();
    // Decrement user count
    try { await getStats(this.env).fetch(new Request('http://stats/dec-user')); } catch (e) {}
    const players = this.getPlayers();
    this.broadcast({ type: 'NICK_LIST', players });
    this.broadcast({ type: 'PLAYER_LEFT', nick: session.nick });
    if (this.options.auto) {
      for (let f = 0; f < 10; f++) {
        this.broadcast(this.getMaybeState(f));
      }
    }
    if (session.isHost) {
      const remaining = this.getActiveSessions();
      if (remaining.length > 0) {
        const newHostWs = remaining[0];
        const nd = newHostWs.deserializeAttachment();
        newHostWs.serializeAttachment({ ...nd, isHost: true });
        try { newHostWs.send(JSON.stringify({ type: 'HOST_TRANSFER' })); } catch (e) {}
        const updatedPlayers = this.getPlayers();
        this.broadcastAll({ type: 'NICK_LIST', players: updatedPlayers });
      }
    }
  }

  async webSocketError(ws, error) {
    await this.webSocketClose(ws, 1011, 'Error', false);
  }

  async alarm() {
    // Idle timeout — notify, close all connections, wipe state, decrement room count
    const sessionCount = this.getActiveSessions().length;
    this.broadcastAll({ type: 'IDLE_TIMEOUT' });
    for (const ws of this.state.getWebSockets()) {
      try { ws.close(1000, 'Idle timeout'); } catch (e) {}
    }
    await this.state.storage.deleteAll();
    // Decrement room and remaining user counts from stats
    try { await getStats(this.env).fetch(new Request('http://stats/dec-room')); } catch (e) {}
    for (let i = 0; i < sessionCount; i++) {
      try { await getStats(this.env).fetch(new Request('http://stats/dec-user')); } catch (e) {}
    }
  }
}

// ===== Stats Durable Object =====
// Tracks global room count and user count.
// Called via internal subrequests (not counted toward 100k/day external request limit).
export class Stats {
  constructor(state, env) {
    this.state = state;
    this.data = { rooms: 0, users: 0 };
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get('data');
      if (stored) this.data = stored;
    });
  }

  async fetch(request) {
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
      default:
        return new Response('Not found', { status: 404 });
    }
    await this.state.storage.put('data', this.data);
    return new Response('ok');
  }
}
