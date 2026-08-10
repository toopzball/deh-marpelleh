// ============================================================================
// وُرکرِ بازیِ «مار و پله» — رویِ یه حسابِ جدایِ کلادفلر دیپلوی می‌شه (نه همون حسابِ سایتِ اصلی
// و نه همون حسابِ deh-games/دوز)، دقیقاً به همین‌خاطر اینجا هیچ بایندینگِ D1ای نداریم: هر کاری که
// به دیتایِ کاربر/دهپوینت/مهره نیاز داره از طریقِ اندپوینت‌هایِ داخلیِ وُرکرِ اصلی (env.MAIN_API_BASE +
// هدرِ X-Internal-Key = env.INTERNAL_KEY) انجام می‌شه، نه با کوئریِ مستقیم.
//
// لازمه‌ی دیپلوی (Secrets، نه vars، چون این آدرس‌ها نباید تویِ ریپازیتوریِ گیت‌هاب دیده بشن):
//   wrangler secret put MAIN_API_BASE     (مثلاً https://dehat-site.pages.dev یا آدرسِ وُرکرِ اصلی)
//   wrangler secret put INT ERNAL_KEY      (همون مقداری که تو وُرکرِ اصلی هم env.INTERNAL_KEY هست)
//
// wrangler.toml باید دو تا Durable Object را bind کنه: MARPELLE_ROOM -> MarPelleRoom,
// MARPELLE_LOBBY -> MarPelleLobby (یه instance ثابت با idFromName("global")).
// ============================================================================

function corsHeadersFor(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ---------- صدا زدنِ اندپوینت‌هایِ داخلیِ وُرکرِ اصلی ----------
async function internalFetch(env, path, opts = {}) {
  const res = await fetch(`${env.MAIN_API_BASE}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Internal-Key": env.INTERNAL_KEY, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || data.ok === false) return null;
  return data;
}

async function verifyToken(env, token) {
  if (!token) return null;
  const data = await internalFetch(env, "/api/internal/verify-token", { method: "POST", body: JSON.stringify({ token }) });
  return data ? { username: data.username, avatarFileId: data.avatarFileId } : null;
}

async function fetchUserPiece(env, username) {
  const data = await internalFetch(env, `/api/internal/dooz-piece?username=${encodeURIComponent(username)}`);
  return data ? data.piece : null;
}

async function awardDehpoints(env, username, amount) {
  await internalFetch(env, "/api/internal/award-points", { method: "POST", body: JSON.stringify({ username, amount }) }).catch(() => {});
}

async function getUserFromRequest(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  return verifyToken(env, token);
}

// ---------- چیدمانِ ثابتِ تخته: ۱۰×۱۰ مارپیچ، ۳ نردبون، ۳ مار، ۱۵ خونه‌ی فلاکت ----------
// خونه‌ها از ۱ تا ۱۰۰ شماره‌گذاری می‌شن (خودِ رندرِ مارپیچی رو کلاینت انجام می‌ده، سرور فقط با
// شماره کار داره). این سه‌تا مجموعه هیچ‌جا با هم هم‌پوشانی ندارن.
const LADDERS = { 4: 25, 28: 51, 62: 84 };
const SNAKES = { 47: 9, 71: 35, 93: 58 };
const MISFORTUNE_SQUARES = new Set([7, 13, 18, 22, 30, 38, 42, 55, 60, 67, 73, 79, 88, 92, 97]);
const WHEEL_OPTIONS = ["shock_wire", "aghi_puzzle", "hamster_combat", "gozar"];
const MARPELLE_WIN_POINTS = 20;
const MARPELLE_TURN_MS = 45000; // اگه تویِ این مدت حرکت نکنه، نوبتش رد می‌شه (فرارِ غیرِ فعال)
const MARPELLE_FORFEIT_MS = 30000; // اگه بعدِ قطعیِ اتصال تو این مدت برنگرده، بازنده‌ی خودکار می‌شه

function boardStaticInfo() {
  return { ladders: LADDERS, snakes: SNAKES, misfortune: [...MISFORTUNE_SQUARES] };
}

function generateMarPelleCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ============================================================================
// Durable Object: MarPelleRoom — یه بازیِ دونفره
// ============================================================================
export class MarPelleRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.code = null;
    this.visibility = "private";
    this.hostUsername = null;
    this.players = new Map(); // username -> { ws, avatarFileId, piece, position, connected, pendingChallenge }
    this.order = [];
    this.turn = null;
    this.status = "empty"; // empty | waiting | playing | finished
    this.winner = null;
    this.lastRoll = null;
    this.deadline = null;
    this.rematchVotes = new Set();
    this._turnTimer = null;
    this._forfeitTimers = new Map();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") === "websocket") return this.handleWsUpgrade(request);

    if (url.pathname === "/create" && request.method === "POST") {
      const body = await request.json();
      this.code = body.code;
      this.visibility = body.visibility === "public" ? "public" : "private";
      this.hostUsername = body.hostUsername;
      this.status = "waiting";
      if (this.visibility === "public") this.registerInLobby(body.hostAvatarFileId || null);
      return json({ ok: true });
    }
    if (url.pathname === "/info" && request.method === "GET") {
      return json({
        exists: this.status !== "empty",
        visibility: this.visibility,
        status: this.status,
        playersCount: this.order.length,
        hostUsername: this.hostUsername,
      });
    }
    return json({ error: "مسیر نامعتبر" }, 404);
  }

  handleWsUpgrade(request) {
    const username = request.headers.get("X-MarPelle-Username");
    const avatarFileId = request.headers.get("X-MarPelle-Avatar") || null;
    if (!username) return json({ error: "احرازِ هویت نامعتبر" }, 401);
    if (this.status === "empty") return json({ error: "همچین رومی وجود نداره" }, 404);

    const isReturning = this.players.has(username);
    if (!isReturning && this.order.length >= 2) return json({ error: "این روم پره" }, 403);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    if (isReturning) {
      const p = this.players.get(username);
      p.ws = server;
      p.connected = true;
      this.clearForfeitTimer(username);
    } else {
      this.players.set(username, {
        ws: server, avatarFileId, piece: null, position: 0, connected: true, pendingChallenge: null,
      });
      this.order.push(username);
      if (!this.hostUsername) this.hostUsername = username;
      // مهره‌ی دوزِ کاربر رو یه‌بار از وُرکرِ اصلی می‌گیریم و به‌عنوانِ اسکینش استفاده می‌کنیم؛
      // کاربر لازم نیست چیزی بسازه، اگه قبلاً تو دوز نساخته باشه اسکینِ پیش‌فرض می‌گیره
      fetchUserPiece(this.env, username).then((piece) => {
        const p = this.players.get(username);
        if (p) { p.piece = piece; this.broadcast(); }
      });
    }

    server.addEventListener("message", (evt) => this.onMessage(username, evt));
    server.addEventListener("close", () => this.onClose(username));
    server.addEventListener("error", () => this.onClose(username));

    this.send(server, { t: "hello", you: username, room: this.publicState() });
    this.broadcast();
    this.updateLobbyCount();
    this.maybeStartMatch();

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(username, evt) {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (e) { return; }
    const player = this.players.get(username);
    if (!player || !msg || typeof msg.t !== "string") return;

    if (msg.t === "setVisibility") {
      if (username !== this.hostUsername) return;
      const wasPublic = this.visibility === "public";
      this.visibility = msg.v === "public" ? "public" : "private";
      if (!wasPublic && this.visibility === "public") this.registerInLobby(this.players.get(this.hostUsername)?.avatarFileId || null);
      if (wasPublic && this.visibility !== "public") this.removeFromLobby();
      this.broadcast();
      return;
    }

    if (msg.t === "rollDice") {
      if (this.status !== "playing" || this.turn !== username) return;
      if (player.pendingChallenge) return; // باید اول چالشِ فلاکت رو جواب بده، تاسی درکار نیست
      this.doRoll(username);
      return;
    }

    // نتیجه‌ی مینی‌گیمِ خونه‌ی فلاکت. سیم‌شوک: retry نامحدود همون‌جا، فقط success می‌فرسته.
    // پازلِ عاقی/همستر کامبت: هر نوبت یه فرصت؛ success یا fail هردو می‌رسه.
    if (msg.t === "challengeResult") {
      if (this.status !== "playing" || this.turn !== username) return;
      if (!player.pendingChallenge) return;
      const type = player.pendingChallenge.type;
      if (msg.success) {
        player.pendingChallenge = null;
        this.finishTurn(username, `فلاکت رو رد کرد (${type})`);
      } else if (type !== "shock_wire") {
        // سیم‌شوک هیچ‌وقت fail نمی‌فرسته (retry نامحدوده)؛ برایِ بقیه fail یعنی نوبتش رد شد
        this.finishTurn(username, `تو فلاکت (${type}) موند`);
      }
      return;
    }

    if (msg.t === "rematch") {
      if (this.status !== "finished" || this.order.length !== 2) return;
      this.rematchVotes.add(username);
      if (this.order.every((u) => this.rematchVotes.has(u))) {
        this.rematchVotes.clear();
        for (const u of this.order) {
          const p = this.players.get(u);
          p.position = 0;
          p.pendingChallenge = null;
        }
        this.winner = null;
        this.lastRoll = null;
        this.status = "playing";
        this.turn = this.order[0];
        this.startTurnTimer();
        this.updateLobbyCount();
      }
      this.broadcast();
      return;
    }

    if (msg.t === "leave") {
      this.removePlayer(username);
      return;
    }
  }

  doRoll(username) {
    this.clearTurnTimer();
    const player = this.players.get(username);
    const roll = 1 + Math.floor(Math.random() * 6);
    this.lastRoll = { username, roll };

    const target = player.position + roll;
    if (target > 100) {
      // باید دقیقاً رویِ ۱۰۰ بشینه؛ اگه بیشتر بشه حرکت نمی‌کنه و نوبت رد می‌شه
      this.finishTurn(username, "زیادی ریخت، جا نشد");
      return;
    }

    let finalSquare = target;
    let event = null;
    if (LADDERS[finalSquare]) { finalSquare = LADDERS[finalSquare]; event = "ladder"; }
    else if (SNAKES[finalSquare]) { finalSquare = SNAKES[finalSquare]; event = "snake"; }
    player.position = finalSquare;

    if (finalSquare === 100) {
      this.status = "finished";
      this.winner = username;
      this.turn = null;
      this.updateLobbyCount();
      awardDehpoints(this.env, username, MARPELLE_WIN_POINTS);
      this.broadcast();
      return;
    }

    if (MISFORTUNE_SQUARES.has(finalSquare)) {
      const type = WHEEL_OPTIONS[Math.floor(Math.random() * WHEEL_OPTIONS.length)];
      if (type === "gozar") {
        // گذار: بدونِ هیچ مینی‌گیمی رد می‌شه، انگار فلاکتی درکار نبوده
        this.broadcast({ t: "wheelResult", username, type });
        this.finishTurn(username, "گذار کرد");
        return;
      }
      player.pendingChallenge = { type, startedAt: Date.now() };
      this.broadcast({ t: "wheelResult", username, type });
      this.broadcast(); // وضعیتِ pendingChallenge رو هم پخش کن؛ نوبت هنوز همینه، منتظرِ challengeResult
      return;
    }

    this.finishTurn(username, event || "حرکتِ عادی");
  }

  finishTurn(username, reasonLabel) {
    this.turn = this.otherOf(username);
    this.startTurnTimer();
    this.broadcast();
  }

  otherOf(username) { return this.order.find((u) => u !== username) || null; }

  maybeStartMatch() {
    if (this.status !== "waiting" || this.order.length !== 2) return;
    this.status = "playing";
    this.turn = this.order[0];
    this.startTurnTimer();
    this.updateLobbyCount();
    this.broadcast();
  }

  startTurnTimer() {
    this.clearTurnTimer();
    this.deadline = Date.now() + MARPELLE_TURN_MS;
    this._turnTimer = setTimeout(() => {
      // بی‌تحرکی: اگه چالش داشت نادیده گرفتنش، وگرنه فقط نوبت رد می‌شه (تاس نمی‌زنه)
      const u = this.turn;
      if (!u) return;
      const p = this.players.get(u);
      if (p) p.pendingChallenge = null;
      this.finishTurn(u, "بی‌تحرکی");
    }, MARPELLE_TURN_MS);
  }
  clearTurnTimer() { if (this._turnTimer) { clearTimeout(this._turnTimer); this._turnTimer = null; } }

  onClose(username) {
    const p = this.players.get(username);
    if (!p) return;
    p.connected = false;
    p.ws = null;
    this.broadcast();
    if (this.status === "playing" || this.status === "waiting") {
      const timer = setTimeout(() => {
        const stillGone = this.players.get(username) && !this.players.get(username).connected;
        if (stillGone && this.order.length === 2 && this.status !== "finished") {
          this.status = "finished";
          this.winner = this.otherOf(username);
          this.turn = null;
          this.updateLobbyCount();
          if (this.winner) awardDehpoints(this.env, this.winner, MARPELLE_WIN_POINTS);
          this.broadcast();
        }
      }, MARPELLE_FORFEIT_MS);
      this._forfeitTimers.set(username, timer);
    }
  }
  clearForfeitTimer(username) {
    const t = this._forfeitTimers.get(username);
    if (t) { clearTimeout(t); this._forfeitTimers.delete(username); }
  }

  removePlayer(username) {
    this.clearForfeitTimer(username);
    const p = this.players.get(username);
    if (p && p.ws) { try { p.ws.close(); } catch (e) {} }
    this.players.delete(username);
    this.order = this.order.filter((u) => u !== username);
    if (this.order.length === 0) {
      this.status = "empty";
      this.removeFromLobby();
      return;
    }
    if (this.status === "playing" || this.status === "waiting") {
      this.status = "finished";
      this.winner = this.order[0] || null;
      this.turn = null;
      this.updateLobbyCount();
      if (this.winner) awardDehpoints(this.env, this.winner, MARPELLE_WIN_POINTS);
    }
    this.broadcast();
  }

  publicState() {
    return {
      code: this.code,
      visibility: this.visibility,
      hostUsername: this.hostUsername,
      status: this.status,
      turn: this.turn,
      winner: this.winner,
      lastRoll: this.lastRoll,
      deadline: this.deadline,
      board: boardStaticInfo(),
      players: this.order.map((u) => {
        const p = this.players.get(u);
        return {
          username: u,
          avatarFileId: p.avatarFileId,
          piece: p.piece,
          position: p.position,
          connected: p.connected,
          pendingChallenge: p.pendingChallenge ? p.pendingChallenge.type : null,
        };
      }),
    };
  }

  send(ws, data) { try { ws.send(JSON.stringify(data)); } catch (e) {} }
  broadcast(extra) {
    const state = { t: "state", room: this.publicState() };
    for (const u of this.order) {
      const p = this.players.get(u);
      if (p && p.ws) { this.send(p.ws, state); if (extra) this.send(p.ws, extra); }
    }
  }

  registerInLobby(hostAvatarFileId) {
    this.env.MARPELLE_LOBBY.get(this.env.MARPELLE_LOBBY.idFromName("global")).fetch("https://lobby/upsert", {
      method: "POST",
      body: JSON.stringify({ code: this.code, hostUsername: this.hostUsername, hostAvatarFileId, playersCount: this.order.length }),
    }).catch(() => {});
  }
  updateLobbyCount() {
    if (this.visibility !== "public") return;
    this.env.MARPELLE_LOBBY.get(this.env.MARPELLE_LOBBY.idFromName("global")).fetch("https://lobby/count", {
      method: "POST",
      body: JSON.stringify({ code: this.code, playersCount: this.order.length, status: this.status }),
    }).catch(() => {});
  }
  removeFromLobby() {
    this.env.MARPELLE_LOBBY.get(this.env.MARPELLE_LOBBY.idFromName("global")).fetch("https://lobby/remove", {
      method: "POST",
      body: JSON.stringify({ code: this.code }),
    }).catch(() => {});
  }
}

// ============================================================================
// Durable Object: MarPelleLobby — لیستِ روم‌هایِ عمومیِ باز (همون الگویِ DoozLobby)
// ============================================================================
export class MarPelleLobby {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map(); // code -> { hostUsername, hostAvatarFileId, playersCount, status }
  }
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (url.pathname === "/upsert") {
      this.rooms.set(body.code, { hostUsername: body.hostUsername, hostAvatarFileId: body.hostAvatarFileId, playersCount: body.playersCount, status: "waiting" });
      return json({ ok: true });
    }
    if (url.pathname === "/count") {
      const r = this.rooms.get(body.code);
      if (r) { r.playersCount = body.playersCount; r.status = body.status; if (body.status !== "waiting") this.rooms.delete(body.code); }
      return json({ ok: true });
    }
    if (url.pathname === "/remove") {
      this.rooms.delete(body.code);
      return json({ ok: true });
    }
    if (url.pathname === "/list") {
      const list = [...this.rooms.entries()]
        .filter(([, r]) => r.status === "waiting" && r.playersCount < 2)
        .map(([code, r]) => ({ code, hostUsername: r.hostUsername, hostAvatarFileId: r.hostAvatarFileId }))
        .slice(0, 30);
      return json({ ok: true, rooms: list });
    }
    return json({ error: "مسیر نامعتبر" }, 404);
  }
}

// ============================================================================
// REST + WS روتینگ
// ============================================================================
async function handleCreateRoom(request, env) {
  const user = await getUserFromRequest(request, env);
  if (!user) return json({ error: "لطفاً وارد شو" }, 401);
  const body = await request.json().catch(() => ({}));
  const code = generateMarPelleCode();
  const roomId = env.MARPELLE_ROOM.idFromName(code);
  await env.MARPELLE_ROOM.get(roomId).fetch("https://room/create", {
    method: "POST",
    body: JSON.stringify({ code, visibility: body.visibility === "public" ? "public" : "private", hostUsername: user.username, hostAvatarFileId: user.avatarFileId }),
  });
  return json({ ok: true, code });
}

async function handleRoomInfo(request, env, code) {
  const roomId = env.MARPELLE_ROOM.idFromName(code.toUpperCase());
  const res = await env.MARPELLE_ROOM.get(roomId).fetch("https://room/info");
  return res;
}

async function handleRoomsList(request, env) {
  const res = await env.MARPELLE_LOBBY.get(env.MARPELLE_LOBBY.idFromName("global")).fetch("https://lobby/list");
  return res;
}

async function handleWs(request, env, url) {
  const token = url.searchParams.get("token");
  const code = (url.searchParams.get("code") || "").toUpperCase();
  if (!code) return json({ error: "کد لازمه" }, 400);
  const user = await verifyToken(env, token);
  if (!user) return json({ error: "احرازِ هویت نامعتبر" }, 401);

  const roomId = env.MARPELLE_ROOM.idFromName(code);
  const forwardedRequest = new Request(request.url, request);
  forwardedRequest.headers.set("X-MarPelle-Username", user.username);
  if (user.avatarFileId) forwardedRequest.headers.set("X-MarPelle-Avatar", user.avatarFileId);
  return env.MARPELLE_ROOM.get(roomId).fetch(forwardedRequest);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeadersFor(request) });

    try {
      let response;
      if (url.pathname === "/api/marpelleh/create" && request.method === "POST") {
        response = await handleCreateRoom(request, env);
      } else if (url.pathname.startsWith("/api/marpelleh/room/") && request.method === "GET") {
        response = await handleRoomInfo(request, env, url.pathname.split("/").pop());
      } else if (url.pathname === "/api/marpelleh/rooms" && request.method === "GET") {
        response = await handleRoomsList(request, env);
      } else if (url.pathname === "/api/marpelleh/ws") {
        response = await handleWs(request, env, url);
      } else {
        response = json({ error: "مسیرِ نامعتبر" }, 404);
      }
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeadersFor(request))) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    } catch (e) {
      return json({ error: "خطایِ سرور" }, 500);
    }
  },
};
