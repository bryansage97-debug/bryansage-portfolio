// Shared Flag Game leaderboard — Cloudflare Pages Function
// Route: /api/leaderboard
// Needs a KV namespace bound to this Pages project with the variable name LEADERBOARD

const MAX_ENTRIES = 10;
const MAX_SCORE = 500;
const MODES = ['easy', 'hard'];

// ── PROFANITY FILTER ──
// Blocked if any of these appear anywhere in the name
const BLOCK_ANYWHERE = [
  'FUCK', 'FUK', 'FCK', 'SHIT', 'CUNT', 'COCK', 'DICK', 'PUSSY', 'PUSSI', 'WHORE',
  'SLUT', 'BITCH', 'BTCH', 'NIGG', 'NIGA', 'NIGR', 'NIBBA', 'FAGG', 'FAGOT',
  'RETARD', 'TWAT', 'WANK', 'JIZ', 'KIKE', 'CHINK', 'DILDO', 'PENIS', 'VAGIN',
  'BOOB', 'TITTY', 'TITS', 'PORN', 'NAZI', 'HITLER', 'KKK', 'RAPIST', 'ASSHOL',
  'ASSHAT', 'CUMSHO', 'SPERM', 'HENTAI', 'PISS', 'DYKE', 'TRANNY', 'SPICK', 'WETBAC',
];
// Blocked only when they are the whole name (avoids catching CLASS, GRAPE, CANAL, etc.)
const BLOCK_EXACT = [
  'ASS', 'ASSES', 'ARSE', 'TIT', 'CUM', 'CUMS', 'FAG', 'FAGS', 'HO', 'HOE', 'HOES',
  'SPIC', 'RAPE', 'RAPED', 'NIG', 'JAP', 'SEX', 'SEXY', 'ANAL', 'ANUS', 'PUTA', 'PUTO',
  'COON', 'GOOK', 'DAGO', 'PAKI', 'WOP',
];

const LEET_I = { '0': 'O', '1': 'I', '2': 'Z', '3': 'E', '4': 'A', '5': 'S', '6': 'G', '7': 'T', '8': 'B', '9': 'G' };
const LEET_L = { ...LEET_I, '1': 'L' };

function variants(name) {
  const plain = name.replace(/[^A-Z0-9]/g, '');
  const v = [
    plain,
    plain.replace(/[0-9]/g, d => LEET_I[d]),
    plain.replace(/[0-9]/g, d => LEET_L[d]),
    plain.replace(/[^A-Z]/g, ''),
  ];
  // also catch stretched spellings like FUUUCK
  v.push(...v.map(s => s.replace(/(.)\1+/g, '$1')));
  return [...new Set(v)].filter(Boolean);
}

function isAllowed(name) {
  return variants(name).every(v =>
    !BLOCK_EXACT.includes(v) && !BLOCK_ANYWHERE.some(word => v.includes(word))
  );
}

// ── HELPERS ──
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function readBoards(kv) {
  const [easy, hard] = await Promise.all(MODES.map(m => kv.get(m, 'json')));
  return { easy: easy || [], hard: hard || [] };
}

// ── GET: read both boards ──
export async function onRequestGet({ env }) {
  if (!env.LEADERBOARD) return json({ error: 'not configured' }, 503);
  return json(await readBoards(env.LEADERBOARD));
}

// ── POST: save a score ──
export async function onRequestPost({ request, env }) {
  if (!env.LEADERBOARD) return json({ error: 'not configured' }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad request' }, 400); }

  const mode = MODES.includes(body.mode) ? body.mode : null;
  const name = String(body.name || '').toUpperCase().trim().replace(/\s+/g, ' ');
  const score = Number(body.score);

  if (!mode) return json({ error: 'bad request' }, 400);
  if (!/^[A-Z0-9 ]{1,6}$/.test(name)) return json({ error: 'name' }, 422);
  if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) return json({ error: 'score' }, 422);
  if (!isAllowed(name)) return json({ error: 'name' }, 422);

  const board = (await env.LEADERBOARD.get(mode, 'json')) || [];
  board.push({ name, score, t: Date.now() });
  board.sort((a, b) => b.score - a.score || a.t - b.t);
  await env.LEADERBOARD.put(mode, JSON.stringify(board.slice(0, MAX_ENTRIES)));

  return json({ ok: true, name, boards: await readBoards(env.LEADERBOARD) });
}
