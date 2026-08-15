/**
 * Volcengine ARK (Doubao) Provider Extension for pi
 *
 * Registers two OpenAI-compatible providers:
 *   - volcengine-ark         → online inference at https://ark.cn-beijing.volces.com/api/v3
 *   - volcengine-coding-plan → Coding Plan subscription at https://ark.cn-beijing.volces.com/api/coding/v3
 *
 * Auth is a single ARK_API_KEY from the console:
 *   https://console.volcengine.com/ark/region:cn-beijing/api-key
 *
 * Model catalog strategy:
 *   1. SEED_* lists are registered up front so /model works immediately, even offline.
 *   2. refreshModels() hits the official OpenAI-compatible GET {baseUrl}/models endpoint
 *      with the resolved Bearer token. This is the same shape as OpenAI's /v1/models:
 *      { object: "list", data: [{ id, object, created, owned_by }, ...] }.
 *   3. KNOWN_MODEL_METADATA enriches recognized ids with reasoning/vision/context/maxTokens;
 *      unrecognized ids get safe defaults so brand-new Doubao versions surface in /model
 *      the moment they're published.
 *   4. The fetched catalog is persisted via context.publish({ persist }) so subsequent
 *      sessions boot from cache and only re-hit the API when allowed.
 *
 * Why the `compat.supportsDeveloperRole: false` provider-level override:
 *   pi's openai-completions stream sends reasoning-capable models' system prompt as a
 *   `developer` message. Volcengine ARK only accepts {system, assistant, user, tool} and
 *   returns 400 InvalidParameter for `developer`. The override rewrites the role to
 *   `system` while leaving reasoning_effort handling intact.
 *
 * Usage:
 *   /login volcengine-ark          # online inference (billed per token)
 *   /login volcengine-coding-plan  # Coding Plan subscription (separate quota)
 *   ...or set ARK_API_KEY in the environment.
 *
 *   /model volcengine-ark/doubao-seed-2-1-pro-260628
 *   /model volcengine-coding-plan/ark-code-latest
 *
 * Model IDs MUST be the full versioned id from the console (bare names like "doubao-pro"
 * 404). The catalog also surfaces whatever /api/v3/models returns, so brand-new versions
 * are available before we add them here.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARK_ONLINE_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const ARK_CODING_BASE = "https://ark.cn-beijing.volces.com/api/coding/v3";
const MODELS_PATH = "/models";
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Known-model metadata
//
// ARK's OpenAI-compatible /api/v3/models returns only { id, object, created, owned_by }
// — no per-model context window, reasoning flag, or vision capability. We maintain a
// lookup table for the models we recognize so they show up with rich metadata in /model
// and in usage reporting. Unknown ids fall back to ArkModelDefault so a freshly-released
// Doubao version becomes selectable the moment ARK publishes it (better to show a model
// with placeholder metadata than to hide it entirely).
// ---------------------------------------------------------------------------

type ArkModelMeta = {
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
	maxTokens: number;
};

const KNOWN_MODEL_METADATA: Record<string, ArkModelMeta> = {
	// ---- Doubao-Seed 2.1 series (2026) ----
	"doubao-seed-2-1-pro-260628": {
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256_000,
		maxTokens: 32_000,
	},
	"doubao-seed-2-1-turbo-260628": {
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256_000,
		maxTokens: 32_000,
	},

	// ---- Doubao-Seed 2.0 series (2026) ----
	"doubao-seed-2-0-pro-260215": {
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256_000,
		maxTokens: 32_000,
	},
	"doubao-seed-2-0-lite-260215": {
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 256_000,
		maxTokens: 32_000,
	},
	"doubao-seed-2-0-mini-260215": {
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_000,
	},
	"doubao-seed-2-0-code-preview-260215": {
		reasoning: true,
		input: ["text"],
		contextWindow: 256_000,
		maxTokens: 32_000,
	},

	// ---- Doubao-Seed 1.x legacy (still on the menu) ----
	"doubao-seed-1-8-251228": {
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 16_000,
	},
	"doubao-seed-1-6-250615": {
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 16_000,
	},
	"doubao-seed-1-6-thinking-250715": {
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 128_000,
		maxTokens: 16_000,
	},

	// ---- Always-latest alias ----
	"doubao-seed-evolving-latest-version": {
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256_000,
		maxTokens: 32_000,
	},

	// ---- Coding Plan tier (also reachable via /api/v3/models on the online endpoint) ----
	"doubao-seed-2.0-code": {
		reasoning: true,
		input: ["text"],
		contextWindow: 256_000,
		maxTokens: 32_000,
	},
	"doubao-seed-2.0-pro": {
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256_000,
		maxTokens: 32_000,
	},
	"doubao-seed-2.0-lite": {
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 256_000,
		maxTokens: 32_000,
	},
	"doubao-seed-code": {
		reasoning: true,
		input: ["text"],
		contextWindow: 256_000,
		maxTokens: 32_000,
	},
	"ark-code-latest": {
		reasoning: true,
		input: ["text"],
		contextWindow: 256_000,
		maxTokens: 32_000,
	},
};

// Default metadata applied to any id not in KNOWN_MODEL_METADATA. Conservative: text-only,
// no reasoning flag (since we can't tell from the listing). The user gets the model in the
// picker; pi will surface a clearer error if the model turns out to be reasoning-only.
const DEFAULT_MODEL_META: ArkModelMeta = {
	reasoning: false,
	input: ["text"],
	contextWindow: 128_000,
	maxTokens: 16_000,
};

function metadataFor(id: string): ArkModelMeta {
	return KNOWN_MODEL_METADATA[id] ?? DEFAULT_MODEL_META;
}

// ---------------------------------------------------------------------------
// Seed / fallback catalogs
//
// Registered up front so /model works before the network refresh completes (or forever, if
// the user is offline). ARK_MODELS_ONLINE mirrors what /api/v3/models returns today so the
// transition from "seed list" to "refreshed catalog" is invisible.
// ---------------------------------------------------------------------------

const SEED_ONLINE_MODELS = [
	"doubao-seed-2-1-pro-260628",
	"doubao-seed-2-1-turbo-260628",
	"doubao-seed-2-0-pro-260215",
	"doubao-seed-2-0-lite-260215",
	"doubao-seed-2-0-mini-260215",
	"doubao-seed-2-0-code-preview-260215",
	"doubao-seed-1-8-251228",
	"doubao-seed-1-6-250615",
	"doubao-seed-1-6-thinking-250715",
	"doubao-seed-evolving-latest-version",
];

const SEED_CODING_PLAN_MODELS = [
	"doubao-seed-2.0-code",
	"doubao-seed-2.0-pro",
	"doubao-seed-2.0-lite",
	"doubao-seed-code",
	"ark-code-latest",
];

// ---------------------------------------------------------------------------
// Provider config shape (shared by both providers)
//
// compat.supportsDeveloperRole: false  ← THE FIX for the 400 InvalidParameter error.
// compat.supportsStore: false         ← ARK ignores/rejects `store` on chat completions.
// compat.supportsReasoningEffort: true ← ARK does accept reasoning_effort (pi maps the
//   "thinking" cycle to it). Per-model override below.
// compat.maxTokensField: "max_completion_tokens" ← matches the OpenAI Chat Completions
//   contract that ARK implements.
// ---------------------------------------------------------------------------

function arkCompat(reasoning: boolean) {
	return {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: reasoning,
		thinkingFormat: "openai" as const,
		maxTokensField: "max_completion_tokens" as const,
	};
}

// ---------------------------------------------------------------------------
// /api/v3/models fetch + mapping
// ---------------------------------------------------------------------------

type ArkListResponse = {
	object: "list";
	data: Array<{
		id: string;
		object?: string;
		created?: number;
		owned_by?: string;
	}>;
};

function isPlausibleArkModelId(id: unknown): id is string {
	if (typeof id !== "string") return false;
	const trimmed = id.trim();
	if (!trimmed) return false;
	// ARK ids are versioned slugs like "doubao-seed-2-1-pro-260628" or "doubao-seed-2.0-code".
	// Allow alphanumerics, dots, underscores, dashes. Reject anything with whitespace or
	// weird unicode so a malformed response can't poison the catalog.
	return /^[A-Za-z0-9._-]{2,128}$/.test(trimmed);
}

async function fetchArkModelIds(
	baseUrl: string,
	apiKey: string,
	signal: AbortSignal,
): Promise<string[]> {
	const url = `${baseUrl}${MODELS_PATH}`;
	const res = await fetch(url, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
		},
		signal,
	});
	if (!res.ok) {
		throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
	}
	const body = (await res.json()) as Partial<ArkListResponse>;
	if (!body || body.object !== "list" || !Array.isArray(body.data)) {
		throw new Error(
			`GET ${url} → unexpected response shape (missing object:"list" or data[])`,
		);
	}
	const ids = body.data.map((m) => m?.id).filter(isPlausibleArkModelId);
	// De-dupe while preserving the API's ordering (typically newest first).
	return Array.from(new Set(ids));
}

// ---------------------------------------------------------------------------
// refreshModels factory
//
// Behavior:
//   1. If context.stored has our provider's models → restore them to the in-memory list so
//      they are immediately visible (offline boot, fast startup).
//   2. If context.allowNetwork is true AND the credential is an api_key → fetch fresh ids
//      from GET {baseUrl}/models. On success, build a new ProviderModelConfig[], publish
//      with persist so subsequent sessions boot from cache, and return the new list.
//   3. On any fetch failure (network error, non-2xx, parse error) → log a single warning to
//      stderr and return whichever list we already have (stored or seed). Never throw:
//      refreshModels failures shouldn't take down the model picker.
// ---------------------------------------------------------------------------

function makeRefreshModels(opts: {
	providerId: string;
	baseUrl: string;
	seedIds: readonly string[];
}) {
	const { providerId, baseUrl, seedIds } = opts;

	return async function refreshModels(context: RefreshModelsContext) {
		// Restore persisted catalog first (cheap, works offline).
		const storedModels = context.stored?.models?.filter(
			(m) => m.provider === providerId,
		);

		if (!context.allowNetwork || context.signal.aborted) {
			return toProviderConfigs(storedModels?.map((m) => m.id) ?? [...seedIds]);
		}

		const credential = context.credential;
		if (!credential || credential.type !== "api_key" || !credential.key) {
			return toProviderConfigs(storedModels?.map((m) => m.id) ?? [...seedIds]);
		}

		// Bound the fetch so a hung ARK edge doesn't block /model forever. The outer
		// context.signal still wins: AbortError propagates and we fall back cleanly.
		const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
		const combined = AbortSignal.any([context.signal, timeout]);

		let ids: string[];
		try {
			ids = await fetchArkModelIds(baseUrl, credential.key, combined);
		} catch (err) {
			if (context.signal.aborted)
				return toProviderConfigs(storedModels?.map((m) => m.id) ?? [...seedIds]);
			const reason = err instanceof Error ? err.message : String(err);
			console.warn(
				`[${providerId}] refreshModels: ${reason}; falling back to cached/seed catalog`,
			);
			return toProviderConfigs(storedModels?.map((m) => m.id) ?? [...seedIds]);
		}

		if (context.signal.aborted)
			return toProviderConfigs(storedModels?.map((m) => m.id) ?? [...seedIds]);

		const fresh = toProviderConfigs(ids);

		// Persist across sessions. Pass full Model<Api> shape (with provider/api/baseUrl
		// populated) so the next session's context.stored matches what getModels returns.
		const persisted = ids.map((id) => ({
			...toProviderConfig(id),
			provider: providerId,
			api: "openai-completions" as const,
			baseUrl,
		}));
		await context.publish({
			persist: { models: persisted, checkedAt: Date.now() },
		});

		return fresh;
	};

	function toProviderConfig(id: string) {
		const meta = metadataFor(id);
		return {
			id,
			name: id,
			reasoning: meta.reasoning,
			input: meta.input,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: meta.contextWindow,
			maxTokens: meta.maxTokens,
			compat: arkCompat(meta.reasoning),
		};
	}

	function toProviderConfigs(ids: readonly string[]) {
		// Stable order: de-dupe + preserve input order. Filter empties defensively.
		const seen = new Set<string>();
		const out = [] as ReturnType<typeof toProviderConfig>[];
		for (const id of ids) {
			const trimmed = id.trim();
			if (!trimmed || seen.has(trimmed)) continue;
			seen.add(trimmed);
			out.push(toProviderConfig(trimmed));
		}
		return out;
	}
}

// ---------------------------------------------------------------------------
// Overflow detection
//
// pi auto-compacts + retries when errorMessage starts with a phrase it recognises.
// Volcengine's overflow phrases are translated here so they trigger the same path.
// Scope the rewrite strictly to our providers so we never touch errors from other
// providers.
// ---------------------------------------------------------------------------

const ARK_OVERFLOW_PATTERN =
	/context.{0,20}length.{0,20}(exceeded|too long)|maximum context length|prompt is too long/i;

function isOurProvider(provider: string | undefined) {
	return provider === "volcengine-ark" || provider === "volcengine-coding-plan";
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const onlineRefresh = makeRefreshModels({
		providerId: "volcengine-ark",
		baseUrl: ARK_ONLINE_BASE,
		seedIds: SEED_ONLINE_MODELS,
	});

	const codingRefresh = makeRefreshModels({
		providerId: "volcengine-coding-plan",
		baseUrl: ARK_CODING_BASE,
		seedIds: SEED_CODING_PLAN_MODELS,
	});

	// Online inference — billed per token
	pi.registerProvider("volcengine-ark", {
		name: "Volcengine ARK (Online)",
		baseUrl: ARK_ONLINE_BASE,
		apiKey: "$ARK_API_KEY",
		api: "openai-completions",
		models: SEED_ONLINE_MODELS.map((id) => {
			const meta = metadataFor(id);
			return {
				id,
				name: id,
				reasoning: meta.reasoning,
				input: meta.input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: meta.contextWindow,
				maxTokens: meta.maxTokens,
				compat: arkCompat(meta.reasoning),
			};
		}),
		refreshModels: onlineRefresh,
	});

	// Coding Plan subscription — separate quota, different model set
	pi.registerProvider("volcengine-coding-plan", {
		name: "Volcengine ARK (Coding Plan)",
		baseUrl: ARK_CODING_BASE,
		apiKey: "$ARK_API_KEY",
		api: "openai-completions",
		models: SEED_CODING_PLAN_MODELS.map((id) => {
			const meta = metadataFor(id);
			return {
				id,
				name: id,
				reasoning: meta.reasoning,
				input: meta.input,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: meta.contextWindow,
				maxTokens: meta.maxTokens,
				compat: arkCompat(meta.reasoning),
			};
		}),
		refreshModels: codingRefresh,
	});

	// Normalize Volcengine overflow errors so pi auto-compacts and retries
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		if (message.stopReason !== "error") return;
		if (!isOurProvider(message.provider) && !isOurProvider(ctx.model?.provider))
			return;

		const err = message.errorMessage ?? "";
		if (err.includes("context_length_exceeded")) return; // already normalized
		if (!ARK_OVERFLOW_PATTERN.test(err)) return;

		return {
			message: { ...message, errorMessage: `context_length_exceeded: ${err}` },
		};
	});
}
