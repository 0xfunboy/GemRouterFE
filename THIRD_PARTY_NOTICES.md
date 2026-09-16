# Third-party notices

## PiLink design reference

Historical attribution: the referenced MCP implementation now lives only on
`archive/widget-wake-probe-2026-09-16` (`83aac16`). It is absent from the active
Codex-provider source. The following notice is retained, not rewritten or revoked.

Upstream: `https://github.com/roccoangelella/PiLink`, commit `aa83d14e826cc7c38c6ac9bcc08da3ad30856f0b`.

The implementation review covered PiLink's `src/llm-gateway-mcp.ts`, `src/llm-gateway-store.ts`, `src/llm-gateway-protocol.ts`, `src/llm-gateway-api.ts`, gateway operations documents, tests, `LICENSE`, and `NOTICE.md`. Durable reverse-RPC state-machine concepts from `src/llm-gateway-store.ts` informed GemRouter's `src/llm/providers/chatgpt/store.ts`.

GemRouter substantially changes the design into a multi-worker SQLite schema with app/alias policy, OAuth resource grants, run-generation fencing, whole-exchange replay, synchronous HTTP cancellation, restart terminalization and no ambiguous stateful redelivery. No PiLink package, Pi Agent, or PiLink runtime is installed or executed by GemRouter.

PiLink's NOTICE identifies Rocco Angelella as creator and maintainer. PiLink is distributed under the following MIT license:

```text
MIT License

Copyright (c) 2026 PiLink contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Model Context Protocol TypeScript SDK

The archived MCP server and isolated smoke client used `@modelcontextprotocol/sdk`.
That dependency is removed from the active provider branch. See the archived
package's bundled license and upstream notices for its terms.
