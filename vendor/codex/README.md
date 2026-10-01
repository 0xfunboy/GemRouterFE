# Bundled official Codex runtime

Linux x86-64, official npm platform package `@openai/codex@0.159.3-linux-x64`.
The native executable is gzip-compressed and split into numbered 64 MiB chunks
to stay below Git hosting's per-blob size limit. A normal checkout is sufficient;
no VS Code extension, globally installed Codex, npm install script or Git LFS is
required. Authentication is never included.

`manifest.json` records the upstream npm SHA-512 integrity, the native SHA-256
and the concatenated gzip SHA-256. Startup checks archive and executable hashes.
The runtime is extracted into ignored `.runtime/codex/versions/` with owner-only
permissions. The active pointer and downloaded updates are also ignored.

License: Apache-2.0; see [upstream license](LICENSE). Official sources:
[npm package](https://www.npmjs.com/package/@openai/codex),
[OpenAI repository](https://github.com/openai/codex).

Maintainer refresh (deliberately not a normal install/build step):

```sh
node --import tsx scripts/vendor-codex.ts
```

Review the protocol restrictions and tests before changing the bundled version.
Dashboard updates use only official version-pinned registry tarballs, verify
SHA-512 before extraction and run an isolated, unauthenticated compatibility
probe. Existing account logins are never copied, embedded or replaced.
