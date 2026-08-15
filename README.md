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
pi install .
```

## Providers

| Provider id             | Base URL                                                  | Use for                                          |
| ----------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| `volcengine-ark`        | `https://ark.cn-beijing.volces.com/api/v3`                | Online inference — billed per token              |
| `volcengine-coding-plan`| `https://ark.cn-beijing.volces.com/api/coding/v3`         | Coding Plan subscription — separate flat quota   |

Both speak the OpenAI Chat Completions protocol; we delegate to pi's built-in
`openai-completions` streaming implementation, so reasoning_effort, streaming,
tool calls, and image input all work out of the box.

## Setup

1. Create an API key in the ARK console:
   <https://console.volcengine.com/ark/region:cn-beijing/api-key>
2. Pick a model — full versioned IDs only (bare names like `doubao-pro` 404):

   ```
   /login volcengine-ark
   /model volcengine-ark/doubao-seed-2-1-pro-260628
   ```

   For Coding Plan:

   ```
   /login volcengine-coding-plan
   /model volcengine-coding-plan/ark-code-latest
   ```

   Or set `ARK_API_KEY` in your environment and skip `/login`.

## Models shipped

### Online inference

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

### Coding Plan

- `doubao-seed-2.0-code`
- `doubao-seed-2.0-pro`
- `doubao-seed-2.0-lite`
- `doubao-seed-code`
- `ark-code-latest` *(switchable from console — handy for trialing)*

If a new versioned model lands on the console and isn't listed above, either
add it to `index.ts` or use a custom endpoint id from the console directly via
pi's `/model` selector.

## Notes

- Auth: `Authorization: Bearer <ARK_API_KEY>`. Same key works for both providers.
- Token usage and pricing are reported as zero in pi's TUI — fill in the `cost`
  block in `index.ts` with the rates from
  <https://www.volcengine.com/docs/82379/1544108> if you want accurate totals.
- Overflow errors (e.g. "context length exceeded") are normalised by a
  `message_end` handler so pi auto-compacts and retries.

## License

MIT