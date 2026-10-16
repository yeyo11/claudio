# Claudio Collaborators — C0 spike

Proves `@number0/iroh` for Claudio: a custom ALPN, direct and relay paths, blob throughput and soft loading.

    npm install
    node load-check.mjs                 # does the native module load here?
    node serve.mjs                      # machine A: prints tickets, waits for connections
    node client.mjs <ticket>            # machine B: connects and prints a JSON report

Presets: `n0` (default: n0 discovery + relays), `n0-no-relay`, `minimal` (no discovery, no relays: needs a direct-only ticket).
Env: `BLOB_MIB=8`, `WATCH_MS=8000`, `IROH_LOG=Info`.
