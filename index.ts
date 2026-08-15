/**
 * Volcengine ARK (Doubao) Provider Extension for pi
 *
 * Registers two providers:
 *   - volcengine-ark         → online inference at https://ark.cn-beijing.volces.com/api/v3
 *   - volcengine-coding-plan → Coding Plan subscription at https://ark.cn-beijing.volces.com/api/coding/v3
 *
 * Both speak the OpenAI Chat Completions protocol, so we delegate to the built-in
 * openai-completions streaming API. Auth is a single ARK_API_KEY from the console.
 *
 * Usage:
 *   1. Create an API key in the Volcengine ARK console:
 *        https://console.volcengine.com/ark/region:cn-beijing/api-key
 *   2. In pi:
 *        /login volcengine-ark          # online inference (billed per token)
 *        /login volcengine-coding-plan  # Coding Plan subscription (separate quota)
 *      ...or set ARK_API_KEY in the environment.
 *   3. Pick a model with /model. Examples:
 *        volcengine-ark/doubao-seed-2-1-pro-260628
 *        volcengine-ark/doubao-seed-2-0-code-preview-260215
 *        volcengine-coding-plan/ark-code-latest
 *
 * Model IDs MUST be the full versioned id from the console (e.g. doubao-seed-2-0-pro-260215).
 * Bare names like "doubao-pro" 404. See:
 *   https://www.volcengine.com/docs/82379/1330310   (model list)
 *   https://www.volcengine.com/docs/82379/1298459   (base URL & auth)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARK_ONLINE_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const ARK_CODING_BASE = "https://ark.cn-beijing.volces.com/api/coding/v3";

// ---------------------------------------------------------------------------
// Models
//
// contextWindow / maxTokens are best-effort placeholders. If you hit an
// "context_length_exceeded" error in practice, tighten them for the offending
// model in the message_end handler below.
// ---------------------------------------------------------------------------

type ArkModel = {
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
};

const ARK_MODELS: ArkModel[] = [
	// ---- Doubao-Seed 2.1 series (2026) ----
	{ id: "doubao-seed-2-1-pro-260628",     name: "Doubao Seed 2.1 Pro",      reasoning: true,  input: ["text", "image"], contextWindow: 256_000, maxTokens: 32_000 },
	{ id: "doubao-seed-2-1-turbo-260628",   name: "Doubao Seed 2.1 Turbo",    reasoning: true,  input: ["text", "image"], contextWindow: 256_000, maxTokens: 32_000 },

	// ---- Doubao-Seed 2.0 series (2026) ----
	{ id: "doubao-seed-2-0-pro-260215",     name: "Doubao Seed 2.0 Pro",      reasoning: true,  input: ["text", "image"], contextWindow: 256_000, maxTokens: 32_000 },
	{ id: "doubao-seed-2-0-lite-260215",    name: "Doubao Seed 2.0 Lite",     reasoning: false, input: ["text", "image"], contextWindow: 256_000, maxTokens: 32_000 },
	{ id: "doubao-seed-2-0-mini-260215",    name: "Doubao Seed 2.0 Mini",     reasoning: false, input: ["text"],          contextWindow: 128_000, maxTokens: 16_000 },
	{ id: "doubao-seed-2-0-code-preview-260215", name: "Doubao Seed 2.0 Code (preview)", reasoning: true, input: ["text"],    contextWindow: 256_000, maxTokens: 32_000 },

	// ---- Doubao-Seed 1.x legacy (still on the menu) ----
	{ id: "doubao-seed-1-8-251228",         name: "Doubao Seed 1.8",          reasoning: false, input: ["text", "image"], contextWindow: 128_000, maxTokens: 16_000 },
	{ id: "doubao-seed-1-6-250615",         name: "Doubao Seed 1.6",          reasoning: false, input: ["text", "image"], contextWindow: 128_000, maxTokens: 16_000 },
	{ id: "doubao-seed-1-6-thinking-250715",name: "Doubao Seed 1.6 Thinking", reasoning: true,  input: ["text", "image"], contextWindow: 128_000, maxTokens: 16_000 },

	// ---- Always-latest alias ----
	{ id: "doubao-seed-evolving-latest-version", name: "Doubao Seed Evolving (latest)", reasoning: true, input: ["text", "image"], contextWindow: 256_000, maxTokens: 32_000 },
];

// Models available on the Coding Plan subscription tier (subset).
// Note: ark-code-latest lets you switch the active model from the console without
// touching pi config — useful for trialing different backends.
const CODING_PLAN_MODELS: ArkModel[] = [
	{ id: "doubao-seed-2.0-code",           name: "Doubao Seed 2.0 Code (Plan)",  reasoning: true,  input: ["text"],          contextWindow: 256_000, maxTokens: 32_000 },
	{ id: "doubao-seed-2.0-pro",            name: "Doubao Seed 2.0 Pro (Plan)",   reasoning: true,  input: ["text", "image"], contextWindow: 256_000, maxTokens: 32_000 },
	{ id: "doubao-seed-2.0-lite",           name: "Doubao Seed 2.0 Lite (Plan)",  reasoning: false, input: ["text", "image"], contextWindow: 256_000, maxTokens: 32_000 },
	{ id: "doubao-seed-code",               name: "Doubao Seed Code (Plan)",      reasoning: true,  input: ["text"],          contextWindow: 256_000, maxTokens: 32_000 },
	{ id: "ark-code-latest",                name: "ark-code-latest (switchable)", reasoning: true,  input: ["text"],          contextWindow: 256_000, maxTokens: 32_000 },
];

// ---------------------------------------------------------------------------
// Model → pi ProviderModelConfig mapping
// ---------------------------------------------------------------------------

function toProviderModels(models: ArkModel[]) {
	return models.map((m) => ({
		id: m.id,
		name: m.name,
		reasoning: m.reasoning,
		input: m.input,
		// No public list price for all tiers; leave zeros and override per-model
		// once you know the rates from https://www.volcengine.com/docs/82379/1544108
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		compat: {
			supportsReasoningEffort: m.reasoning,   // maps pi thinking → reasoning_effort
			thinkingFormat: "openai" as const,       // sends { reasoning_effort: "low"|"medium"|"high" }
			maxTokensField: "max_completion_tokens" as const,
		},
	}));
}

// ---------------------------------------------------------------------------
// Overflow detection
//
// pi auto-compacts + retries when errorMessage starts with a phrase it
// recognises. Volcengine's overflow phrases are translated here so they
// trigger the same path. Scope the rewrite strictly to our providers so we
// never touch errors from other providers.
// ---------------------------------------------------------------------------

const ARK_OVERFLOW_PATTERN = /context.{0,20}length.{0,20}(exceeded|too long)|maximum context length|prompt is too long/i;

function isOurProvider(provider: string | undefined) {
	return provider === "volcengine-ark" || provider === "volcengine-coding-plan";
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Online inference — billed per token
	pi.registerProvider("volcengine-ark", {
		baseUrl: ARK_ONLINE_BASE,
		apiKey: "$ARK_API_KEY",
		api: "openai-completions",
		models: toProviderModels(ARK_MODELS),
	});

	// Coding Plan subscription — separate quota, different model set
	pi.registerProvider("volcengine-coding-plan", {
		name: "Volcengine ARK (Coding Plan)",
		baseUrl: ARK_CODING_BASE,
		apiKey: "$ARK_API_KEY",
		api: "openai-completions",
		models: toProviderModels(CODING_PLAN_MODELS),
	});

	// Normalize Volcengine overflow errors so pi auto-compacts and retries
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "error") return;
		if (!isOurProvider(message.provider) && !isOurProvider(ctx.model?.provider)) return;

		const err = message.errorMessage ?? "";
		if (err.includes("context_length_exceeded")) return; // already normalized
		if (!ARK_OVERFLOW_PATTERN.test(err)) return;

		return { message: { ...message, errorMessage: `context_length_exceeded: ${err}` } };
	});
}