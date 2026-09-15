// Lutik — общая комната.
// Один Worker: раздаёт статику и проксирует /api/* в Durable Object комнаты.
// Одна комната = один Durable Object с SQLite внутри.

import { DurableObject } from "cloudflare:workers";

const ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // без похожих символов
const ROOM_ID_LEN = 22; // ~128 бит энтропии — подобрать перебором нереально
const MAX_BLOB = 1_100_000; // ~1 МБ: клиент жмёт картинки заранее
const MAX_OBJECTS = 300;
const MAX_EVENTS = 4000; // журнал подрезаем, чтобы комната не росла вечно

function randomId(len = ROOM_ID_LEN) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clean(str, max) {
  return String(str ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    // POST /api/rooms — создать комнату
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "bad_json" }, 400);
      }
      const id = randomId();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
      const res = await stub.fetch("https://room/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name: clean(body.name, 60), bg: clean(body.bg, 200) }),
      });
      if (!res.ok) return res;
      return json({ id });
    }

    // /api/rooms/:id/<путь> — всё остальное живёт внутри Durable Object
    const match = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]{6,40})(\/.*)?$/);
    if (!match) return json({ error: "not_found" }, 404);

    const roomId = match[1];
    const rest = match[2] || "/";
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
    const inner = new URL("https://room" + rest);
    inner.search = url.search;
    return stub.fetch(new Request(inner, request));
  },
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS objects (
        id TEXT PRIMARY KEY,
        src TEXT NOT NULL,
        x REAL NOT NULL, y REAL NOT NULL,
        scale REAL NOT NULL DEFAULT 1,
        rx REAL NOT NULL DEFAULT 0, ry REAL NOT NULL DEFAULT 0, rz REAL NOT NULL DEFAULT 0,
        z INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL, payload TEXT NOT NULL, at INTEGER NOT NULL
      );
    `);
  }

  // ---------- вспомогательное ----------

  getMeta(key) {
    const row = this.sql.exec("SELECT v FROM meta WHERE k = ?", key).toArray()[0];
    return row ? row.v : null;
  }

  setMeta(key, value) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key, value);
  }

  exists() {
    return this.getMeta("created_at") !== null;
  }

  // Записать событие в журнал и разослать всем открытым вебсокетам.
  emit(type, payload) {
    const at = Date.now();
    this.sql.exec("INSERT INTO events (type, payload, at) VALUES (?, ?, ?)", type, JSON.stringify(payload), at);
    const seq = Number(this.sql.exec("SELECT last_insert_rowid() AS s").one().s);
    const message = JSON.stringify({ seq, type, payload, at });

    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // сокет уже мёртв — переживём, клиент переподключится и добёрет диффы
      }
    }

    // подрезаем хвост журнала
    const count = Number(this.sql.exec("SELECT COUNT(*) AS c FROM events").one().c);
    if (count > MAX_EVENTS) {
      this.sql.exec(
        "DELETE FROM events WHERE seq <= (SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ?)",
        MAX_EVENTS,
      );
    }
    return seq;
  }

  headSeq() {
    const row = this.sql.exec("SELECT COALESCE(MAX(seq), 0) AS s FROM events").one();
    return Number(row.s);
  }

  minSeq() {
    const row = this.sql.exec("SELECT COALESCE(MIN(seq), 0) AS s FROM events").one();
    return Number(row.s);
  }

  snapshot() {
    return {
      seq: this.headSeq(),
      room: { name: this.getMeta("name") || "Комната", bg: this.getMeta("bg") || "preset:dusk" },
      users: this.sql.exec("SELECT id, name, color FROM users ORDER BY created_at").toArray(),
      objects: this.sql
        .exec("SELECT id, src, x, y, scale, rx, ry, rz, z, created_by FROM objects ORDER BY z, created_at")
        .toArray(),
    };
  }

  // ---------- маршрутизация ----------

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === "/create" && method === "POST") return this.handleCreate(request);

    if (!this.exists()) return json({ error: "room_not_found" }, 404);

    if (path === "/ws") return this.handleSocket(request);
    if (path === "/state" && method === "GET") return this.handleState(url);
    if (path === "/users" && method === "POST") return this.handleAddUser(request);
    if (path === "/objects" && method === "POST") return this.handleAddObject(request);
    if (path === "/blobs" && method === "POST") return this.handleUploadBlob(request);
    if (path === "/bg" && method === "POST") return this.handleSetBg(request);

    const objMatch = path.match(/^\/objects\/([A-Za-z0-9]{1,40})$/);
    if (objMatch && method === "PATCH") return this.handlePatchObject(objMatch[1], request);
    if (objMatch && method === "DELETE") return this.handleDeleteObject(objMatch[1], request);

    const blobMatch = path.match(/^\/blobs\/([A-Za-z0-9]{1,40})$/);
    if (blobMatch && method === "GET") return this.handleGetBlob(blobMatch[1]);

    return json({ error: "not_found" }, 404);
  }

  async handleCreate(request) {
    if (this.exists()) return json({ error: "already_exists" }, 409);
    const body = await request.json();
    this.setMeta("id", body.id);
    this.setMeta("name", body.name || "Комната");
    this.setMeta("bg", body.bg || "preset:dusk");
    this.setMeta("created_at", String(Date.now()));
    return json({ ok: true });
  }

  handleState(url) {
    const sinceRaw = url.searchParams.get("since");

    // Клиент просит только диффы и они ещё в журнале — отдаём их.
    if (sinceRaw !== null) {
      const since = Number(sinceRaw);
      if (Number.isFinite(since) && since >= 0 && (since >= this.minSeq() - 1 || this.headSeq() === 0)) {
        const events = this.sql
          .exec("SELECT seq, type, payload, at FROM events WHERE seq > ? ORDER BY seq", since)
          .toArray()
          .map((e) => ({ seq: Number(e.seq), type: e.type, payload: JSON.parse(e.payload), at: Number(e.at) }));
        return json({ mode: "diff", seq: this.headSeq(), events });
      }
      // отстал слишком сильно — отдаём полный снимок
    }

    return json({ mode: "snapshot", ...this.snapshot() });
  }

  handleSocket(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(ws, message) {
    // Пока клиенты только слушают. Пинг держит соединение живым.
    if (message === "ping") ws.send(JSON.stringify({ type: "pong", seq: this.headSeq() }));
  }

  async handleAddUser(request) {
    const body = await request.json().catch(() => ({}));
    const name = clean(body.name, 32);
    if (!name) return json({ error: "empty_name" }, 400);

    const existing = this.sql.exec("SELECT id, name, color FROM users WHERE name = ?", name).toArray()[0];
    if (existing) return json({ user: existing, existed: true });

    if (Number(this.sql.exec("SELECT COUNT(*) AS c FROM users").one().c) >= 100) {
      return json({ error: "too_many_users" }, 409);
    }

    const user = { id: randomId(10), name, color: clean(body.color, 16) || "#e8975a" };
    this.sql.exec(
      "INSERT INTO users (id, name, color, created_at) VALUES (?, ?, ?, ?)",
      user.id, user.name, user.color, Date.now(),
    );
    this.emit("user.add", user);
    return json({ user, existed: false });
  }

  async handleAddObject(request) {
    const body = await request.json().catch(() => ({}));
    const src = clean(body.src, 80);
    if (!/^(lib:[a-z-]{1,24}|blob:[A-Za-z0-9]{1,40})$/.test(src)) return json({ error: "bad_src" }, 400);
    if (Number(this.sql.exec("SELECT COUNT(*) AS c FROM objects").one().c) >= MAX_OBJECTS) {
      return json({ error: "room_full" }, 409);
    }

    const zRow = this.sql.exec("SELECT COALESCE(MAX(z), 0) AS z FROM objects").one();
    const obj = {
      id: randomId(12),
      src,
      x: Number(body.x) || 0.5,
      y: Number(body.y) || 0.5,
      scale: Math.min(3, Math.max(0.2, Number(body.scale) || 1)),
      rx: 0, ry: 0, rz: 0,
      z: Number(zRow.z) + 1,
      created_by: clean(body.created_by, 16),
    };
    this.sql.exec(
      "INSERT INTO objects (id, src, x, y, scale, rx, ry, rz, z, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      obj.id, obj.src, obj.x, obj.y, obj.scale, obj.rx, obj.ry, obj.rz, obj.z, obj.created_by, Date.now(),
    );
    this.emit("object.add", obj);
    return json({ object: obj });
  }

  async handlePatchObject(id, request) {
    const body = await request.json().catch(() => ({}));
    const current = this.sql.exec("SELECT * FROM objects WHERE id = ?", id).toArray()[0];
    if (!current) return json({ error: "no_object" }, 404);

    const limits = {
      x: [-0.5, 1.5], y: [-0.5, 1.5], scale: [0.2, 3],
      rx: [-180, 180], ry: [-180, 180], rz: [-180, 180],
    };
    const patch = {};
    for (const [key, [lo, hi]] of Object.entries(limits)) {
      if (body[key] === undefined) continue;
      const value = Number(body[key]);
      if (!Number.isFinite(value)) continue;
      patch[key] = Math.min(hi, Math.max(lo, value));
    }
    if (body.bringToFront) {
      patch.z = Number(this.sql.exec("SELECT COALESCE(MAX(z), 0) AS z FROM objects").one().z) + 1;
    }
    if (!Object.keys(patch).length) return json({ ok: true, noop: true });

    const setClause = Object.keys(patch).map((k) => `${k} = ?`).join(", ");
    this.sql.exec(`UPDATE objects SET ${setClause} WHERE id = ?`, ...Object.values(patch), id);
    this.emit("object.move", { id, ...patch });
    return json({ ok: true });
  }

  async handleDeleteObject(id, request) {
    const body = await request.json().catch(() => ({}));
    const row = this.sql.exec("SELECT src FROM objects WHERE id = ?", id).toArray()[0];
    if (!row) return json({ error: "no_object" }, 404);

    this.sql.exec("DELETE FROM objects WHERE id = ?", id);

    // Если это была своя картинка и её больше никто не использует — чистим блоб.
    if (row.src.startsWith("blob:")) {
      const blobId = row.src.slice(5);
      const stillUsed = Number(
        this.sql.exec("SELECT COUNT(*) AS c FROM objects WHERE src = ?", row.src).one().c,
      );
      if (!stillUsed) this.sql.exec("DELETE FROM blobs WHERE id = ?", blobId);
    }

    this.emit("object.del", { id, by: clean(body.by, 16) });
    return json({ ok: true });
  }

  async handleSetBg(request) {
    const body = await request.json().catch(() => ({}));
    const bg = clean(body.bg, 200);
    if (!/^(preset:[a-z-]{1,24}|blob:[A-Za-z0-9]{1,40})$/.test(bg)) return json({ error: "bad_bg" }, 400);
    this.setMeta("bg", bg);
    this.emit("room.bg", { bg });
    return json({ ok: true });
  }

  async handleUploadBlob(request) {
    const mime = request.headers.get("content-type") || "image/webp";
    if (!/^image\/(webp|png|jpeg|gif|svg\+xml)$/.test(mime)) return json({ error: "bad_type" }, 415);

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) return json({ error: "empty" }, 400);
    if (bytes.length > MAX_BLOB) return json({ error: "too_large", max: MAX_BLOB }, 413);

    const id = randomId(14);
    this.sql.exec("INSERT INTO blobs (id, mime, data) VALUES (?, ?, ?)", id, mime, bytes);
    return json({ id, src: `blob:${id}` });
  }

  handleGetBlob(id) {
    const row = this.sql.exec("SELECT mime, data FROM blobs WHERE id = ?", id).toArray()[0];
    if (!row) return new Response("not found", { status: 404 });
    return new Response(row.data, {
      headers: {
        "content-type": row.mime,
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  }
}
