// Imported first by every entry of the server: libuv sizes its thread pool from this variable the
// first time the pool is used (a file read, a DNS lookup, a hash). In a bundle (`api.mjs`,
// `server.mjs`) this runs before any other code; under a loader such as tsx the module graph is
// loaded, through the pool, before any module runs, which is why the package's `dev` and `start`
// scripts set it in the environment too. A launcher and the desktop shell always do.
import { SERVER_THREADPOOL_SIZE } from '@claudio/core/launcher/protocol';

process.env.UV_THREADPOOL_SIZE ||= SERVER_THREADPOOL_SIZE;
