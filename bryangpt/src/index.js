// ─────────────────────────────────────────────────────────────
// BryanGPT — a chat that looks like an LLM but is really Bryan.
//
//   Visitor writes on bryansage.org  →  stored in their own private
//   thread  →  emailed to Bryan  →  Bryan hits Reply in Gmail  →
//   the reply lands back in that visitor's chat.
//
// Privacy: each browser makes a random 256-bit token (kept in its
// local storage). Only a one-way hash of it is used server-side, so
// a chat can only be read by the browser that started it.
// ─────────────────────────────────────────────────────────────
import { DurableObject } from "cloudflare:workers";
import { EmailMessage } from "cloudflare:email";

const MAX_LEN = 2000;            // longest visitor message
const MAX_REPLY_LEN = 8000;      // longest reply from Bryan
const KEEP = 300;                // messages returned to the browser
const DEBOUNCE_MS = 30_000;      // wait for follow-up messages before emailing…
const MAX_WAIT_MS = 120_000;     // …but never longer than this
const TZ = "America/New_York";

const LIMITS = {
  threadBurst: { max: 12, ms: 10 * 60_000 },   // per chat, per 10 minutes
  threadDay:   { max: 80, ms: 24 * 3_600_000 },// per chat, per day
  ipHour: 40,                                  // per visitor IP, per hour
  globalDay: 1500,                             // whole site, per day
};

// ── helpers ──────────────────────────────────────────────────
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const ok = origin && (env.DEV_ANY_ORIGIN === "1" || allowed.includes(origin));
  const h = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (ok) h["Access-Control-Allow-Origin"] = origin;
  return { headers: h, ok };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
  });
}

async function threadKeyFrom(request) {
  const m = (request.headers.get("Authorization") || "").match(/^Bearer ([a-f0-9]{64})$/);
  return m ? (await sha("bryangpt:" + m[1])).slice(0, 24) : null;
}

const fmtTime = (t) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .format(new Date(t));

// ── outgoing email (plain text, UTF-8, threaded in Gmail) ─────
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...enc.encode(s)))}?=`;
}
function b64Lines(s) {
  const bytes = enc.encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

async function sendNotification(env, { key, n, pending, earlier }) {
  const from = env.FROM_EMAIL;
  const [local, domain] = from.split("@");
  const replyTo = `${local}+${key}@${domain}`;
  const short = key.slice(0, 6).toUpperCase();
  const root = `<bryangpt.${key}.1@${domain}>`;
  const messageId = n === 1 ? root : `<bryangpt.${key}.${n}.${Date.now()}@${domain}>`;

  const lines = [];
  lines.push(`New message${pending.length > 1 ? "s" : ""} on BryanGPT · chat ${short}`, "");
  for (const m of pending) lines.push(`${fmtTime(m.at)}`, m.text, "");
  lines.push("Just hit Reply. Whatever you write above the quoted text goes straight into their chat.");
  if (earlier.length) {
    lines.push("", "— Earlier in this chat —");
    for (const m of earlier) {
      const who = m.role === "bryan" ? "You" : "Them";
      const t = m.text.length > 300 ? m.text.slice(0, 300) + "…" : m.text;
      lines.push(`${who} (${fmtTime(m.at)}): ${t}`);
    }
  }

  const headers = [
    `From: "BryanGPT" <${from}>`,
    `To: <${env.OWNER_EMAIL}>`,
    `Reply-To: <${replyTo}>`,
    `Subject: ${encodeHeader(`BryanGPT · chat ${short}`)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(n === 1 ? [] : [`In-Reply-To: ${root}`, `References: ${root}`]),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const raw = headers.join("\r\n") + "\r\n\r\n" + b64Lines(lines.join("\n")) + "\r\n";
  await env.EMAIL.send(new EmailMessage(from, env.OWNER_EMAIL, raw));
}

// ── incoming email (Bryan's Gmail reply) ──────────────────────
function latin1(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return s;
}
function splitHead(s) {
  const m = s.match(/\r?\n\r?\n/);
  return m ? [s.slice(0, m.index), s.slice(m.index + m[0].length)] : [s, ""];
}
function parseHeaders(h) {
  const out = {};
  for (const line of h.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) {
      const k = line.slice(0, i).trim().toLowerCase();
      if (!(k in out)) out[k] = line.slice(i + 1).trim();
    }
  }
  return out;
}
function param(v, name) {
  const m = (v || "").match(new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
  return m ? (m[1] ?? m[2]) : null;
}
function decodeBody(body, cte, charset) {
  cte = (cte || "").toLowerCase();
  let bytes;
  if (cte === "base64") {
    const bin = atob(body.replace(/[^A-Za-z0-9+/=]/g, ""));
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } else if (cte === "quoted-printable") {
    const s = body.replace(/=\r?\n/g, "");
    const arr = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { arr.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
      else arr.push(s.charCodeAt(i) & 0xff);
    }
    bytes = new Uint8Array(arr);
  } else {
    bytes = Uint8Array.from(body, (c) => c.charCodeAt(0) & 0xff);
  }
  try { return new TextDecoder(charset || "utf-8").decode(bytes); }
  catch { return new TextDecoder("utf-8").decode(bytes); }
}
function walk(s, out, depth = 0) {
  const [h, body] = splitHead(s);
  const hd = parseHeaders(h);
  const ctRaw = hd["content-type"] || "text/plain";
  const ct = ctRaw.toLowerCase();
  if (ct.startsWith("multipart/") && depth < 8) {
    const b = param(ctRaw, "boundary");
    if (!b) return;
    const segs = body.split("--" + b);
    segs.shift();
    for (const seg of segs) {
      if (seg.startsWith("--")) break;
      walk(seg.replace(/^[ \t]*\r?\n/, ""), out, depth + 1);
    }
    return;
  }
  if ((hd["content-disposition"] || "").toLowerCase().startsWith("attachment")) return;
  const text = () => decodeBody(body, hd["content-transfer-encoding"], param(ctRaw, "charset"));
  if (ct.startsWith("text/plain") && out.plain == null) out.plain = text();
  else if (ct.startsWith("text/html") && out.html == null) out.html = text();
}
function htmlToText(html) {
  const q = html.search(/<div[^>]*class=["']?[^"'>]*gmail_quote|<blockquote/i);
  if (q >= 0) html = html.slice(0, q);
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}
// Keep only what Bryan typed: drop the quoted email, signatures and "Sent from my iPhone".
export function cleanReply(t) {
  const L = t.replace(/\r\n?/g, "\n").replace(/ /g, " ").split("\n");
  let cut = L.length;
  for (let i = 0; i < L.length; i++) {
    const l = L[i].trim();
    // Gmail's "On <date> … wrote:" line, which it sometimes wraps over 2–3 lines
    const attribution = [1, 2, 3].some((n) => /\bwrote:\s*$/.test(L.slice(i, i + n).join(" ").trim()));
    if (/^>/.test(l) ||
        (/^On\b/.test(l) && /\d/.test(l) && attribution) ||
        /^-{2,}\s*Original Message\s*-{2,}/i.test(l) ||
        /^_{8,}$/.test(l) ||
        (/^From:\s/i.test(l) && L.slice(i + 1, i + 4).some((x) => /^(Sent|Date|To):\s/i.test(x.trim())))) {
      cut = i;
      break;
    }
  }
  let keep = L.slice(0, cut);
  const sig = keep.findIndex((x) => x === "-- " || x === "--");
  if (sig >= 0) keep = keep.slice(0, sig);
  return keep.join("\n")
    .replace(/\n\s*Sent from my [\w ]+\s*$/i, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function extractReply(rawBytes) {
  const out = {};
  walk(latin1(rawBytes), out);
  const text = out.plain != null ? out.plain : out.html != null ? htmlToText(out.html) : "";
  return cleanReply(text);
}

// ── one private chat ─────────────────────────────────────────
export class Thread extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL, text TEXT NOT NULL, at INTEGER NOT NULL,
      emailed INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`);
  }
  meta(k) {
    const r = this.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray()[0];
    return r ? r.v : null;
  }
  setMeta(k, v) {
    this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, String(v));
  }
  count(since) {
    return this.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND at > ?", since).one().n;
  }

  list() {
    const rows = this.sql.exec("SELECT seq, role, text, at FROM messages ORDER BY seq DESC LIMIT ?", KEEP).toArray().reverse();
    return { messages: rows, awaiting: rows.length > 0 && rows[rows.length - 1].role === "user" };
  }

  async addUser(key, text, now) {
    if (this.count(now - LIMITS.threadBurst.ms) >= LIMITS.threadBurst.max) return { error: "slow_down" };
    if (this.count(now - LIMITS.threadDay.ms) >= LIMITS.threadDay.max) return { error: "daily_limit" };
    if (!this.meta("key")) { this.setMeta("key", key); this.setMeta("created", now); }
    this.sql.exec("INSERT INTO messages (role, text, at) VALUES ('user', ?, ?)", text, now);
    const message = this.sql.exec("SELECT seq, role, text, at FROM messages WHERE seq = last_insert_rowid()").one();
    let first = Number(this.meta("pendingSince") || 0);
    if (!first) { first = now; this.setMeta("pendingSince", now); }
    await this.ctx.storage.setAlarm(Math.min(now + DEBOUNCE_MS, first + MAX_WAIT_MS));
    return { message };
  }

  addReply(text, now) {
    const has = this.sql.exec("SELECT COUNT(*) AS n FROM messages").one().n;
    if (!has) return false;
    this.sql.exec("INSERT INTO messages (role, text, at, emailed) VALUES ('bryan', ?, ?, 1)", text, now);
    return true;
  }

  async alarm() {
    const key = this.meta("key");
    const pending = this.sql.exec("SELECT seq, text, at FROM messages WHERE role = 'user' AND emailed = 0 ORDER BY seq").toArray();
    if (!key || !pending.length) { this.setMeta("pendingSince", 0); return; }
    const earlier = this.sql
      .exec("SELECT role, text, at FROM messages WHERE seq < ? ORDER BY seq DESC LIMIT 6", pending[0].seq)
      .toArray().reverse();
    const n = Number(this.meta("emails") || 0) + 1;
    await sendNotification(this.env, { key, n, pending, earlier }); // throws → Cloudflare retries the alarm
    this.sql.exec("UPDATE messages SET emailed = 1 WHERE role = 'user' AND seq <= ?", pending[pending.length - 1].seq);
    this.setMeta("emails", n);
    const left = this.sql.exec("SELECT COUNT(*) AS n FROM messages WHERE role = 'user' AND emailed = 0").one().n;
    if (!left) this.setMeta("pendingSince", 0);
  }
}

// ── site-wide spam guard (per IP per hour, whole site per day) ──
export class Limits extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS hits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)");
  }
  hit(checks, now) {
    this.sql.exec("DELETE FROM hits WHERE exp < ?", now);
    for (const c of checks) {
      const r = this.sql.exec("SELECT n FROM hits WHERE k = ?", c.k).toArray()[0];
      if (r && r.n >= c.max) return false;
    }
    for (const c of checks) {
      this.sql.exec("INSERT INTO hits (k, n, exp) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1", c.k, now + c.ttl);
    }
    return true;
  }
}

// ── HTTP + email entry points ────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { headers: cors, ok: originOk } = corsHeaders(request.headers.get("Origin"), env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const path = url.pathname.replace(/\/+$/, "");

    try {
      if (path === "" && request.method === "GET") {
        return new Response("BryanGPT is running.", { headers: { "Content-Type": "text/plain" } });
      }
      if (!originOk) return json({ error: "origin" }, 403, cors);

      const key = await threadKeyFrom(request);
      if (!key) return json({ error: "token" }, 401, cors);
      const thread = env.THREADS.get(env.THREADS.idFromName(key));

      if (path === "/thread" && request.method === "GET") {
        return json(await thread.list(), 200, cors);
      }

      if (path === "/message" && request.method === "POST") {
        let body;
        try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400, cors); }
        const text = String(body?.text ?? "").replace(/\r\n?/g, "\n").trim();
        if (!text) return json({ error: "empty" }, 400, cors);
        if (text.length > MAX_LEN) return json({ error: "too_long" }, 413, cors);

        const now = Date.now();
        const ip = await sha("ip:" + (request.headers.get("CF-Connecting-IP") || "unknown"));
        const hour = Math.floor(now / 3_600_000), day = Math.floor(now / 86_400_000);
        const limits = env.LIMITS.get(env.LIMITS.idFromName("site"));
        const allowed = await limits.hit([
          { k: `ip:${ip.slice(0, 20)}:${hour}`, max: LIMITS.ipHour, ttl: 2 * 3_600_000 },
          { k: `site:${day}`, max: LIMITS.globalDay, ttl: 2 * 86_400_000 },
        ], now);
        if (!allowed) return json({ error: "slow_down" }, 429, cors);

        const res = await thread.addUser(key, text, now);
        if (res.error) return json(res, 429, cors);
        return json(res, 200, cors);
      }

      return json({ error: "not_found" }, 404, cors);
    } catch (err) {
      console.error(err);
      return json({ error: "server" }, 500, cors);
    }
  },

  async email(message, env) {
    const to = String(message.to || "").toLowerCase();
    const from = String(message.from || "").toLowerCase();
    const m = to.match(/^[^+@]+\+([a-f0-9]{24})@/);

    // Plain mail to bryangpt@ (no chat id) just goes on to Bryan's inbox.
    if (!m) { await message.forward(env.OWNER_EMAIL); return; }

    // Only Bryan can answer chats.
    if (from !== String(env.OWNER_EMAIL).toLowerCase()) {
      message.setReject("This address only accepts replies from the site owner.");
      return;
    }

    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    const reply = extractReply(raw);
    if (!reply) return;
    const thread = env.THREADS.get(env.THREADS.idFromName(m[1]));
    const ok = await thread.addReply(reply.slice(0, MAX_REPLY_LEN), Date.now());
    if (!ok) console.log("Reply for unknown chat", m[1]);
  },
};
