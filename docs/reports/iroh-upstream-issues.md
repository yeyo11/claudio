---
created_at: 2026-10-17T10:00:00Z
updated_at: 2026-10-17T10:00:00Z
tags:
    - collaborators
    - iroh
    - upstream
    - report
---
# Two upstream issues for `@number0/iroh`, ready to file

Stage C0 of [plans/collaborators.md](../plans/collaborators.md) (§7.2 C0 facts) found two defects in
the Node binding of iroh. The plan said to file them upstream, but nobody did
([requests.md](../requests.md) R12). Claudio keeps `@number0/iroh` pinned at `1.1.0` until both are
answered (plan §8). **Neither issue has been filed.** The owner decides whether to file them.

The binding is published from [n0-computer/iroh-ffi](https://github.com/n0-computer/iroh-ffi) (the
`repository` field of its `package.json`), so that is where both issues go. Each one below is
written to be pasted as it stands: a title, then the body.

## How they were checked

Both were rerun on 2026-10-17 against the installed package, with the scripts below and nothing
from Claudio:

- `@number0/iroh` **1.1.0**, with `@number0/iroh-linux-x64-gnu` 1.1.0
- Node **v22.21.1**
- Linux 7.0.0 x86_64 (Ubuntu), glibc

C0 had already seen the same results on Node 24 (Electron 44 with `ELECTRON_RUN_AS_NODE`) and on
`node:26-bookworm-slim`. The spike's own versions of these scripts are in
[collaborators-c0/spike/](collaborators-c0/README.md) (`w-test.mjs`, `w-conn.mjs`, `buf-test.mjs`).

---

## Issue 1

**Title:** `@number0/iroh` 1.1.0: every `watch*` method panics ("there is no reactor running") and
aborts the Node process

**Version:** `@number0/iroh` 1.1.0 (`@number0/iroh-linux-x64-gnu` 1.1.0), Node 22.21.1, Linux
x86_64 glibc. The same happens on Node 24 (Electron 44) and Node 26.

**What happens:** each of these calls aborts the whole Node process with exit code 134:

- `Endpoint.watchAddr`
- `Endpoint.watchHomeRelay`
- `Endpoint.watchNetworkChange`
- `Connection.watchPaths`
- `Connection.watchPathEvents`

The abort comes from a Rust panic, so a JS `try/catch` cannot catch it and no `process.on('exit')`
handler runs. The polling methods (`addr()`, `paths()`, `rtt()`, `stats()`) all work.

**Minimal reproduction** (`npm install @number0/iroh@1.1.0`, then `node watch.mjs watchAddr`):

```js
// watch.mjs
import { Endpoint, presetMinimal } from '@number0/iroh';

const builder = Endpoint.builder();
presetMinimal(builder);
const ep = await builder.bind();
console.log('bound', ep.id().toString().slice(0, 10));

const which = process.argv[2] ?? 'watchAddr'; // watchAddr | watchHomeRelay | watchNetworkChange
try {
  const handle = ep[which](() => {});
  await new Promise((r) => setTimeout(r, 300));
  await handle.stop();
  console.log(which, 'ok');
} catch (error) {
  console.log(which, 'threw', error); // never reached
}
await ep.close();
```

The same thing happens on a connection (`node conn-watch.mjs watchPaths`):

```js
// conn-watch.mjs
import { Endpoint, presetMinimal } from '@number0/iroh';

const ALPN = [...Buffer.from('repro/1')];
const bind = async () => { const b = Endpoint.builder(); presetMinimal(b); b.alpns([ALPN]); return b.bind(); };
const a = await bind();
const b = await bind();
const accepted = (async () => (await (await a.acceptNext()).accept()).connect())();
const conn = await b.connect(a.addr(), ALPN);
await accepted;
console.log('connected, paths():', conn.paths().length); // polling works

const which = process.argv[2] ?? 'watchPaths'; // watchPaths | watchPathEvents
const handle = conn[which](() => {});
await new Promise((r) => setTimeout(r, 300));
await handle.stop();
await a.close();
await b.close();
console.log(which, 'ok');
```

**Expected:** the call returns a `WatchHandle`, the callback fires when the value changes, and
`handle.stop()` ends the watch. If the watch cannot start, the method throws a JS error.

**Actual** (`watchAddr`; the other four differ only in the line of `watch.rs`: 50, 65, 78, 103):

```
bound 9cd093f777
thread '<unnamed>' panicked at iroh-js/src/watch.rs:35:16:
there is no reactor running, must be called from the context of a Tokio 1.x runtime
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
fatal runtime error: failed to initiate panic, error 5, aborting
```

Exit code 134 (SIGABRT).

**Likely cause:** in `src/endpoint.rs`, `watch_addr`, `watch_home_relay` and the other `watch*`
methods are synchronous `#[napi]` functions. They call `watch::spawn_*`, which calls
`n0_future::task::spawn` (`tokio::spawn`). A synchronous napi function runs on the JS thread, outside
the Tokio runtime, so `tokio::spawn` panics. Spawning on napi's runtime
(`napi::bindgen_prelude::spawn`), entering a runtime handle first, or making the methods `async`
would probably fix it. A test that calls each `watch*` method once would have caught it.

**Workaround in Claudio:**

- Claudio calls no `watch*` method. It polls `endpoint.addr()` / `addr.relayUrl()` and
  `conn.paths()` / `conn.rtt()` on a timer: `poll()` and `reportPeer()` in
  `packages/core/src/collab/host/host.ts`, with the interval `pollMs` in
  `packages/core/src/collab/host/protocol.ts`.
- The endpoint lives in a child process of its own (`packages/core/src/collab/host/`), so an abort
  ends only that process. The core then restarts it and reports it (`packages/core/src/collab/host-client.ts`).
- A test (`nothing calls a watch* method of the binding` in
  `packages/core/test/collab-isolation.test.ts`) fails if a `watch*` call appears anywhere.

---

## Issue 2

**Title:** `@number0/iroh` 1.1.0: byte parameters accept only `Array<number>`. `Buffer` and
`Uint8Array` fail with "Failed to get Array length".

**Version:** `@number0/iroh` 1.1.0 (`@number0/iroh-linux-x64-gnu` 1.1.0), Node 22.21.1, Linux
x86_64 glibc.

**What happens:** every byte parameter is declared in `index.d.ts` as `Array<number>`, from
`Vec<u8>` in Rust. This includes `SendStream.writeAll` / `write`, `SecretKey.sign`,
`EndpointId.verify` and the `fromBytes` constructors. Passing a `Buffer` or a `Uint8Array` throws
`Failed to get Array length`. Byte results (`readExact`, `readToEnd`, `toBytes`) come back as
`Array<number>` as well.

The types do say `Array<number>`, so this is not a mismatch with the docs. It is a problem with the
choice of type:

- Node's own byte type is `Buffer`, and every Node API that produces bytes (`fs`, `crypto`, `zlib`,
  sockets) gives one.
- Turning one into a JS array of numbers costs more than the network transfer itself. C0 measured
  `Array.from` of 4 MiB at 586 ms, against 32 ms for `Uint8Array.from` the other way.
- A loopback stream with `Array<number>` writes reached 10–42 Mbit/s, depending on the write size.
  TCP over loopback on the same machine reached 3954 Mbit/s.

**Minimal reproduction** (`npm install @number0/iroh@1.1.0`, then `node bytes.mjs`):

```js
// bytes.mjs
import { Endpoint, presetMinimal, SecretKey } from '@number0/iroh';

const inputs = (bytes) => [['Array', [...bytes]], ['Buffer', Buffer.from(bytes)], ['Uint8Array', new Uint8Array(bytes)]];

const key = SecretKey.generate();
for (const [name, msg] of inputs([104, 105])) {
  try { key.sign(msg); console.log('sign', name, 'ok'); }
  catch (e) { console.log('sign', name, 'threw:', e.message); }
}

const ALPN = [...Buffer.from('repro/1')];
const bind = async () => { const b = Endpoint.builder(); presetMinimal(b); b.alpns([ALPN]); return b.bind(); };
const a = await bind();
const b = await bind();
const accepted = (async () => (await (await a.acceptNext()).accept()).connect())();
const conn = await b.connect(a.addr(), ALPN);
const server = await accepted;
for (const [name, data] of inputs([1, 2, 3])) {
  try {
    const bi = await conn.openBi();
    await bi.send.writeAll(data);
    await bi.send.finish();
    const got = await (await server.acceptBi()).recv.readToEnd(16);
    console.log('writeAll', name, 'ok, read back', Array.isArray(got) ? 'Array' : got.constructor.name, got.length);
  } catch (e) { console.log('writeAll', name, 'threw:', e.message); }
}
await a.close();
await b.close();
```

**Expected:** a `Buffer` or `Uint8Array` is accepted wherever bytes go in (napi-rs maps `Buffer`,
`Uint8Array` or `&[u8]` without copying element by element). Byte results come back as `Buffer` or
`Uint8Array`. If `Array<number>` must stay for compatibility, both kinds could be accepted
(`Either<Buffer, Vec<u8>>`).

**Actual:**

```
sign Array ok
sign Buffer threw: Failed to get Array length
sign Uint8Array threw: Failed to get Array length
writeAll Array ok, read back Array 3
writeAll Buffer threw: Failed to get Array length
writeAll Uint8Array threw: Failed to get Array length
```

**A related problem worth mentioning in the issue:** when a `writeAll` fails, the binding can also
leave a promise rejected with nothing handling it (`LocallyClosed`). In C0 this ended the test
process.

**Workaround in Claudio:**

- **Streams:** bytes go into the binding as `Array.from(...)`, in pieces of at most 1 MiB
  (`PIECE_BYTES` in `packages/core/src/collab/wire.ts`). They come back out with `Uint8Array.from(...)`:
  `write`, `readRequest` and the request path in `packages/core/src/collab/host/host.ts`. Blobs are
  sent only on demand and report their progress, which hides the slow writes (plan §3.2).
- **Signing:** Claudio does not use `SecretKey.sign` or `EndpointId.verify`. Roster signatures are
  made and checked with `node:crypto` Ed25519 over the same 32-byte seed the endpoint uses
  (`packages/core/src/collab/roster.ts`), so they verify on either side.
- **Secret key:** the seed is handed to the host as `number[]` (`secretKey` in
  `packages/core/src/collab/host/protocol.ts`, built in `packages/core/src/collab/service.ts`).
- **Unhandled rejections:** every promise from the binding is awaited inside a `try/catch` or has
  a `catch` attached (`quiet()` in `host.ts`).

---

## Seen while checking, not drafted

Loading the package prints a Node `DEP0128` warning: the `main` field of `@number0/iroh`'s
`package.json` is `iroh-js/index.js`, a path that is not in the published package, so Node falls
back to `index.js`. This is harmless, but it is a one-line fix and could go into either issue as a
note.

## When they are answered

Once a release fixes either issue, unpin `@number0/iroh` in `packages/core/package.json`:

- **Issue 1 fixed:** the polling may stay. Keep the `watch*` grep test until a watch has been tried
  in the host process.
- **Issue 2 fixed:** the `Array.from` conversions and the 1 MiB pieces in `host.ts` can go. Measure
  the throughput again with `collaborators-c0/spike/tput.mjs`.

## Related

[[plans/collaborators.md]] · [[collaborators.md]] · [[reports/collaborators-c0/README.md]] · [[requests.md]]
