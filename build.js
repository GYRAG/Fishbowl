// Puts the Stockfish 19 WebAssembly engine (single-threaded, full network) next to the page.
// Runs before `npm start`, and as Vercel's build command.
'use strict';
const fs = require('fs'), path = require('path');
const from = path.join(path.dirname(require.resolve('stockfish')), 'bin'), to = path.join(__dirname, 'viz', 'engine');
fs.mkdirSync(to, { recursive: true });
for (const f of ['stockfish-19-single.js', 'stockfish-19-single.wasm']) fs.copyFileSync(path.join(from, f), path.join(to, f));
