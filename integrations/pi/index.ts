import { streamDevin } from "../../src/provider.ts";

const FABLE_VARIANTS = ["low", "medium", "high", "xhigh", "max"] as const;
const TOKEN_READER = new URL("./read-token.py", import.meta.url).pathname;

const models = FABLE_VARIANTS.map(effort => ({
	id: `claude-fable-5-1-${effort}`,
	name: `Claude Fable 5.1 · Devin · ${effort}`,
	reasoning: true,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
}));

/** Register verified Devin-origin Fable 5.1 routes separately from Cursor/9router. */
export default function (pi: any) {
	pi.registerProvider("devin", {
		name: "Devin subscription",
		baseUrl: "https://server.codeium.com",
		api: "devin-agent",
		apiKey: `!python3 ${TOKEN_READER}`,
		models,
		streamSimple: (model: any, context: any, options: any) => streamDevin(model, context, options),
	});
}
