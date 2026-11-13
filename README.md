# Stockfish Lens

A live picture of how Stockfish 19 picks a move: the position goes in on the left, runs through
the engine's neural network (NNUE), and the search fans out on the right.

```bash
npm start
```

Then open http://localhost:4517. No dependencies to install (Node standard library only).

The engine is not in this repository (it is over GitHub's file size limit). Download the official
Stockfish 19 Windows release (`stockfish-windows-x86-64-universal`) and unzip it so the program is at
`engine/stockfish/stockfish-windows-x86-64-universal.exe`. The network file is exported from it on
first start.

## What is real

- **Search lines, scores, depth, speed** come straight from the Stockfish 19 process over UCI.
- **Every neuron** is recomputed in JavaScript from the same network file the engine uses
  (`viz/nnue.js`, ported from `engine/stockfish/src/nnue`). `npm run check` replays a game and
  compares the result with the engine's own `eval` number on every position.
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

- `engine/` (not committed) — the official Stockfish 19 Windows release (binary + matching source), the network file exported from it, and a cached 2-D layout of the neurons.
- `viz/server.js` — runs the engine and streams it to the browser. `viz/index.html` — the picture.

## License

GPL-3.0, the same as Stockfish: `viz/nnue.js` is ported from Stockfish's source. See `LICENSE`.
