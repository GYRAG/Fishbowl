# Stockfish Lens

A live picture of how Stockfish 19 picks a move: the position goes in on the left, runs through
the engine's neural network (NNUE), and the search fans out on the right.

Everything runs in the browser, so the site is plain static files.

```bash
npm install
npm start
```

Then open http://localhost:4517.

The first visit downloads the engine, one 95 MB file that also holds the network. The browser keeps
it, so later visits start in a few seconds. It needs a desktop-class browser: the engine and the
network together use a few hundred MB of memory.

## Publishing on Vercel

Import the GitHub repository in Vercel. `vercel.json` already sets the build (`npm run build`, which
copies the engine next to the page) and the output folder (`viz/`). There is no server code.

## What is real

- **Search lines, scores, depth, speed** come from Stockfish 19 itself, compiled to WebAssembly
  ([stockfish.js](https://github.com/nmrugg/stockfish.js)) and running in a background thread of the page.
  It is the single-threaded build, so it searches more slowly than the desktop program.
- **Every neuron** is recomputed in JavaScript (`viz/nnue.js`, ported from Stockfish's `src/nnue`) from
  the network inside that same engine file. `npm run check` replays a game through the engine and
  requires its own `eval` number to match on every position.
- **Fibres** show only the strongest connections, not all of them. The shape of the two clouds is a
  2-D map (PCA) of the neurons' incoming weights, so neighbours listen to similar inputs.

## Using it

- It starts in *watch* mode: the engine plays itself. Space pauses and resumes; *pace* sets how long it thinks per move.
- Keys 1 to 4 (or the tabs, top right) redraw the same network four ways: Nebula, Orbit, Loom, Grid.
- `?` opens a five-step tour that lights up each part of the picture in turn (it opens by itself on a first visit).
- Hover a line of play on the right to see the position it leads to, and the network reading it.
  Click a point on the line to pin that future so you can inspect its pieces and neurons; Esc returns.
- Hover a piece to see which neurons it drives and what the network thinks it is worth.
- Click a piece, then a square, to move it yourself. Arrow keys: right plays the engine's move, left takes back.
- *Set position* accepts a FEN.

## Layout

- `viz/` is the whole site. `index.html` draws the picture. `game.js` runs the game and talks to the
  engine. `net-worker.js` runs the network off the page's thread. `layout.json` holds the neuron map
  (rewrite it with `node viz/nnue.js layout`).
- `build.js` copies the engine from `node_modules/stockfish` into `viz/engine/`. `serve.js` serves
  `viz/` on this computer.

## License

GPL-3.0, the same as Stockfish: `viz/nnue.js` is ported from Stockfish's source. See `LICENSE`.
