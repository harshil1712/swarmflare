# Swarmflare

Swarmflare is a Cloudflare-native demo of an AI chat agent that can split broad goals into a bounded swarm of specialist workers, run those workers in parallel, track progress live in the browser, and synthesize a final answer.

It is built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/), [Durable Objects](https://developers.cloudflare.com/durable-objects/), [Workers AI](https://developers.cloudflare.com/workers-ai/), React, Vite, and Kumo UI.

## What It Does

- **Normal chat**: streams assistant responses from a Workers AI model.
- **Automatic swarm mode**: broad prompts can trigger `startSwarm`, which creates 2-6 focused work units.
- **Parallel worker fibers**: each work unit runs as a managed Agents SDK fiber with checkpoints.
- **Live progress UI**: swarm state is persisted in the Agent and synced over the existing WebSocket connection.
- **Final synthesis**: the coordinator combines worker outputs into a single assistant follow-up message.
- **Inspectable runs**: the UI can inspect retained fiber state for swarm and worker details.
- **Image input**: users can attach PNG, JPEG, WebP, or GIF images for vision-capable chat turns.
- **MCP tools**: users can register MCP servers and make their tools available to the agent.

## Demo Boundaries

Swarmflare is intentionally scoped as an open-source demo, not a production multi-tenant app.

- The browser connects to `useAgent({ agent: "ChatAgent" })` without a custom `name`.
- That means all users of the same deployment share the default `ChatAgent` instance.
- Shared state includes chat history, swarm runs, MCP server registrations, and Durable Object state.
- There is no authentication, authorization, or per-user isolation in this demo.
- For production, add per-user or per-conversation Agent names and route-level authorization before launch.

## Current Limits

Application-level demo limits:

- Up to `3` active swarms at once.
- Up to `6` work units per swarm.
- Swarm goals up to `4,000` characters.
- Chat history persists up to `100` messages.
- Images per message: up to `4`.
- Image size: up to `5 MB` each and `12 MB` total per message.
- Supported image types: PNG, JPEG, WebP, GIF.

Platform limits and billing are controlled by your Cloudflare account and plan. Check the current Cloudflare docs before relying on specific numbers:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/)
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

## Runtime And Cost Notes

This project uses the Workers AI binding configured in `wrangler.jsonc`:

```jsonc
"ai": { "binding": "AI", "remote": true }
```

Because the binding is remote, local development can still call Cloudflare-hosted Workers AI and count against account usage or limits.

The current model is:

```ts
@cf/moonshotai/kimi-k2.6
```

A swarm can make multiple model calls: one chat turn to decide and start the swarm, one call per worker, and one synthesis call. MCP tools can add additional network calls depending on the connected servers.

## Quick Start

Install dependencies:

```bash
npm install
```

Run the local dev server:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

Try prompts like:

- `Compare three approaches for adding authentication to this app.`
- `Review this architecture and identify risks from security, UX, and operations perspectives.`
- `Plan a migration from a simple chat demo to a multi-user production deployment.`

For simple questions, the assistant should answer directly. For broader goals, it should start a swarm and later post a synthesized answer.

## Project Structure

```text
src/
  server.ts                ChatAgent, swarm orchestration, MCP, Workers AI calls
  chat/                    Chat UI, message rendering, image attachments
  mcp/                     MCP server panel
  swarm/types.ts           Swarm state and recovery snapshot types
  swarm/ui/                Swarm workspace and inspection UI
  app.tsx                  App shell
  client.tsx               React entry point
  styles.css               Tailwind and Kumo styles
```

## How The Swarm Works

1. The user sends a message through `useAgentChat`.
2. `ChatAgent.onChatMessage()` streams a Workers AI response.
3. If the request is broad enough, the model calls the `startSwarm` tool.
4. `startSwarm()` validates the goal and work units, then starts a managed `swarm-run` fiber.
5. The coordinator fiber starts one managed `swarm-worker` fiber per work unit.
6. Each worker generates structured output and checkpoints its status with `ctx.stash()`.
7. The coordinator polls retained worker fiber state, updates Agent state, and synthesizes a final answer.
8. The final synthesis is persisted as a follow-up assistant message.

The implementation uses public Agents SDK durable execution APIs such as `startFiber()`, `inspectFiberByKey()`, `cancelFiberByKey()`, `listFibers()`, and `deleteFibers()`.

## MCP Servers

The MCP panel lets users add server names and URLs at runtime. Registered MCP servers are part of the shared demo Agent state, so other users of the same deployment can see and use them.

The Agents SDK performs MCP connection and URL safety checks. This app should still be treated as a demo: do not register sensitive private MCP servers on a public shared deployment.

## Images

Images are converted to data URIs before being sent with the chat message. To keep the demo bounded, unsupported or oversized files are rejected in the browser before object URLs or data URIs are created.

If you need production-grade file handling, store uploads in a dedicated object store such as R2 and pass references to the model instead of persisting large data URIs in chat state.

## Useful Commands

```bash
npm run dev       # Start the Vite dev server
npm run deploy    # Build and deploy with Wrangler
npm run types     # Regenerate Cloudflare environment types
npm run format    # Format the repo with oxfmt
npm run lint      # Run oxlint on src/
npm run check     # Format check, lint, and TypeScript check
```

Run `npm run types` after changing Cloudflare bindings in `wrangler.jsonc`.

## Deploy

Before deploying your fork, set the Worker `name` in `wrangler.jsonc` to the deployment name you want.

Deploy with:

```bash
npm run deploy
```

The deployed app runs as a Worker with static assets and a SQLite-backed Durable Object binding for `ChatAgent`.

## Production Hardening Checklist

Swarmflare intentionally leaves these concerns out of the demo:

- Per-user or per-conversation Agent instance names.
- Authentication and authorization.
- Tenant-isolated MCP registrations.
- Stronger server-side MCP registration policy.
- File upload storage outside chat payloads.
- Rate limiting and abuse controls.
- End-to-end smoke tests for swarm start, cancel, clear, and inspect flows.

## Learn More

- [Agents SDK documentation](https://developers.cloudflare.com/agents/)
- [Agents API reference](https://developers.cloudflare.com/agents/api-reference/agents-api/)
- [Durable execution](https://developers.cloudflare.com/agents/api-reference/durable-execution/)
- [Store and sync state](https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/)
- [MCP Client API](https://developers.cloudflare.com/agents/api-reference/mcp-client-api/)
- [Workers AI models](https://developers.cloudflare.com/workers-ai/models/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)

## License

MIT. See [LICENSE](./LICENSE).
