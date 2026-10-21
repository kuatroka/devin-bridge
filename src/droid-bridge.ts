import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { streamDevin } from "./provider.ts";

const HOST = "127.0.0.1";
const PORT = 20130;
const DEVIN_BASE_URL = "https://server.codeium.com";
const CREDENTIALS_PATH = "/Users/yo_macbook/.local/share/devin/credentials.toml";
const DEVIN_MAX_TOKENS = 128_000;
const FABLE_VARIANTS = ["low", "medium", "high", "xhigh", "max"] as const;
const HAIKU_VARIANTS = ["low", "medium", "high", "xhigh", "max"] as const;
const SWE_2_VARIANTS = ["medium", "high", "max"] as const;
// DeepSeek V4.1 Flash is served directly by Devin. The 1017 uids are the
// real Devin model identifiers; the earlier "no DeepSeek" comment was stale.
const DEEPSEEK_IDS = [
	"deepseek-v4.1-flash",
	"deepseek-v4.1-flash-none",
	"deepseek-v4.1-flash-high",
	"deepseek-v4.1-flash-max",
] as const;
const DEEPSEEK_DEVIN_UIDS: Record<string, string> = {
	"deepseek-v4.1-flash": "deepseek-v4-1-flash-1017-low",
	"deepseek-v4.1-flash-none": "deepseek-v4-1-flash-1017-none",
	"deepseek-v4.1-flash-high": "deepseek-v4-1-flash-1017-high",
	"deepseek-v4.1-flash-max": "deepseek-v4-1-flash-1017-max",
};
// Amp refuses to route Claude-named model IDs through a Custom URL connection,
// so expose the same Haiku 5.5 effort variants under a Claude-free alias.
const HAIKU_ALIASES: Record<string, string> = Object.fromEntries(
	HAIKU_VARIANTS.map(variant => [`haiku-5-5-${variant}`, `claude-haiku-5-5-${variant}`]),
);
const MODEL_IDS = [
	...FABLE_VARIANTS.map(variant => `claude-fable-5-1-${variant}`),
	...HAIKU_VARIANTS.map(variant => `claude-haiku-5-5-${variant}`),
	...Object.keys(HAIKU_ALIASES),
	...SWE_2_VARIANTS.map(variant => `swe-2-${variant}`),
	...DEEPSEEK_IDS,
] as const;
const ROUTER_BASE_URL = "http://127.0.0.1:20128/v1";
const ROUTER_DB_PATH = "/Users/yo_macbook/.9router/db/data.sqlite";

function readToken(): string {
	const text = requireText(CREDENTIALS_PATH);
	const match = text.match(/^windsurf_api_key\s*=\s*"((?:\\.|[^"\\])*)"\s*$/m);
	if (!match) throw new Error("windsurf_api_key is missing from Devin credentials");
	return match[1].replace(/\\(["\\])/g, "$1");
}

let cachedRouterKey: string | undefined;
function readRouterKey(): string {
	if (cachedRouterKey) return cachedRouterKey;
	const db = new Database(ROUTER_DB_PATH, { readonly: true });
	try {
		const row = db.query("SELECT key FROM apiKeys WHERE isActive = 1 ORDER BY (name = 'Default Key') DESC, createdAt ASC LIMIT 1").get() as { key: string } | null;
		if (!row?.key) throw new Error("no active 9Router API key found");
		cachedRouterKey = row.key;
		return row.key;
	} finally {
		db.close();
	}
}

function requireText(path: string): string {
	return readFileSync(path, "utf8");
}

function textParts(value: unknown): { type: "text"; text: string }[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) return [];
	const result: { type: "text"; text: string }[] = [];
	for (const part of value) {
		if (!part || typeof part !== "object") continue;
		const p = part as Record<string, any>;
		if (p.type === "text" && typeof p.text === "string") result.push({ type: "text", text: p.text });
	}
	return result;
}

function imageAndTextParts(value: unknown): any[] {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (!Array.isArray(value)) return [];
	const result: any[] = [];
	for (const part of value) {
		if (!part || typeof part !== "object") continue;
		const p = part as Record<string, any>;
		if (p.type === "text" && typeof p.text === "string") {
			result.push({ type: "text", text: p.text });
			continue;
		}
		const url = p.image_url?.url;
		if (p.type === "image_url" && typeof url === "string" && url.startsWith("data:")) {
			const match = url.match(/^data:([^;,]+);base64,(.*)$/s);
			if (match) result.push({ type: "image", mimeType: match[1], data: match[2] });
		}
	}
	return result;
}

function parseArguments(value: unknown): Record<string, any> {
	if (typeof value !== "string") return value && typeof value === "object" ? value as Record<string, any> : {};
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function toPiMessages(rawMessages: unknown[], modelId: string): { systemPrompt?: string; messages: any[] } {
	const system: string[] = [];
	const messages: any[] = [];
	for (const raw of rawMessages) {
		if (!raw || typeof raw !== "object") continue;
		const input = raw as Record<string, any>;
		const role = input.role;
		if (role === "system" || role === "developer") {
			const parts = textParts(input.content);
			system.push(parts.map(part => part.text).join(""));
			continue;
		}
		if (role === "user") {
			messages.push({ role: "user", content: imageAndTextParts(input.content), timestamp: Date.now() });
			continue;
		}
		if (role === "assistant") {
			const content: any[] = [];
			for (const part of imageAndTextParts(input.content)) content.push(part);
			if (typeof input.reasoning_content === "string" && input.reasoning_content) {
				content.unshift({ type: "thinking", thinking: input.reasoning_content });
			}
			for (const call of input.tool_calls ?? []) {
				const fn = call?.function ?? call;
				if (!fn || typeof fn.name !== "string") continue;
				content.push({
					type: "toolCall",
					id: String(call.id ?? `call_${messages.length}`),
					name: fn.name,
					arguments: parseArguments(fn.arguments),
				});
			}
			if (content.length > 0) {
				messages.push({
					role: "assistant",
					content,
					api: "devin-agent",
					provider: "devin",
					model: modelId,
					timestamp: Date.now(),
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
				});
			}
			continue;
		}
		if (role === "tool") {
			messages.push({
				role: "toolResult",
				toolCallId: String(input.tool_call_id ?? "tool_call"),
				toolName: String(input.name ?? "tool"),
				content: textParts(input.content),
				isError: false,
				timestamp: Date.now(),
			});
		}
	}
	return { systemPrompt: system.length > 0 ? system.join("\n\n") : undefined, messages };
}

function toPiTools(rawTools: unknown): any[] | undefined {
	if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined;
	const tools: any[] = [];
	for (const raw of rawTools) {
		if (!raw || typeof raw !== "object") continue;
		const item = raw as Record<string, any>;
		const fn = item.type === "function" ? item.function : item;
		if (!fn || typeof fn.name !== "string") continue;
		tools.push({
			name: fn.name,
			description: typeof fn.description === "string" ? fn.description : "",
			parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
		});
	}
	return tools.length > 0 ? tools : undefined;
}

function modelFor(id: string): any {
	return {
		id,
		name: id.startsWith("swe-2-")
			? `SWE-2 ${id.split("-").at(-1)}`
			: id.startsWith("deepseek-")
				? `DeepSeek V4.1 Flash${id === "deepseek-v4.1-flash" ? "" : ` ${id.split("-").at(-1)}`}`
				: id.startsWith("claude-haiku-5-5-")
					? `Claude Haiku 5.5 ${id.split("-").at(-1)}`
					: `Claude Fable 5.1 ${id.split("-").at(-1)}`,
		api: "devin-agent",
		provider: "devin",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: DEVIN_MAX_TOKENS,
	};
}

function completion(message: any, requestedModel: string): Record<string, any> {
	const text = (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
	const thinking = (message.content ?? []).filter((part: any) => part.type === "thinking").map((part: any) => part.thinking).join("");
	const calls = (message.content ?? [])
		.filter((part: any) => part.type === "toolCall")
		.map((part: any) => ({ id: part.id, type: "function", function: { name: part.name, arguments: JSON.stringify(part.arguments ?? {}) } }));
	return {
		id: message.responseId ?? `devin-${crypto.randomUUID()}`,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model: requestedModel,
		choices: [{ index: 0, message: { role: "assistant", content: calls.length > 0 ? null : text || null, ...(thinking ? { reasoning_content: thinking } : {}), ...(calls.length > 0 ? { tool_calls: calls } : {}) }, finish_reason: calls.length > 0 ? "tool_calls" : message.stopReason === "length" ? "length" : "stop" }],
		usage: {
			prompt_tokens: message.usage?.input ?? 0,
			completion_tokens: message.usage?.output ?? 0,
			total_tokens: message.usage?.totalTokens ?? 0,
		},
	};
}

function sse(data: unknown): string {
	return `data: ${JSON.stringify(data)}\n\n`;
}

function sseDone(): string {
	return "data: [DONE]\n\n";
}

function completionChunks(message: any, requestedModel: string): Record<string, any>[] {
	const id = message.responseId ?? `devin-${crypto.randomUUID()}`;
	const created = Math.floor(Date.now() / 1000);
	const chunks: Record<string, any>[] = [];
	const chunk = (delta: Record<string, any>, finishReason: string | null = null, usage?: any) => ({
		id,
		object: "chat.completion.chunk",
		created,
		model: requestedModel,
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage ? { usage } : {}),
	});

	// Droid's OpenAI parser consumes streaming deltas. A full chat.completion
	// object wrapped in SSE has `message`, not `delta`, and is therefore treated
	// as an empty response even though curl can decode it.
	chunks.push(chunk({ role: "assistant", content: null }));
	let toolIndex = 0;
	for (const part of message.content ?? []) {
		if (part?.type === "thinking" && typeof part.thinking === "string" && part.thinking) {
			chunks.push(chunk({ reasoning_content: part.thinking }));
		} else if (part?.type === "text" && typeof part.text === "string" && part.text) {
			chunks.push(chunk({ content: part.text }));
		} else if (part?.type === "toolCall" && typeof part.name === "string") {
			chunks.push(chunk({
				tool_calls: [{
					index: toolIndex++,
					id: String(part.id ?? `call_${toolIndex}`),
					type: "function",
					function: {
						name: part.name,
						arguments: JSON.stringify(part.arguments ?? {}),
					},
				}],
			}));
		}
	}

	const hasToolCalls = toolIndex > 0;
	const usage = {
		prompt_tokens: message.usage?.input ?? 0,
		completion_tokens: message.usage?.output ?? 0,
		total_tokens: message.usage?.totalTokens ?? 0,
	};
	chunks.push(chunk({}, hasToolCalls ? "tool_calls" : message.stopReason === "length" ? "length" : "stop", usage));
	return chunks;
}

// DeepSeek V4.1 Flash goes straight to Devin via streamDevin; the 1017 uids
// in DEEPSEEK_DEVIN_UIDS are the real Devin model identifiers. No OpenCode
// pass-through is needed for these ids.
async function handleDevinCompletion(request: Request, body: Record<string, any>, requestedModel: string, modelId: string): Promise<Response> {
	try {
		const converted = toPiMessages(Array.isArray(body.messages) ? body.messages : [], modelId);
		const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens ?? DEVIN_MAX_TOKENS);
		const stop = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop : undefined;
		const devinUid = DEEPSEEK_DEVIN_UIDS[modelId] ?? modelId;
		const stream = streamDevin(modelFor(modelId), { systemPrompt: converted.systemPrompt, messages: converted.messages, tools: toPiTools(body.tools) }, {
			apiKey: readToken(),
			baseUrl: DEVIN_BASE_URL,
			maxTokens: Number.isFinite(maxTokens) ? Math.min(Math.max(1, maxTokens), DEVIN_MAX_TOKENS) : DEVIN_MAX_TOKENS,
			temperature: typeof body.temperature === "number" ? body.temperature : 0.4,
			topP: typeof body.top_p === "number" ? body.top_p : 1,
			stopSequences: stop,
			sessionId: request.headers.get("x-session-id") ?? body.user ?? crypto.randomUUID(),
			chatModelUid: devinUid,
		} as any);
		const message = await stream.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return Response.json({ error: { message: message.errorMessage ?? "Devin request failed", type: "server_error" } }, { status: 502 });
		}
		const result = completion(message, requestedModel);
		if (body.stream === false) return Response.json(result);
		const streamBody = completionChunks(message, requestedModel).map(sse).join("") + sseDone();
		return new Response(streamBody, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" } });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ error: { message, type: "server_error" } }, { status: 502 });
	}
}

async function handleCompletion(request: Request): Promise<Response> {
	let body: Record<string, any>;
	try {
		body = await request.json() as Record<string, any>;
	} catch {
		return Response.json({ error: { message: "Invalid JSON request", type: "invalid_request_error" } }, { status: 400 });
	}
	const requestedModel = typeof body.model === "string" ? body.model : "dv/claude-fable-5-1-low";
	const bareModelId = requestedModel
		.replace(/^dv\//, "")
		.replace(/^devin-fable-5-1-/, "claude-fable-5-1-");
	// Devin only exposes effort-suffixed Haiku IDs. Keep the old bare ID working
	// for existing clients by defaulting it to medium.
	const modelId = bareModelId === "claude-haiku-5-5"
		? "claude-haiku-5-5-medium"
		: HAIKU_ALIASES[bareModelId] ?? bareModelId;
	if (modelId in DEEPSEEK_DEVIN_UIDS) return handleDevinCompletion(request, body, requestedModel, modelId);
	if (!MODEL_IDS.includes(modelId as typeof MODEL_IDS[number])) {
		return Response.json({ error: { message: `Unsupported Devin model: ${requestedModel}`, type: "invalid_request_error" } }, { status: 400 });
	}
	try {
		const converted = toPiMessages(Array.isArray(body.messages) ? body.messages : [], modelId);
		const maxTokens = Number(body.max_completion_tokens ?? body.max_tokens ?? DEVIN_MAX_TOKENS);
		const stop = typeof body.stop === "string" ? [body.stop] : Array.isArray(body.stop) ? body.stop : undefined;
		const stream = streamDevin(modelFor(modelId), { systemPrompt: converted.systemPrompt, messages: converted.messages, tools: toPiTools(body.tools) }, {
			apiKey: readToken(),
			baseUrl: DEVIN_BASE_URL,
			maxTokens: Number.isFinite(maxTokens) ? Math.min(Math.max(1, maxTokens), DEVIN_MAX_TOKENS) : DEVIN_MAX_TOKENS,
			temperature: typeof body.temperature === "number" ? body.temperature : 0.4,
			topP: typeof body.top_p === "number" ? body.top_p : 1,
			stopSequences: stop,
			sessionId: request.headers.get("x-session-id") ?? body.user ?? crypto.randomUUID(),
		} as any);
		const message = await stream.result();
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return Response.json({ error: { message: message.errorMessage ?? "Devin request failed", type: "server_error" } }, { status: 502 });
		}
		const result = completion(message, requestedModel);
		if (body.stream === false) return Response.json(result);
		const streamBody = completionChunks(message, requestedModel).map(sse).join("") + sseDone();
		return new Response(streamBody, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" } });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return Response.json({ error: { message, type: "server_error" } }, { status: 502 });
	}
}

const server = Bun.serve({
	hostname: HOST,
	port: PORT,
	async fetch(request) {
		const url = new URL(request.url);
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" } });
		if (request.method === "GET" && url.pathname.endsWith("/models")) {
			return Response.json({ object: "list", data: MODEL_IDS.map(model => ({ id: `dv/${model}`, object: "model", created: 0, owned_by: "devin" })) });
		}
		if (request.method === "POST" && url.pathname.endsWith("/chat/completions")) return handleCompletion(request);
		return Response.json({ error: { message: "Not found", type: "invalid_request_error" } }, { status: 404 });
	},
});
console.log(`Devin Droid bridge listening on http://${HOST}:${server.port}/v1`);
