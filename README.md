# pi-volcengine-provider

Volcengine ARK (Doubao) provider for [pi](https://github.com/badlogic/pi-mono).

Registers two OpenAI-compatible providers so you can use ByteDance's Doubao / Seed
model family from pi, including the Coding Plan subscription tier.

## Install

```bash
pi install git:github.com/edision/pi-volcengine-provider
```

Or, for local development:

```bash
git clone https://github.com/edision/pi-volcengine-provider
cd pi-volcengine-provider
npm install            # pulls pi type packages for editor LSP / `npm run typecheck`
pi install .
```

## Providers

| Provider id             | Base URL                                          | Use for                                          |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------ |
| `volcengine-ark`        | `https://ark.cn-beijing.volces.com/api/v3`        | Online inference — billed per token              |
| `volcengine-coding-plan`| `https://ark.cn-beijing.volces.com/api/coding/v3` | Coding Plan subscription — separate flat quota   |

Both speak the OpenAI Chat Completions protocol; we delegate to pi's built-in
`openai-completions` streaming implementation, so reasoning_effort, streaming,
tool calls, and image input all work out of the box.

> **Do NOT mix the two up.** The `volcengine-ark` (Online) provider hits
> `/api/v3`, which ARK bills per-token and **does NOT consume your Coding Plan
> quota**. Conversely, calling Coding Plan–eligible model names against
> `/api/v3` will succeed but charge you out-of-pocket. If you have a Coding
> Plan subscription, always pick `volcengine-coding-plan`.
> See: <https://www.volcengine.com/docs/82379/1928261>.

## Setup

1. Create an API key in the ARK console:
   <https://console.volcengine.com/ark/region:cn-beijing/api-key>
2. In pi:

   ```
   /login volcengine-ark          # online inference (billed per token)
   /login volcengine-coding-plan  # Coding Plan subscription (separate quota)
   ```

   Or set `ARK_API_KEY` in your environment and skip `/login`.

3. Pick a model — naming convention differs by provider:

   - **`volcengine-ark` (Online)** uses versioned hyphenated ids, e.g.
     `doubao-seed-2-1-pro-260628`. Bare names like `doubao-pro` 404.
   - **`volcengine-coding-plan`** uses bare names per the official Coding
     Plan guide, e.g. `doubao-seed-2.1-turbo`, `glm-5.2`, `kimi-k2.7-code`.

   ```
   /model volcengine-ark/doubao-seed-2-1-pro-260628
   /model volcengine-coding-plan/doubao-seed-2.1-turbo
   /model volcengine-coding-plan/ark-code-latest
   ```

## How the model list is populated

Volcengine exposes an OpenAI-compatible `GET /models` endpoint at both base URLs
with the same `Authorization: Bearer <ARK_API_KEY>` header as `/chat/completions`.
This extension wires pi's `refreshModels` hook to it:

1. **Seed list** — a small fallback set (`SEED_ONLINE_MODELS` /
   `SEED_CODING_PLAN_MODELS`) is registered up front so `/model` works even on
   the first run, before any network call, or while offline.
2. **Network refresh** — on every model refresh, `GET {baseUrl}/models` is hit
   with the resolved Bearer token (10 s timeout, honors pi's abort signal). The
   response is the standard OpenAI `ListModelsResponse`
   (`{ object: "list", data: [{ id, object, created, owned_by }, ...] }`).
3. **Known-model enrichment** — recognised ids in `KNOWN_MODEL_METADATA` get
   rich metadata (reasoning flag, vision support, context window, max output
   tokens). Unknown ids fall back to safe defaults so brand-new Doubao versions
   published by ARK appear in `/model` the moment they land — no PR needed.
4. **Cross-session cache** — successful refreshes are persisted via
   `context.publish({ persist: ... })` so subsequent pi sessions boot from the
   cached catalog and only re-hit the API when needed.

Failure handling: any refresh error (network, non-2xx, malformed body) logs a
single `console.warn` and falls back to the persisted catalog or seed list —
`refreshModels` never throws.

Official model documentation:

- <https://www.volcengine.com/docs/82379/1330310> (model list)
- <https://www.volcengine.com/docs/82379/1298459> (base URL & auth)

## The `developer` role fix

pi's built-in `openai-completions` stream sends the reasoning model's system
prompt as a `developer` message. Volcengine ARK only accepts the roles
`system`, `assistant`, `user`, and `tool`, and returns
`400 InvalidParameter: invalid value: 'developer'` otherwise. Both providers
register with `compat.supportsDeveloperRole: false`, so pi rewrites the role
to `system` and `reasoning_effort` still passes through unchanged.

## Models shipped (seed / fallback catalog)

### Online inference (`volcengine-ark`)

| Model id                                  | Reasoning | Vision | Context  |
| ----------------------------------------- | --------- | ------ | -------- |
| `doubao-seed-2-1-pro-260628`              | ✓         | ✓      | 256k     |
| `doubao-seed-2-1-turbo-260628`            | ✓         | ✓      | 256k     |
| `doubao-seed-2-0-pro-260215`              | ✓         | ✓      | 256k     |
| `doubao-seed-2-0-lite-260215`             |           | ✓      | 256k     |
| `doubao-seed-2-0-mini-260215`             |           |        | 128k     |
| `doubao-seed-2-0-code-preview-260215`     | ✓         |        | 256k     |
| `doubao-seed-1-8-251228`                  |           | ✓      | 128k     |
| `doubao-seed-1-6-250615`                  |           | ✓      | 128k     |
| `doubao-seed-1-6-thinking-250715`         | ✓         | ✓      | 128k     |
| `doubao-seed-evolving-latest-version`     | ✓         | ✓      | 256k     |

### Coding Plan (`volcengine-coding-plan`)

Per the official [Coding Plan guide](https://www.volcengine.com/docs/82379/1928261).
Limits and modalities are taken from the official opencode `volcengine-plan`
provider config (same ARK backend), not guessed.

| Model id                | Reasoning | Vision | Context | Output | Notes                                     |
| ----------------------- | --------- | ------ | ------- | ------ | ----------------------------------------- |
| `doubao-seed-2.1-turbo` | ✓         | ✓      | 256k    | 64k    |                                           |
| `doubao-seed-2.0-lite`  |           | ✓      | 256k    | 64k    |                                           |
| `minimax-m3`            | ✓         | ✓      | 1M      | 64k    |                                           |
| `glm-5.2`               | ✓         |        | 1M      | 64k    | `glm-latest` is an alias                  |
| `glm-latest`            | ✓         |        | 1M      | 64k    | alias for `glm-5.2`                       |
| `glm-5.3`               | ✓         |        | 1M      | 64k    |                                           |
| `deepseek-v4-flash`     | ✓         |        | 1M      | 64k    |                                           |
| `deepseek-v4-pro`       | ✓         |        | 1M      | 64k    |                                           |
| `kimi-k2.7-code`        | ✓         | ✓      | 256k    | 32k    |                                           |
| `ark-code-latest`       | ✓         | ✓      | 256k    | 32k    | switchable from the ARK console           |

Anything that shows up at `GET {baseUrl}/models` but isn't in the tables above
appears in `/model` with placeholder metadata (128k context, text-only,
non-reasoning). Add the id to `KNOWN_MODEL_METADATA` in `index.ts` to fill in
real capabilities — or open an issue and we'll add it.

## Notes

- Auth: `Authorization: Bearer <ARK_API_KEY>`. Same key works for both providers.
- Token usage and pricing are reported as zero in pi's TUI — fill in the `cost`
  block in `index.ts` with the rates from
  <https://www.volcengine.com/docs/82379/1544108> if you want accurate totals.
- Overflow errors (e.g. "context length exceeded") are normalised by a
  `message_end` handler so pi auto-compacts and retries.
- To force a fresh model list without restarting pi: run `/model` (it triggers
  the refresh) or `pi update --models`.

## License

MIT
