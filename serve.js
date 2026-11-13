// Serves the static site in viz/ on this computer, the same files Vercel serves. Node stdlib only.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, 'viz'), PORT = +process.env.PORT || 4517;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

http.createServer((req, res) => {
  let file = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (file === ROOT + path.sep) file += 'index.html';
  if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size,
      'cache-control': file.includes(path.sep + 'engine' + path.sep) ? 'public, max-age=604800' : 'no-store', // engine: cached, so the network is read from it without a second download
    });
    fs.createReadStream(file).pipe(res);
  });
}).listen(PORT, '127.0.0.1', () => console.log(`Fishbowl → http://localhost:${PORT}`));
