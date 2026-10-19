# Bundle signing keys

Public Ed25519 keys (PEM, SPKI) as `*.pub`. The image copies them to `/app/keys`, root-owned and
read-only, and the launcher and the server accept a Claudio update only if its manifest is signed by
one of them. The matching private key is the secret `CLAUDIO_BUNDLE_SIGNING_KEY` of the GitHub
Environment `release`.

To rotate: add the new public key here and ship it in an image first, then switch the secret. Remove
the old key once no image that should still update carries only that one.

Without a `*.pub` file the image offers no in-app update and the Updates card shows host commands
(`unsupportedReason: 'no-keys'`).
