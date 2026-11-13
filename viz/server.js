// Bridge between the Stockfish 19 process and the browser. Node stdlib only.
//   GET  /            the visualizer
//   GET  /events      server-sent events: init, pos (new position + network trace), info (search lines)
//   GET  /trace?moves=e2e4,e7e5   network trace for a position some moves ahead of the current one
//   POST /move /step /undo /auto /pace /new   game controls (JSON body)
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const nn = require('./nnue');

const PORT = +process.env.PORT || 4517;
const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EXPLORE_MS = 20000;  // thinking time when you drive
let watchMs = 3000;          // thinking time per move when the engine plays itself (the pace control)
const OPTIONS = { Threads: 4, Hash: 256, MultiPV: 6, UCI_ShowWDL: true };

console.log('loading the network…');
const net = nn.loadNet();
// ponytail: the layout only depends on the net, so it is computed once (3 s) and kept next to it; delete the file if layout() changes
const LAYOUT = path.join(nn.ENGINE_DIR, nn.NET_NAME + '.layout.json');
let layout;
try { layout = JSON.parse(fs.readFileSync(LAYOUT, 'utf8')); } catch { fs.writeFileSync(LAYOUT, JSON.stringify(layout = nn.layout(net))); }
const INIT = { net: nn.NET_NAME, layout };

const S = { startFen: START, moves: [], evals: [], auto: true };
let root = null;   // the position being analysed, as last sent to clients
let lines = {};    // multipv rank -> latest search line
let sf, bornAt, searching = false, stopping = false, gen = 0, waiters = [], perft = null, timer;
let queue = Promise.resolve();
const clients = new Set();

const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const emit = (type, data) => { const m = frame(type, data); for (const c of clients) c.write(m); };
const say = cmd => sf.stdin.write(cmd + '\n');
const until = test => new Promise(resolve => waiters.push({ test, resolve }));
const enqueue = fn => (queue = queue.then(fn).catch(e => console.error(e)));

function startEngine() {
  sf = spawn(nn.EXE, { cwd: nn.ENGINE_DIR });
  bornAt = Date.now(); searching = stopping = false; waiters = []; perft = null;
  let tail = '';
  sf.stdout.on('data', d => { const parts = (tail + d).split(/\r?\n/); tail = parts.pop(); parts.forEach(onLine); });
  sf.on('close', () => {
    if (Date.now() - bornAt < 3000) { console.error('engine will not stay up'); process.exit(1); }
    console.error('engine exited — restarting from the start position');
    Object.assign(S, { startFen: START, moves: [], evals: [] });
    queue = Promise.resolve(); startEngine(); enqueue(analyse);
  });
  for (const [k, v] of Object.entries(OPTIONS)) say(`setoption name ${k} value ${v}`);
}

function onLine(l) {
  if (perft && /^[a-h][1-8][a-h][1-8][qrbn]?: /.test(l)) perft.push(l.split(':')[0]);
  if (searching && !stopping && l.startsWith('info ') && l.includes(' pv ')) onInfo(l);
  if (l.startsWith('bestmove')) {
    searching = false;
    if (S.auto && !stopping) { const g = gen; enqueue(() => g === gen && S.auto && autoMove()); }
  }
  waiters = waiters.filter(w => !(w.test(l) && (w.resolve(l), true)));
}

function onInfo(l) {
  const t = l.split(' '), o = { id: gen }, flip = root.stm ? -1 : 1;
  for (let i = 1; i < t.length; i++) {
    const k = t[i];
    if (k === 'pv') { o.pv = t.slice(i + 1); break; }
    if (k === 'lowerbound' || k === 'upperbound') return;           // a bound, not a settled score
    if (k === 'score') { o[t[i + 1]] = +t[i + 2] * flip; i += 2; }  // cp or mate, from white's side
    else if (k === 'wdl') { o.wdl = [+t[i + 1], +t[i + 2], +t[i + 3]]; if (root.stm) o.wdl.reverse(); i += 3; }
    else if (['depth', 'seldepth', 'multipv', 'nodes', 'nps', 'time'].includes(k)) o[k] = +t[++i];
  }
  let b = root.board;
  o.san = o.pv.map(m => { const s = nn.moveLabel(b, m); b = nn.applyMove(b, m); return s; });
  for (const k in lines) if (lines[k].pv[0] === o.pv[0]) delete lines[k]; // the move moved rank: its old line is stale
  lines[o.multipv] = o;
  emit('info', o);
}

// (Re)start analysis of the current game position. Always runs inside the queue.
async function analyse() {
  gen++; clearTimeout(timer);
  if (searching) { stopping = true; say('stop'); await until(l => l.startsWith('bestmove')); stopping = false; }
  lines = {};
  if (!clients.size) return;                                        // nobody watching: let the CPU rest
  perft = [];
  const got = [until(l => l.startsWith('Fen: ')), until(l => l.startsWith('Checkers:')), until(l => l.startsWith('Nodes searched'))];
  say(`position fen ${S.startFen} moves ${S.moves.join(' ')}`); say('d'); say('go perft 1');
  const [fenLine, checkLine] = await Promise.all(got);
  const legal = perft; perft = null;
  const fen = fenLine.slice(5), { board, stm } = nn.parseFen(fen), check = checkLine.trim().length > 9;
  const quiet = S.evals.length > 70 && S.evals.slice(-14).every(v => Math.abs(v) < 12);
  const over = !legal.length ? (check ? 'checkmate' : 'stalemate')
    : +fen.split(' ')[4] >= 100 || board.filter(Boolean).length < 3 || (S.auto && (quiet || S.moves.length > 300)) ? 'draw' : null;
  root = { id: gen, fen, board, stm, legal: over ? [] : legal, check, over, ply: S.moves.length, last: S.moves.at(-1) || null, auto: S.auto, pace: watchMs, trace: nn.forward(net, board, stm, true) };
  emit('pos', root);
  if (over) { if (S.auto) timer = setTimeout(() => enqueue(() => { newGame(); return analyse(); }), 7000); return; }
  searching = true;
  say(`go movetime ${S.auto ? watchMs : EXPLORE_MS}`);
}

function newGame(fen = START) { Object.assign(S, { startFen: fen, moves: [], evals: [] }); }

function autoMove() { // self-play: engine's choice, with a little variety in the opening so games differ
  const best = lines[1];
  if (!best) return;
  const near = S.moves.length < 10 && best.cp !== undefined ? Object.values(lines).filter(x => Math.abs(x.cp - best.cp) <= 45) : [best];
  S.evals.push(best.cp ?? 9999);
  S.moves.push(near[Math.floor(Math.random() * near.length)].pv[0]);
  return analyse();
}

const actions = {
  // evals stay one per move, so take back and the quiet-draw check read the right ones
  move: ({ uci }) => { if (!root || !root.legal.includes(uci)) return 'not a legal move'; S.auto = false; S.moves.push(uci); S.evals.push(9999); },
  step: () => { const m = lines[1] && lines[1].pv[0]; if (!m) return 'engine has no move yet'; S.auto = false; S.moves.push(m); S.evals.push(lines[1].cp ?? 9999); },
  undo: () => { S.auto = false; S.moves.pop(); S.evals.pop(); },
  auto: ({ on }) => { S.auto = !!on; if (!on) return false; }, // pausing keeps the current lines on screen
  pace: ({ ms }) => { watchMs = Math.min(20000, Math.max(500, +ms || 3000)); return false; }, // applies from the next move
  new: ({ fen }) => { const f = fen ? nn.cleanFen(fen) : START; if (!f) return 'that FEN is not a legal position'; newGame(f); if (fen) S.auto = false; },
};

function trace(res, moves) {
  if (!root || moves.length > 80 || moves.some(m => !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m))) return json(res, 400, { error: 'bad moves' });
  let b = root.board, stm = root.stm;
  for (const m of moves) {
    const pc = b[(m.charCodeAt(0) - 97) + (m.charCodeAt(1) - 49) * 8];
    if (!pc || pc >> 3 !== stm) return json(res, 400, { error: 'bad moves' });
    b = nn.applyMove(b, m); stm ^= 1;
  }
  if (!b.includes(6) || !b.includes(14)) return json(res, 400, { error: 'bad moves' });
  json(res, 200, { board: b, stm, trace: nn.forward(net, b, stm, true) });
}

const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(frame('init', INIT));
    clients.add(res);
    if (clients.size === 1) enqueue(analyse);
    else if (root) { res.write(frame('pos', { ...root, auto: S.auto, pace: watchMs })); for (const l of Object.values(lines)) res.write(frame('info', l)); }
    req.on('close', () => { clients.delete(res); if (!clients.size) enqueue(analyse); });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/trace')
    return trace(res, (url.searchParams.get('moves') || '').split(',').filter(Boolean));
  const act = actions[url.pathname.slice(1)];
  // JSON-only POSTs: a cross-site page cannot send this content type without a preflight we never answer
  if (req.method === 'POST' && act && /application\/json/.test(req.headers['content-type'] || '')) {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      let arg;
      try { arg = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
      enqueue(() => { // an action returns an error string, false for "no need to re-analyse", or nothing
        const r = act(arg || {});
        if (typeof r === 'string') return json(res, 400, { error: r });
        json(res, 200, { ok: true });
        emit('mode', { auto: S.auto, pace: watchMs });
        return r === false ? null : analyse();
      });
    });
    return;
  }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`Stockfish Lens → http://localhost:${PORT}`));

startEngine();
