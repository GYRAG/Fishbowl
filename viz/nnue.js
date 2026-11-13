// Stockfish 19 NNUE forward pass in plain JS, ported from Stockfish's src/nnue.
// The engine only prints the final number; this recomputes it from the same weights so every
// neuron along the way can be shown. Runs in the browser (net-worker.js) and in Node, where
// `npm run check` compares it with the engine's own evaluation.
(function () {
'use strict';
const NET_NAME = 'nn-1a298aa575a0.nnue';      // the network compiled into the Stockfish 19 build we load

const L1 = 1024, HALF = 512, L2 = 32, L3 = 32, STACKS = 8;
const PSQ_DIMS = 22528, THREAT_DIMS = 59808, PAIR_DIMS = 4560;

// ---------- net file ----------
// The browser engine carries the network inside its .wasm, so instead of downloading it a second
// time it is rebuilt from the wasm's data segments. The compiler leaves runs of zero bytes out of
// those segments (memory starts zeroed), so they are laid back out at their addresses.
function netFromWasm(w) {
  let p = 8;
  const leb = () => { let r = 0, s = 0, b; do { b = w[p++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; };
  const segs = [];
  while (p < w.length) {
    const id = w[p++], end = leb() + p;
    if (id === 11) for (let n = leb(); n--;) {     // data section
      const flags = leb();
      if (flags === 1) { p += leb(); continue; }    // passive segment: not placed in memory
      if (flags === 2) leb();                       // memory index
      if (w[p++] !== 0x41) throw new Error('data segment offset is not a constant');
      const off = leb();
      if (w[p++] !== 0x0b) throw new Error('data segment offset is not closed');
      const len = leb(); segs.push([off, p, len]); p += len;
    }
    p = end;
  }
  let start = -1;                                   // the net begins with its version, 0x6A448AFA
  for (const [off, at, len] of segs) {
    for (let i = 0; i + 4 <= len && start < 0; i++)
      if (w[at + i] === 0xfa && w[at + i + 1] === 0x8a && w[at + i + 2] === 0x44 && w[at + i + 3] === 0x6a) start = off + i;
    if (start >= 0) break;
  }
  if (start < 0) throw new Error('no network found in the engine');
  const mem = new Uint8Array(Math.max(...segs.map(([off, , len]) => off + len)) - start);
  for (const [off, at, len] of segs) if (off + len > start) {
    const from = Math.max(off, start);
    mem.set(w.subarray(at + from - off, at + len), from - start);
  }
  return mem;                                       // the net, then whatever data followed it
}

function parseNet(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 0;
  const u32 = () => (p += 4, dv.getUint32(p - 4, true));
  const leb = (n, Arr) => {
    if (String.fromCharCode(...buf.subarray(p, p + 17)) !== 'COMPRESSED_LEB128') throw new Error('LEB128 magic missing at ' + p);
    const end = p + 21 + dv.getUint32(p + 17, true);
    p += 21;
    const out = new Arr(n);
    for (let i = 0; i < n; i++) {
      let r = 0, s = 0, b;
      do { b = buf[p++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80);
      out[i] = s < 32 && (b & 0x40) ? r | (-1 << s) : r;
    }
    if (p !== end) throw new Error('LEB128 block length mismatch');
    return out;
  };
  const i8 = n => (p += n, new Int8Array(buf.buffer, buf.byteOffset + p - n, n));
  const i32 = n => { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = dv.getInt32(p + 4 * i, true); p += 4 * n; return a; };

  if (u32() !== 0x6A448AFA) throw new Error('unexpected net version');
  u32(); const desc = u32(); p += desc; // net hash, description
  u32();                                // feature transformer hash
  const net = { biases: leb(L1, Int16Array) };
  net.threatW = i8(THREAT_DIMS * L1);   net.threatPsqt = leb(THREAT_DIMS * 8, Int32Array);
  net.pairW = i8(PAIR_DIMS * L1);       net.pairPsqt = leb(PAIR_DIMS * 8, Int32Array);
  net.psqW = leb(PSQ_DIMS * L1, Int16Array); net.psqPsqt = leb(PSQ_DIMS * 8, Int32Array);
  net.stacks = [];
  for (let s = 0; s < STACKS; s++) {
    u32();
    net.stacks.push({ b0: i32(L2), w0: i8(L2 * L1), b1: i32(L3), w1: i8(L3 * L2 * 2), b2: i32(1), w2: i8(L2 * 2 + L3 * 2) });
  }
  if (p > buf.length) throw new Error('network is cut short');
  return net;
}

// ---------- board ----------
// sq = rank*8 + file (a1 = 0). piece = type | colour<<3, type 1..6 = P N B R Q K, colour 0 = white.
const SYM = ' PNBRQK  pnbrqk';
function parseFen(fen) {
  const [rows, stm] = fen.split(' ');
  const board = new Array(64).fill(0);
  rows.split('/').forEach((row, r) => {
    let f = 0;
    for (const ch of row) /\d/.test(ch) ? (f += +ch) : (board[(7 - r) * 8 + f++] = SYM.indexOf(ch));
  });
  return { board, stm: stm === 'b' ? 1 : 0 };
}
// Stockfish does not validate FENs (a bad one can crash it), so user input goes through here first.
function cleanFen(fen) {
  const [rows = '', stm = 'w', castle = '-', ep = '-'] = String(fen).trim().split(/\s+/);
  const ranks = rows.split('/');
  if (ranks.length !== 8 || !/^[wb]$/.test(stm) || /[pP]/.test(ranks[0] + ranks[7])) return null;
  for (const r of ranks)
    if (!/^[pnbrqkPNBRQK1-8]+$/.test(r) || [...r].reduce((n, ch) => n + (+ch || 1), 0) !== 8) return null;
  if (rows.split('K').length !== 2 || rows.split('k').length !== 2) return null;
  const b = parseFen(rows + ' w').board, mover = stm === 'b' ? 1 : 0, theirKing = b.indexOf(6 | (mover ^ 1) << 3);
  for (let s = 0; s < 64; s++) // the side that just moved must not have left its king en prise
    if (b[s] && b[s] >> 3 === mover && attacks(kindOf(b[s]), s, b).includes(theirKing)) return null;
  const rights = [['K', 4, 7, 0], ['Q', 4, 0, 0], ['k', 60, 63, 8], ['q', 60, 56, 8]]
    .filter(([ch, k, r, c]) => castle.includes(ch) && b[k] === (6 | c) && b[r] === (4 | c)).map(x => x[0]).join('');
  return `${rows} ${stm} ${rights || '-'} ${/^[a-h][36]$/.test(ep) ? ep : '-'} 0 1`;
}
const sqOf = s => (s.charCodeAt(0) - 97) + (s.charCodeAt(1) - 49) * 8;
const sqName = s => 'abcdefgh'[s & 7] + ((s >> 3) + 1);

function applyMove(board, uci) {
  const b = board.slice(), from = sqOf(uci), to = sqOf(uci.slice(2)), pc = b[from], t = pc & 7;
  if (t === 1 && (from & 7) !== (to & 7) && !b[to]) b[to + (pc & 8 ? 8 : -8)] = 0;              // en passant
  if (t === 6 && Math.abs(to - from) === 2) {                                                 // castling
    const [rf, rt] = to > from ? [from + 3, from + 1] : [from - 4, from - 1];
    b[rt] = b[rf]; b[rf] = 0;
  }
  b[to] = uci[4] ? (pc & 8) | ' pnbrq'.indexOf(uci[4]) : pc;
  b[from] = 0;
  return b;
}
function moveLabel(board, uci) { // short algebraic, no check marks
  const from = sqOf(uci), to = sqOf(uci.slice(2)), t = board[from] & 7;
  if (t === 6 && Math.abs(to - from) === 2) return to > from ? 'O-O' : 'O-O-O';
  const cap = board[to] || (t === 1 && (from & 7) !== (to & 7));
  // another piece of the same kind reaching the same square: say which one (pins ignored, so rarely more than SAN needs)
  const rivals = t > 1 && t < 6 ? board.map((pc, s) => s !== from && pc === board[from] && attacks(t, s, board).includes(to) ? s : -1).filter(s => s >= 0) : [];
  const which = !rivals.length ? '' : !rivals.some(s => (s & 7) === (from & 7)) ? uci[0] : !rivals.some(s => s >> 3 === from >> 3) ? uci[1] : uci.slice(0, 2);
  return (t === 1 ? (cap ? uci[0] : '') : ' PNBRQK'[t]) + which + (cap ? 'x' : '') + sqName(to) + (uci[4] ? '=' + uci[4].toUpperCase() : '');
}

// ---------- attack geometry ----------
const KNIGHT = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]], ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIRS = { 3: DIAG, 4: ORTH, 5: [...DIAG, ...ORTH], 6: [...DIAG, ...ORTH] };
const step = (from, df, dr) => { const f = (from & 7) + df, r = (from >> 3) + dr; return f < 0 || f > 7 || r < 0 || r > 7 ? -1 : r * 8 + f; };
function attacks(kind, from, board) { // kind: 0/1 = white/black pawn, 2..6 = N B R Q K. board null = empty board
  const out = [];
  if (kind < 2) for (const df of [-1, 1]) { const s = step(from, df, kind ? -1 : 1); if (s >= 0) out.push(s); }
  else if (kind === 2) for (const [df, dr] of KNIGHT) { const s = step(from, df, dr); if (s >= 0) out.push(s); }
  else for (const [df, dr] of DIRS[kind])
    for (let s = step(from, df, dr); s >= 0; s = step(s, df, dr)) { out.push(s); if (kind === 6 || (board && board[s])) break; }
  return out;
}
const kindOf = pc => (pc & 7) === 1 ? pc >> 3 : pc & 7;

// ---------- feature indices (features/half_ka_v2_hm, full_threats, pp_3wide) ----------
const PIECES = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14];
const VALID_TARGETS = [0, 4, 10, 8, 8, 10, 0];
const TMAP = [[-1, 0, -1, 1, -1, -1], [0, 1, 2, 3, 4, -1], [0, 1, 2, 3, -1, -1], [0, 1, 2, 3, -1, -1], [0, 1, 2, 3, 4, -1], [-1, -1, -1, -1, -1, -1]];
const T_OFF = [], T_LUT1 = [], T_LUT2 = [];
{
  const pseudo = [0, 1, 2, 3, 4, 5, 6].map(k => Array.from({ length: 64 }, (_, s) => attacks(k, s, null)));
  for (const k of [0, 1, 2, 3, 4, 5, 6]) { // T_LUT2[kind][from*64+to] = attacked squares below `to`
    const t = T_LUT2[k] = new Uint8Array(4096);
    for (let from = 0; from < 64; from++) for (let to = 0; to < 64; to++) t[from * 64 + to] = pseudo[k][from].filter(s => s < to).length;
  }
  const helper = [];
  let total = 0;
  for (const pc of PIECES) {
    const off = T_OFF[pc] = new Int32Array(64);
    let n = 0;
    for (let from = 0; from < 64; from++) {
      off[from] = n;
      if ((pc & 7) !== 1 || (from >= 8 && from <= 55)) n += pseudo[kindOf(pc)][from].length;
    }
    helper[pc] = { perPiece: n, base: total };
    total += VALID_TARGETS[pc & 7] * n;
  }
  if (total !== THREAT_DIMS) throw new Error('threat index table is wrong: ' + total);
  for (const a of PIECES) {
    T_LUT1[a] = [];
    for (const d of PIECES) {
      const m = TMAP[(a & 7) - 1][(d & 7) - 1];
      const feature = helper[a].base + ((d >> 3) * (VALID_TARGETS[a & 7] / 2) + m) * helper[a].perPiece;
      T_LUT1[a][d] = [m < 0 ? THREAT_DIMS : feature, m < 0 || (a & 7) === (d & 7) ? THREAT_DIMS : feature];
    }
  }
}

function psqIndex(persp, s, pc, ksq) {
  const flip = 56 * persp, k = ksq ^ flip, t = pc & 7;
  const orient = (ksq & 7) < 4 ? 7 : 0;
  const ps = t === 6 ? 640 : (t - 1) * 128 + ((pc >> 3) !== persp ? 64 : 0);
  const kf = k & 7, bucket = (7 - (k >> 3)) * 4 + (kf < 4 ? kf : 7 - kf);
  return (s ^ orient ^ flip) + ps + bucket * 704;
}
function threatIndex(persp, attacker, from, to, attacked, ksq) {
  const o = ((ksq & 7) >= 4 ? 7 : 0) ^ (56 * persp), f = from ^ o, t = to ^ o, a = attacker ^ (8 * persp), d = attacked ^ (8 * persp);
  return T_LUT1[a][d][f < t ? 1 : 0] + T_OFF[a][f] + T_LUT2[kindOf(a)][f * 64 + t];
}
function pairIndex(persp, ca, a, cb, b, ksq) {
  const o = ((ksq & 7) >= 4 ? 7 : 0) ^ (56 * persp);
  const ia = 48 * (ca ^ persp) + (a ^ o) - 8, ib = 48 * (cb ^ persp) + (b ^ o) - 8;
  const hi = Math.max(ia, ib), lo = Math.min(ia, ib);
  return hi * (hi - 1) / 2 + lo;
}

// Attack relations and pawn pairs the net takes as input, independent of perspective.
function relations(board) {
  const threats = [], pairs = [], pawns = [];
  for (let from = 0; from < 64; from++) {
    const pc = board[from], t = pc & 7;
    if (!pc || t === 6) continue;
    if (t === 1) pawns.push(from);
    for (const to of attacks(kindOf(pc), from, board)) {
      const tt = board[to] & 7;
      if (!tt || tt === 6) continue;
      if (t === 1 ? tt === 2 || tt === 4 : tt <= (t === 2 || t === 5 ? 5 : 4)) threats.push([pc, from, to, board[to]]);
    }
  }
  for (let i = 0; i < pawns.length; i++) for (let j = i + 1; j < pawns.length; j++)
    if (Math.abs((pawns[i] & 7) - (pawns[j] & 7)) <= 1) pairs.push([pawns[i], pawns[j]]);
  return { threats, pairs };
}

// ---------- forward pass ----------
const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;

function accumulate(net, board, persp, rel) {
  const acc = new Int32Array(L1), psqt = new Int32Array(8), ksq = board.indexOf(6 | persp << 3);
  acc.set(net.biases);
  const add = (W, P, idx) => {
    const o = idx * L1;
    for (let j = 0; j < L1; j++) acc[j] += W[o + j];
    for (let b = 0; b < 8; b++) psqt[b] += P[idx * 8 + b];
  };
  for (let s = 0; s < 64; s++) if (board[s]) add(net.psqW, net.psqPsqt, psqIndex(persp, s, board[s], ksq));
  for (const [a, from, to, d] of rel.threats) {
    const idx = threatIndex(persp, a, from, to, d, ksq);
    if (idx < THREAT_DIMS) add(net.threatW, net.threatPsqt, idx);
  }
  for (const [a, b] of rel.pairs) add(net.pairW, net.pairPsqt, pairIndex(persp, board[a] >> 3, a, board[b] >> 3, b, ksq));
  return { acc, psqt, ksq };
}

function materialA(board) { // UCIEngine::win_rate_params, the engine's internal-units-per-pawn scale
  let m = 0;
  for (const pc of board) m += [0, 1, 3, 3, 5, 9, 0][pc & 7];
  const x = clamp(m, 17, 78) / 58;
  return ((-142.72052667 * x + 372.35176398) * x - 340.71073572) * x + 415.23490212;
}

// Runs the net. Returns everything the layers computed; `x` and edge indices are in display
// order (white's view first, then black's), whoever is to move.
function forward(net, board, stm, full) {
  const rel = relations(board);
  const side = [accumulate(net, board, 0, rel), accumulate(net, board, 1, rel)];
  const pieceCount = board.reduce((n, pc) => n + (pc ? 1 : 0), 0), bucket = (pieceCount - 1) >> 2;
  const st = net.stacks[bucket];

  const x = new Uint8Array(L1);       // network order: side to move first
  for (let p = 0; p < 2; p++) {
    const a = side[p ? stm ^ 1 : stm].acc;
    for (let j = 0; j < HALF; j++) x[p * HALF + j] = (clamp(a[j], 0, 255) * clamp(a[j + HALF], 0, 255)) >> 9;
  }
  const o0 = new Int32Array(L2), act = new Int32Array(128);
  for (let k = 0; k < L2; k++) { let s = st.b0[k]; for (let i = 0; i < L1; i++) if (x[i]) s += st.w0[k * L1 + i] * x[i]; o0[k] = s; }
  for (let k = 0; k < L2; k++) { act[k] = Math.min(127, Math.floor(o0[k] * o0[k] / 2 ** 21)); act[32 + k] = clamp(o0[k] >> 7, 0, 127); }
  const o1 = new Int32Array(L3);
  for (let k = 0; k < L3; k++) { let s = st.b1[k]; for (let i = 0; i < 64; i++) s += st.w1[k * 64 + i] * act[i]; o1[k] = s; }
  for (let k = 0; k < L3; k++) { act[64 + k] = Math.min(127, Math.floor(o1[k] * o1[k] / 2 ** 19)); act[96 + k] = clamp(o1[k] >> 6, 0, 127); }
  let o2 = st.b2[0];
  for (let i = 0; i < 128; i++) o2 += st.w2[i] * act[i];
  const skip = o0[30] - o0[31];
  const positional = Math.trunc(Math.trunc((o2 + skip) * 9600 / 16384) / 16);
  const psqt = Math.trunc(Math.trunc((side[stm].psqt[bucket] - side[stm ^ 1].psqt[bucket]) / 2) / 16);
  const value = psqt + positional;    // internal units, side to move
  const sign = stm ? -1 : 1, a = materialA(board);
  const res = { value, cp: Math.round(100 * value * sign / a) };
  if (!full) return res;

  const disp = i => (i < HALF) === (stm === 0) ? i % HALF : HALF + i % HALF;
  const top = (list, n) => list.sort((p, q) => Math.abs(q[2]) - Math.abs(p[2])).slice(0, n);
  const e0 = [], e1 = [];
  for (let k = 0; k < L2; k++) for (let i = 0; i < L1; i++) if (x[i]) e0.push([disp(i), k, st.w0[k * L1 + i] * x[i]]);
  for (let k = 0; k < L3; k++) for (let i = 0; i < 64; i++) if (act[i]) e1.push([i, k, st.w1[k * 64 + i] * act[i]]);
  const xd = new Array(L1);
  for (let i = 0; i < L1; i++) xd[disp(i)] = x[i];
  const toCp = v => Math.round(100 * v * sign * 9600 / 16384 / 16 / a); // a share of the output, in centipawns for white

  // Which pair-neurons each piece moves most: exact change if only that piece's square feature were removed.
  const pieces = [];
  for (let s = 0; s < 64; s++) {
    const pc = board[s];
    if (!pc) continue;
    const drive = [];
    for (let p = 0; p < 2; p++) {
      const o = psqIndex(p, s, pc, side[p].ksq) * L1, a2 = side[p].acc, d = [];
      for (let j = 0; j < HALF; j++) {
        const was = (clamp(a2[j] - net.psqW[o + j], 0, 255) * clamp(a2[j + HALF] - net.psqW[o + j + HALF], 0, 255)) >> 9;
        const now = (clamp(a2[j], 0, 255) * clamp(a2[j + HALF], 0, 255)) >> 9;
        if (now !== was) d.push([p * HALF + j, 0, now - was]);
      }
      drive.push(...top(d, 3).map(e => [e[0], e[2]]));
    }
    let worth = null;                 // eval change if the piece is taken off the board (kings can't be)
    if ((pc & 7) !== 6) { const b = board.slice(); b[s] = 0; worth = res.cp - forward(net, b, stm, false).cp; }
    pieces.push({ sq: s, pc, drive, worth });
  }
  return Object.assign(res, {
    bucket, stm, x: xd,
    h0: Array.from(act.subarray(0, 64)), h1: Array.from(act.subarray(64, 128)),
    e0: top(e0, 220), e1: top(e1, 110),
    e2: Array.from(act, (v, i) => toCp(st.w2[i] * v)),
    material: Math.round(100 * psqt * sign / a), positional: Math.round(100 * positional * sign / a),
    pieces, threats: rel.threats.map(t => [t[1], t[2]]), pairs: rel.pairs,
    nFeatures: pieceCount + rel.threats.length + rel.pairs.length,
  });
}

// 2-D map of the 512 pair-neurons: neurons that listen to similar inputs land close together
// (top two principal components of their incoming piece-square weights).
function layout(net) {
  const N = HALF, feats = [];
  for (let f = 0; f < PSQ_DIMS; f += 13) feats.push(f);
  const D = feats.length * 2, X = new Float32Array(N * D);
  feats.forEach((f, c) => { for (let j = 0; j < N; j++) { X[j * D + 2 * c] = net.psqW[f * L1 + j]; X[j * D + 2 * c + 1] = net.psqW[f * L1 + j + HALF]; } });
  for (let d = 0; d < D; d++) { let m = 0; for (let j = 0; j < N; j++) m += X[j * D + d]; m /= N; for (let j = 0; j < N; j++) X[j * D + d] -= m; }
  const G = new Float64Array(N * N);
  for (let i = 0; i < N; i++) for (let j = i; j < N; j++) { let s = 0; for (let d = 0; d < D; d++) s += X[i * D + d] * X[j * D + d]; G[i * N + j] = G[j * N + i] = s; }
  const comps = [];
  for (let c = 0; c < 2; c++) {     // power iteration, deflating the first component for the second
    let v = Float64Array.from({ length: N }, (_, i) => Math.sin(i * 12.9898 + c) * 43758.5453 % 1);
    for (let it = 0; it < 80; it++) {
      const w = new Float64Array(N);
      for (let i = 0; i < N; i++) { let s = 0; for (let j = 0; j < N; j++) s += G[i * N + j] * v[j]; w[i] = s; }
      for (const u of comps) { let dot = 0; for (let i = 0; i < N; i++) dot += w[i] * u[i]; for (let i = 0; i < N; i++) w[i] -= dot * u[i]; }
      const norm = Math.hypot(...w);
      v = w.map(q => q / norm);
    }
    comps.push(v);
  }
  return Array.from({ length: N }, (_, j) => [+(comps[0][j] * Math.sqrt(N)).toFixed(3), +(comps[1][j] * Math.sqrt(N)).toFixed(3)]);
}

const API = { NET_NAME, netFromWasm, parseNet, parseFen, cleanFen, applyMove, moveLabel, forward, layout };
if (typeof module === 'object' && module.exports) module.exports = API; else self.NNUE = API;

// ---------- Node: `npm run check`, and `node viz/nnue.js layout` to rewrite viz/layout.json ----------
// The check replays a game through the same WebAssembly engine the page runs and requires every
// position's network value to match the engine's own `eval` exactly.
if (typeof require === 'function' && require.main === module) {
  const fs = require('fs'), path = require('path'), assert = require('assert');
  const bin = path.join(path.dirname(require.resolve('stockfish')), 'bin');
  const net = parseNet(netFromWasm(new Uint8Array(fs.readFileSync(path.join(bin, 'stockfish-19-single.wasm')))));
  if (process.argv[2] === 'layout') return fs.writeFileSync(path.join(__dirname, 'layout.json'), JSON.stringify(layout(net)));
  // move labels name the piece when two of a kind can reach the square
  assert.strictEqual(moveLabel(parseFen('4k3/8/8/8/8/5N2/8/1N2K3 w').board, 'b1d2'), 'Nbd2');
  assert.strictEqual(moveLabel(parseFen('4k3/8/8/R7/8/8/8/R3K3 w').board, 'a1a3'), 'R1a3');
  assert.strictEqual(moveLabel(parseFen('4k3/8/8/8/8/8/8/R3K3 w').board, 'a1a3'), 'Ra3');
  const GAME = 'e2e4 c7c5 g1f3 d7d6 d2d4 c5d4 f3d4 g8f6 b1c3 a7a6 c1e3 e7e5 d4b3 c8e6 f2f3 f8e7 d1d2 e8g8 e1c1 b8d7 g2g4 b7b5 g4g5 b5b4 c3e2 f6e8 f3f4 a6a5 f4f5 a5a4 b3d4 e5d4 e2d4 b4b3 c1b1 b3c2 d4c2 e6b3 a2b3 a4b3 c2a3 d7e5 h2h4 a8a4 d2g2 d8a8 f1b5 a4a3 b2a3 a8a3 b5e8 f8e8 e3d4 e5c4 d4b2 a3a2 b1c1 c4b2 g2b2 a2b2 c1b2 e7g5 h4g5 e8e4 d1d6 h7h6 g5h6 g7h6 d6d8 g8g7 f5f6 g7g6 h1g1 g6f5 g1g7 e4e2 b2b3 f5f6 g7h7 e2e6 d8d7 f6g6 h7f7 e6e3 b3c4 h6h5 f7f1 h5h4 d7d4 h4h3 f1h1 e3e2 h1h3 e2c2 c4d5 c2c8 h3g3 g6f5 d4f4'.split(' ');
  const FENS = ['4k3/P6p/8/3pP3/8/8/7P/4K2R w K d6 0 1', '4k3/P6p/8/8/8/8/6pP/4K3 b - - 0 1', '8/8/4k3/8/8/2K5/8/8 w - - 0 1'];
  const cases = [];
  let board = parseFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w').board;
  GAME.forEach((m, i) => { cases.push({ board, stm: i & 1, cmd: `position startpos moves ${GAME.slice(0, i).join(' ')}` }); board = applyMove(board, m); });
  for (const fen of FENS) {
    const p = parseFen(fen);
    cases.push({ ...p, cmd: `position fen ${fen}` });
    const mv = fen.includes('d6') ? 'e5d6' : fen.includes('2pP') ? 'g2g1q' : null; // en passant, promotion
    if (mv) cases.push({ board: applyMove(p.board, mv), stm: p.stm ^ 1, cmd: `position fen ${fen} moves ${mv}` });
  }
  let out = '';
  const sf = require('stockfish')('single', line => {
    out += line + '\n';
    if (line !== 'readyok') return;                 // every eval has been printed
    const got = out.split('Final evaluation').slice(0, -1).map(s => { const m = s.match(/NNUE evaluation\s+([+-]?\d+) \(side to move/); return m ? +m[1] : null; });
    let checked = 0, bad = 0;
    cases.forEach((c, i) => {
      if (got[i] === null) return;    // side to move is in check: the engine prints no eval
      checked++;
      const mine = forward(net, c.board, c.stm, false).value;
      if (mine !== got[i]) { bad++; console.log(`MISMATCH  ${c.cmd.slice(0, 70)}  engine ${got[i]}  js ${mine}`); }
    });
    console.log(`${checked - bad}/${checked} positions match the engine exactly (${cases.length - checked} skipped: in check)`);
    process.exit(bad || !checked ? 1 : 0);
  });
  for (const c of cases) { sf.processCommand(c.cmd); sf.processCommand('eval'); }
  sf.processCommand('isready');
}
})();
