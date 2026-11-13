// The game and the engine, all in the browser. Stockfish 19 (WebAssembly) runs in one worker and
// speaks UCI; the network trace runs in another (net-worker.js), so the picture never stalls.
// The page sets Game.on.* and calls Game.act / Game.preview.
'use strict';
const Game = (() => {
  const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  const EXPLORE_MS = 20000;                          // thinking time when you drive
  const OPTIONS = { Hash: 64, MultiPV: 6, UCI_ShowWDL: true }; // the single-threaded build has no Threads
  const on = { pos() {}, info() {}, mode() {}, status() {} };
  const S = { startFen: START, moves: [], evals: [], auto: true };
  let watchMs = 3000;                                // thinking time per move when the engine plays itself
  let root = null, lines = {}, searching = false, stopping = false, gen = 0, waiters = [], perft = null, timer;
  let queue = Promise.resolve();

  let sf, net, tid = 0;
  const say = cmd => sf.postMessage(cmd);
  const until = test => new Promise(resolve => waiters.push({ test, resolve }));
  const enqueue = fn => (queue = queue.then(fn).catch(e => console.error(e)));
  const traces = new Map();
  const netTrace = (board, stm) => new Promise((resolve, reject) => { traces.set(++tid, { resolve, reject }); net.postMessage({ id: tid, board, stm }); });
  const layout = fetch('layout.json').then(r => r.json());

  // The engine and its network come in one 99 MB file. It is downloaded once, kept in Cache Storage
  // for the next visit (browsers will not reliably HTTP-cache a file this big), and the same bytes
  // go to the engine and to net-worker.js.
  const WASM = 'engine/stockfish-19-single.wasm', WASM_SIZE = 99169054;
  async function engineFile() {
    let store = null;
    try { store = await caches.open('fishbowl-' + NNUE.NET_NAME); const hit = await store.match(WASM); if (hit) return await hit.blob(); }
    catch { store = null; }                          // private windows may refuse storage: just download
    const res = await fetch(WASM);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const total = (!res.headers.get('content-encoding') && +res.headers.get('content-length')) || WASM_SIZE, chunks = [], reader = res.body.getReader();
    for (let got = 0; ;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); got += value.length;
      on.status(`Loading Stockfish 19 · ${Math.min(99, Math.round(got / total * 100))}% of ${Math.round(total / 1048576)} MB`);
    }
    const blob = new Blob(chunks, { type: 'application/wasm' });
    if (store) store.put(WASM, new Response(blob, { headers: { 'content-type': 'application/wasm' } })).catch(() => {});
    return blob;
  }
  const boot = (async () => {
    const blob = await engineFile(), url = URL.createObjectURL(blob);
    on.status('Starting the engine…');
    sf = new Worker('engine/stockfish-19-single.js#' + encodeURIComponent(url)); // the hash tells it where its wasm is
    sf.onmessage = e => typeof e.data === 'string' && e.data.split('\n').forEach(onLine);
    sf.onerror = () => on.status('The engine stopped working. Reload the page to start again.');
    for (const [k, v] of Object.entries(OPTIONS)) say(`setoption name ${k} value ${v}`);
    say('isready');
    await until(l => l === 'readyok');
    URL.revokeObjectURL(url);
    on.status('Reading the network…');
    net = new Worker('net-worker.js');
    net.onmessage = ({ data: d }) => { const t = traces.get(d.id); traces.delete(d.id); d.error ? t.reject(new Error(d.error)) : t.resolve(d.trace); };
    net.postMessage({ wasm: blob });
    await layout;
  })();
  boot.catch(e => on.status('The engine could not be loaded (' + e.message + ').'));

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
    o.san = o.pv.map(m => { const s = NNUE.moveLabel(b, m); b = NNUE.applyMove(b, m); return s; });
    for (const k in lines) if (lines[k].pv[0] === o.pv[0]) delete lines[k]; // the move moved rank: its old line is stale
    lines[o.multipv] = o;
    on.info(o);
  }

  // (Re)start analysis of the current game position. Always runs inside the queue.
  async function analyse() {
    gen++; clearTimeout(timer);
    if (searching) { stopping = true; say('stop'); await until(l => l.startsWith('bestmove')); stopping = false; }
    lines = {};
    if (document.hidden) return;                     // nobody watching: let the CPU rest
    perft = [];
    const got = [until(l => l.startsWith('Fen: ')), until(l => l.startsWith('Checkers:')), until(l => l.startsWith('Nodes searched'))];
    say(`position fen ${S.startFen} moves ${S.moves.join(' ')}`); say('d'); say('go perft 1');
    const [fenLine, checkLine] = await Promise.all(got);
    const legal = perft; perft = null;
    const fen = fenLine.slice(5), { board, stm } = NNUE.parseFen(fen), check = checkLine.trim().length > 9;
    const quiet = S.evals.length > 70 && S.evals.slice(-14).every(v => Math.abs(v) < 12);
    const over = !legal.length ? (check ? 'checkmate' : 'stalemate')
      : +fen.split(' ')[4] >= 100 || board.filter(Boolean).length < 3 || (S.auto && (quiet || S.moves.length > 300)) ? 'draw' : null;
    const trace = await netTrace(board, stm);
    root = { id: gen, fen, board, stm, legal: over ? [] : legal, check, over, ply: S.moves.length, last: S.moves.at(-1) || null, auto: S.auto, pace: watchMs, trace };
    on.pos(root);
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

  // Each returns an error string, false for "no need to re-analyse", or nothing.
  // evals stay one per move, so take back and the quiet-draw check read the right ones.
  const actions = {
    move: ({ uci }) => { if (!root || !root.legal.includes(uci)) return 'not a legal move'; S.auto = false; S.moves.push(uci); S.evals.push(9999); },
    step: () => { const m = lines[1] && lines[1].pv[0]; if (!m) return 'engine has no move yet'; S.auto = false; S.moves.push(m); S.evals.push(lines[1].cp ?? 9999); },
    undo: () => { S.auto = false; S.moves.pop(); S.evals.pop(); },
    auto: ({ on }) => { S.auto = !!on; if (!on) return false; }, // pausing keeps the current lines on screen
    pace: ({ ms }) => { watchMs = Math.min(20000, Math.max(500, +ms || 3000)); return false; }, // applies from the next move
    new: ({ fen }) => { const f = fen ? NNUE.cleanFen(fen) : START; if (!f) return 'that FEN is not a legal position'; newGame(f); if (fen) S.auto = false; },
  };
  // Resolves to an error message, or null once the action is taken.
  const act = (name, arg = {}) => new Promise(resolve => enqueue(() => {
    const r = actions[name](arg);
    if (typeof r === 'string') return resolve(r);
    resolve(null);
    on.mode({ auto: S.auto, pace: watchMs });
    return r === false ? null : analyse();
  }));

  // The network reading a position some moves ahead of the current one (moves come from the engine's lines).
  function preview(moves) {
    let b = root.board, stm = root.stm;
    for (const m of moves) { b = NNUE.applyMove(b, m); stm ^= 1; }
    return netTrace(b, stm).then(trace => ({ board: b, stm, trace }));
  }

  boot.then(() => enqueue(analyse));
  document.addEventListener('visibilitychange', () => boot.then(() => enqueue(analyse))); // stop when hidden, pick up when back
  return { on, act, preview, layout, NET: NNUE.NET_NAME };
})();
