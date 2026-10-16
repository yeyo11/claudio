// Length-prefixed JSON frames on a bidirectional stream, as docs/plans/collaborators.md §4.2 describes.
const enc = new TextEncoder();
const dec = new TextDecoder();

export function encodeFrame(obj, payload = null) {
  const json = enc.encode(JSON.stringify(obj));
  const head = new Uint8Array(4 + json.length);
  new DataView(head.buffer).setUint32(0, json.length);
  head.set(json, 4);
  return payload ? concat(head, payload) : head;
}

function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// The binding takes and returns Array<number>, not Buffer: the conversions here are what C0 measures.
export const toArray = (u8) => Array.from(u8);
export const fromArray = (arr) => Uint8Array.from(arr);

export async function readFrame(recv) {
  const head = fromArray(await recv.readExact(4));
  const len = new DataView(head.buffer).getUint32(0);
  const body = fromArray(await recv.readExact(len));
  return JSON.parse(dec.decode(body));
}

export async function readBytes(recv, size) {
  let got = 0;
  const CHUNK = 256 * 1024;
  while (got < size) {
    const part = await recv.read(Math.min(CHUNK, size - got));
    if (part === null || part.length === 0) throw new Error(`stream ended at ${got}/${size}`);
    got += part.length;
  }
  return got;
}
