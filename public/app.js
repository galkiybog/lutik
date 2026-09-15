// Лутик — клиент общей комнаты.
// Состояние комнаты живёт в Durable Object; сюда оно приезжает снимком,
// а дальше догоняется диффами: по вебсокету, а если он отвалился — опросом раз в секунду.

const LIBRARY = [
  { id: "paper", name: "Лист бумаги" },
  { id: "egg", name: "Яйцо" },
  { id: "crane", name: "Журавлик" },
  { id: "chair", name: "Стул" },
];

const BACKGROUNDS = [
  { id: "preset:dusk", name: "Сумерки" },
  { id: "preset:room", name: "Комната" },
  { id: "preset:sea", name: "Море" },
  { id: "preset:forest", name: "Лес" },
];

const PALETTE = ["#e8975a", "#7fb8a4", "#c98fc0", "#8aa8e0", "#e5c35c", "#e2685f", "#9ad17a", "#d99a7e"];

const S = {
  roomId: null,
  seq: 0,
  room: null,
  users: [],
  me: null,
  objects: new Map(), // id -> { data, el }
  ws: null,
  wsOk: false,
  drag: null,
  selected: null,
};

const $ = (sel) => document.querySelector(sel);
const stage = $("#stage");
const objectsLayer = $("#objects");
const modalRoot = $("#modal-root");
const modal = $("#modal");
const fileInput = $("#file-input");

const api = (path, opts) => fetch(`/api/rooms/${S.roomId}${path}`, opts);
const srcUrl = (src) =>
  src.startsWith("lib:") ? `/lib/${src.slice(4)}.svg` : `/api/rooms/${S.roomId}/blobs/${src.slice(5)}`;

function colorFor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending = null;
  return (...args) => {
    pending = args;
    const now = Date.now();
    if (now - last >= ms) {
      last = now;
      fn(...pending);
      pending = null;
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        if (pending) {
          last = Date.now();
          fn(...pending);
          pending = null;
        }
      }, ms - (now - last));
    }
  };
}

// ─────────────────────────── модалки ───────────────────────────

function openModal(html, { dismissible = true } = {}) {
  modal.innerHTML = html;
  modalRoot.hidden = false;
  modalRoot.querySelector(".modal-backdrop").onclick = dismissible ? closeModal : null;
  return modal;
}

function closeModal() {
  modalRoot.hidden = true;
  modal.innerHTML = "";
}

// ─────────────────────────── экран создания ───────────────────────────

function initCreateScreen() {
  const picker = $("#bg-picker");
  let chosen = BACKGROUNDS[0].id;
  let customFile = null;

  function renderPicker() {
    picker.innerHTML = "";
    for (const bg of BACKGROUNDS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bg-swatch";
      btn.dataset.bg = bg.id;
      btn.setAttribute("aria-pressed", String(chosen === bg.id && !customFile));
      btn.innerHTML = `<span class="label">${bg.name}</span>`;
      btn.onclick = () => {
        chosen = bg.id;
        customFile = null;
        renderPicker();
      };
      picker.append(btn);
    }

    const custom = document.createElement("button");
    custom.type = "button";
    custom.className = "bg-swatch custom";
    custom.setAttribute("aria-pressed", String(Boolean(customFile)));
    custom.textContent = customFile ? "Своя ✓" : "Своя картинка";
    if (customFile) custom.style.borderColor = "var(--accent)";
    custom.onclick = () => pickFile().then((file) => {
      if (!file) return;
      customFile = file;
      renderPicker();
    });
    picker.append(custom);
  }

  renderPicker();

  $("#create-btn").onclick = async () => {
    const btn = $("#create-btn");
    const err = $("#create-error");
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = "Создаю…";

    try {
      const name = $("#room-name").value.trim() || "Наша комната";
      const res = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, bg: chosen }),
      });
      if (!res.ok) throw new Error("не удалось создать комнату");
      const { id } = await res.json();

      if (customFile) {
        const blob = await shrinkImage(customFile, 1600);
        const up = await fetch(`/api/rooms/${id}/blobs`, {
          method: "POST",
          headers: { "content-type": blob.type },
          body: blob,
        });
        if (up.ok) {
          const { src } = await up.json();
          await fetch(`/api/rooms/${id}/bg`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ bg: src }),
          });
        }
      }

      history.replaceState(null, "", `/r/${id}`);
      await enterRoom(id, { justCreated: true });
    } catch (e) {
      err.textContent = String(e.message || e);
      err.hidden = false;
      btn.disabled = false;
      btn.textContent = "Создать комнату";
    }
  };
}

// ─────────────────────────── вход в комнату ───────────────────────────

async function enterRoom(roomId, { justCreated = false } = {}) {
  S.roomId = roomId;

  const res = await api("/state");
  if (!res.ok) {
    document.body.innerHTML =
      '<div style="display:grid;place-items:center;height:100%;padding:24px;text-align:center;color:#b9aa9c">' +
      "Такой комнаты нет.<br>Проверь ссылку или создай новую на главной." +
      "</div>";
    return;
  }
  applySnapshot(await res.json());

  $("#screen-create").hidden = true;
  $("#screen-room").hidden = false;

  restoreMe();
  connect();
  setInterval(() => { if (!S.wsOk) pullDiffs(); }, 1000);
  setInterval(() => { if (S.wsOk) pullDiffs(); }, 15000);
  window.addEventListener("resize", layoutAll);

  if (!S.me) openUserPicker({ dismissible: false });
  else if (justCreated) openShare();
}

function applySnapshot(data) {
  S.seq = data.seq;
  S.room = data.room;
  S.users = data.users;

  $("#room-title").textContent = data.room.name;
  applyBackground(data.room.bg);

  for (const { el } of S.objects.values()) el.remove();
  S.objects.clear();
  for (const obj of data.objects) addObjectEl(obj, { animate: false });
}

function applyBackground(bg) {
  S.room.bg = bg;
  if (bg.startsWith("blob:")) {
    stage.dataset.bg = "custom";
    stage.style.backgroundImage = `url("${srcUrl(bg)}")`;
  } else {
    stage.dataset.bg = bg;
    stage.style.backgroundImage = "";
  }
}

// ─────────────────────────── синхронизация ───────────────────────────

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let ws;
  try {
    ws = new WebSocket(`${proto}//${location.host}/api/rooms/${S.roomId}/ws`);
  } catch {
    setTimeout(connect, 2000);
    return;
  }
  S.ws = ws;

  ws.onopen = () => {
    S.wsOk = true;
    $("#conn-badge").hidden = true;
    pullDiffs(); // добираем то, что пропустили пока соединения не было
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "pong") return;
    applyEvent(msg);
  };
  ws.onclose = () => {
    S.wsOk = false;
    $("#conn-badge").hidden = false;
    setTimeout(connect, 1800);
  };
  ws.onerror = () => ws.close();

  clearInterval(connect._ping);
  connect._ping = setInterval(() => {
    if (S.wsOk && ws.readyState === 1) ws.send("ping");
  }, 25000);
}

let pulling = false;
async function pullDiffs() {
  if (pulling) return;
  pulling = true;
  try {
    const res = await api(`/state?since=${S.seq}`);
    if (!res.ok) return;
    const data = await res.json();
    if (data.mode === "snapshot") applySnapshot(data);
    else for (const event of data.events) applyEvent(event);
  } catch {
    // сеть моргнула — попробуем на следующем тике
  } finally {
    pulling = false;
  }
}

function applyEvent(event) {
  if (event.seq <= S.seq) return;
  S.seq = event.seq;
  const p = event.payload;

  switch (event.type) {
    case "user.add":
      if (!S.users.some((u) => u.id === p.id)) S.users.push(p);
      break;

    case "object.add":
      if (!S.objects.has(p.id)) addObjectEl(p, { animate: true });
      break;

    case "object.move": {
      const entry = S.objects.get(p.id);
      if (!entry) break;
      if (S.drag && S.drag.id === p.id) break; // не дёргаем то, что сейчас тащим сами
      Object.assign(entry.data, p);
      layout(entry);
      if (S.selected === p.id) syncSliders();
      break;
    }

    case "object.del": {
      const entry = S.objects.get(p.id);
      if (!entry) break;
      if (S.selected === p.id) deselect();
      entry.el.remove();
      S.objects.delete(p.id);
      break;
    }

    case "room.bg":
      applyBackground(p.bg);
      break;
  }
}

// ─────────────────────────── объекты ───────────────────────────

function baseSize() {
  const r = stage.getBoundingClientRect();
  return Math.min(r.width, r.height) * 0.24;
}

function layout(entry) {
  const { data, el } = entry;
  const size = baseSize();
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.left = `${data.x * 100}%`;
  el.style.top = `${data.y * 100}%`;
  el.style.zIndex = String(data.z);
  el.style.transform =
    `translate(-50%, -100%) rotateX(${data.rx}deg) rotateY(${data.ry}deg) rotateZ(${data.rz}deg) scale(${data.scale})`;
}

function layoutAll() {
  for (const entry of S.objects.values()) layout(entry);
}

function addObjectEl(data, { animate }) {
  const el = document.createElement("div");
  el.className = "obj" + (animate ? " appearing" : "");
  el.dataset.id = data.id;

  const img = document.createElement("img");
  img.src = srcUrl(data.src);
  img.draggable = false;
  img.alt = "";
  el.append(img);

  const entry = { data: { ...data }, el };
  S.objects.set(data.id, entry);
  objectsLayer.append(el);
  layout(entry);
  attachGestures(entry);
  if (animate) setTimeout(() => el.classList.remove("appearing"), 400);
  return entry;
}

const patchObject = throttle((id, patch) => {
  api(`/objects/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => {});
}, 90);

function patchNow(id, patch) {
  return api(`/objects/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  }).catch(() => {});
}

function attachGestures(entry) {
  const { el } = entry;
  const pointers = new Map();
  let moved = 0;
  let startedAt = 0;
  let pinchStart = null;

  el.addEventListener("pointerdown", (e) => {
    if (!S.me) { openUserPicker({ dismissible: false }); return; }
    el.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 1) {
      moved = 0;
      startedAt = Date.now();
      S.drag = { id: entry.data.id, lastX: e.clientX, lastY: e.clientY };
      el.classList.add("dragging");
      // поднимаем наверх, чтобы тащить поверх остальных
      entry.data.z = Math.max(...[...S.objects.values()].map((o) => o.data.z), 0) + 1;
      el.style.zIndex = String(entry.data.z);
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: entry.data.scale };
    }
    e.preventDefault();
  });

  el.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const next = Math.min(3, Math.max(0.2, (pinchStart.scale * dist) / (pinchStart.dist || 1)));
      entry.data.scale = next;
      layout(entry);
      if (S.selected === entry.data.id) syncSliders();
      patchObject(entry.data.id, { scale: next });
      return;
    }

    if (!S.drag || S.drag.id !== entry.data.id) return;
    const rect = stage.getBoundingClientRect();
    const dx = e.clientX - S.drag.lastX;
    const dy = e.clientY - S.drag.lastY;
    S.drag.lastX = e.clientX;
    S.drag.lastY = e.clientY;
    moved += Math.abs(dx) + Math.abs(dy);

    entry.data.x = Math.min(1.2, Math.max(-0.2, entry.data.x + dx / rect.width));
    entry.data.y = Math.min(1.2, Math.max(-0.2, entry.data.y + dy / rect.height));
    layout(entry);
    patchObject(entry.data.id, { x: entry.data.x, y: entry.data.y });
  });

  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size > 0) return;

    el.classList.remove("dragging");
    const wasTap = moved < 8 && Date.now() - startedAt < 400;
    const id = entry.data.id;
    S.drag = null;

    if (wasTap) {
      select(id);
      patchNow(id, { bringToFront: true });
    } else {
      patchNow(id, { x: entry.data.x, y: entry.data.y, scale: entry.data.scale, bringToFront: true });
    }
  };

  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
}

// ─────────────────────────── выделение и панель ───────────────────────────

const panel = $("#selection-panel");

function select(id) {
  deselect();
  const entry = S.objects.get(id);
  if (!entry) return;
  S.selected = id;
  entry.el.classList.add("selected");
  const author = S.users.find((u) => u.id === entry.data.created_by);
  $("#sel-author").textContent = !author
    ? ""
    : author.id === S.me?.id
      ? "твой объект"
      : `положил(а) ${author.name}`;
  syncSliders();
  panel.hidden = false;
}

function deselect() {
  if (S.selected) S.objects.get(S.selected)?.el.classList.remove("selected");
  S.selected = null;
  panel.hidden = true;
}

function syncSliders() {
  const entry = S.objects.get(S.selected);
  if (!entry) return;
  $("#sl-rx").value = entry.data.rx;
  $("#sl-ry").value = entry.data.ry;
  $("#sl-rz").value = entry.data.rz;
  $("#sl-scale").value = entry.data.scale;
}

function wirePanel() {
  const bind = (sel, key) => {
    $(sel).addEventListener("input", (e) => {
      const entry = S.objects.get(S.selected);
      if (!entry) return;
      entry.data[key] = Number(e.target.value);
      layout(entry);
      patchObject(entry.data.id, { [key]: entry.data[key] });
    });
  };
  bind("#sl-rx", "rx");
  bind("#sl-ry", "ry");
  bind("#sl-rz", "rz");
  bind("#sl-scale", "scale");

  $("#sel-close").onclick = deselect;

  $("#sel-reset").onclick = () => {
    const entry = S.objects.get(S.selected);
    if (!entry) return;
    Object.assign(entry.data, { rx: 0, ry: 0, rz: 0 });
    layout(entry);
    syncSliders();
    patchNow(entry.data.id, { rx: 0, ry: 0, rz: 0 });
  };

  $("#sel-delete").onclick = async () => {
    const id = S.selected;
    if (!id) return;
    deselect();
    S.objects.get(id)?.el.remove();
    S.objects.delete(id);
    await api(`/objects/${id}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ by: S.me?.id }),
    }).catch(() => {});
  };

  stage.addEventListener("pointerdown", (e) => {
    if (e.target === stage || e.target === objectsLayer) deselect();
  });
}

// ─────────────────────────── пользователи ───────────────────────────

function meKey() {
  return `lutik:user:${S.roomId}`;
}

function restoreMe() {
  try {
    const saved = JSON.parse(localStorage.getItem(meKey()) || "null");
    if (saved && S.users.some((u) => u.id === saved.id)) {
      S.me = saved;
      renderMe();
    }
  } catch { /* localStorage может быть недоступен — просто спросим имя заново */ }
}

function setMe(user) {
  S.me = user;
  try { localStorage.setItem(meKey(), JSON.stringify(user)); } catch { /* не критично */ }
  renderMe();
}

function renderMe() {
  $("#user-name").textContent = S.me ? S.me.name : "Кто ты?";
  $("#user-dot").style.background = S.me ? S.me.color : "var(--ink-dim)";
}

function openUserPicker({ dismissible = true } = {}) {
  const rows = S.users
    .map(
      (u) => `<button class="user-row" data-id="${u.id}" aria-pressed="${u.id === S.me?.id}">
        <span class="dot" style="background:${u.color}"></span><span>${escapeHtml(u.name)}</span>
      </button>`,
    )
    .join("");

  openModal(
    `<h2>Кто сейчас в комнате?</h2>
     <p class="hint">Без паролей — просто выбери имя. Поменять можно в любой момент.</p>
     <div class="user-list">${rows || '<p class="hint">Пока никого. Ты первый.</p>'}</div>
     <div class="new-user">
       <input type="text" id="new-user-name" maxlength="32" placeholder="Новое имя" autocomplete="off">
       <button id="new-user-btn">Войти</button>
     </div>`,
    { dismissible },
  );

  for (const row of modal.querySelectorAll(".user-row")) {
    row.onclick = () => {
      const user = S.users.find((u) => u.id === row.dataset.id);
      if (user) setMe(user);
      closeModal();
    };
  }

  const input = $("#new-user-name");
  const submit = async () => {
    const name = input.value.trim();
    if (!name) return;
    const res = await api("/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, color: colorFor(name) }),
    });
    if (!res.ok) return;
    const { user } = await res.json();
    if (!S.users.some((u) => u.id === user.id)) S.users.push(user);
    setMe(user);
    closeModal();
  };
  $("#new-user-btn").onclick = submit;
  input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

// ─────────────────────────── добавление объектов ───────────────────────────

function openLibrary() {
  const items = LIBRARY.map(
    (item) => `<button class="lib-item" data-src="lib:${item.id}">
      <img src="/lib/${item.id}.svg" alt=""><span>${item.name}</span>
    </button>`,
  ).join("");

  openModal(
    `<h2>Что положим в комнату?</h2>
     <p class="hint">Или вставь свою картинку — Ctrl/⌘+V прямо в комнате.</p>
     <div class="lib-grid">
       ${items}
       <button class="lib-item custom" id="lib-upload">
         <svg viewBox="0 0 24 24"><path d="M12 4l5 5h-3v6h-4V9H7l5-5zM5 18h14v2H5z"/></svg>
         <span>Своя картинка</span>
       </button>
     </div>`,
  );

  for (const btn of modal.querySelectorAll(".lib-item[data-src]")) {
    btn.onclick = () => {
      closeModal();
      placeObject(btn.dataset.src);
    };
  }
  $("#lib-upload").onclick = async () => {
    const file = await pickFile();
    closeModal();
    if (file) await uploadAndPlace(file);
  };
}

async function placeObject(src) {
  if (!S.me) return openUserPicker({ dismissible: false });
  const jitter = () => 0.5 + (Math.random() - 0.5) * 0.3;
  const res = await api("/objects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ src, x: jitter(), y: jitter(), scale: 1, created_by: S.me.id }),
  });
  if (!res.ok) return;
  const { object } = await res.json();
  if (!S.objects.has(object.id)) addObjectEl(object, { animate: true });
}

async function uploadAndPlace(file) {
  if (!S.me) return openUserPicker({ dismissible: false });
  try {
    const blob = await shrinkImage(file, 900);
    const res = await api("/blobs", {
      method: "POST",
      headers: { "content-type": blob.type },
      body: blob,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(err.error === "too_large" ? "Картинка слишком тяжёлая" : "Не получилось загрузить картинку");
      return;
    }
    const { src } = await res.json();
    await placeObject(src);
  } catch {
    alert("Не получилось прочитать картинку");
  }
}

function pickFile() {
  return new Promise((resolve) => {
    fileInput.value = "";
    fileInput.onchange = () => resolve(fileInput.files[0] || null);
    fileInput.click();
  });
}

// Сжимаем на клиенте: в Durable Object летит уже лёгкий webp, а не фото на 5 МБ.
async function shrinkImage(file, maxSide) {
  const bitmap = await createImageBitmap(file);
  const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * ratio));
  const h = Math.max(1, Math.round(bitmap.height * ratio));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  for (const quality of [0.82, 0.6, 0.4]) {
    const blob = await new Promise((res) => canvas.toBlob(res, "image/webp", quality));
    if (blob && blob.size <= 1_000_000) return blob;
  }
  throw new Error("too_large");
}

// ─────────────────────────── поделиться ───────────────────────────

function openShare() {
  const link = `${location.origin}/r/${S.roomId}`;
  openModal(
    `<h2>Комната готова</h2>
     <p class="hint">Ссылку не подобрать перебором — но у кого она есть, тот внутри. Шли только своим.</p>
     <div class="share-link">${escapeHtml(link)}</div>
     <div class="stack">
       <button class="primary" id="share-copy">Скопировать ссылку</button>
       ${navigator.share ? '<button class="ghost-btn" id="share-native">Поделиться…</button>' : ""}
     </div>`,
  );

  $("#share-copy").onclick = async () => {
    try {
      await navigator.clipboard.writeText(link);
      $("#share-copy").textContent = "Скопировано ✓";
    } catch {
      $("#share-copy").textContent = "Скопируй вручную";
    }
  };
  const native = $("#share-native");
  if (native) native.onclick = () => navigator.share({ title: S.room.name, url: link }).catch(() => {});
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ─────────────────────────── старт ───────────────────────────

function boot() {
  wirePanel();
  $("#add-btn").onclick = () => (S.me ? openLibrary() : openUserPicker({ dismissible: false }));
  $("#user-btn").onclick = () => openUserPicker();
  $("#share-btn").onclick = openShare;

  document.addEventListener("paste", (e) => {
    if ($("#screen-room").hidden || !modalRoot.hidden) return;
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (file) uploadAndPlace(file);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (!modalRoot.hidden) closeModal(); else deselect(); }
  });

  const match = location.pathname.match(/^\/r\/([A-Za-z0-9]{6,40})$/);
  if (match) enterRoom(match[1]);
  else initCreateScreen();
}

boot();
