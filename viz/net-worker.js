// The network, off the page's thread: a full trace takes 50-150 ms and would stall the picture.
// game.js first sends the engine's .wasm, which carries the weights; then positions to read.
importScripts('nnue.js');
let ready;
onmessage = async ({ data }) => {
  if (data.wasm) return void (ready = data.wasm.arrayBuffer().then(b => NNUE.parseNet(NNUE.netFromWasm(new Uint8Array(b)))));
  try { postMessage({ id: data.id, trace: NNUE.forward(await ready, data.board, data.stm, true) }); }
  catch (e) { postMessage({ id: data.id, error: String(e && e.message || e) }); }
};
