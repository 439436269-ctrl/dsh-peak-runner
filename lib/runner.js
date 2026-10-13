/**
 * The runner seam — the only place this plugin talks to a model.
 *
 * One streamed `ctx.llm.stream()` call per task prompt, assembled into text.
 * The reasoning knob defaults to `off` because the host's default (high) can
 * spend the whole output budget on the reasoning block and return an EMPTY
 * text block — a "successful" call that says nothing.
 *
 * @module dsh-peak-runner/runner
 */

import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

/**
 * Resolve the provider/model pair this plugin should call.
 *
 * @param ctx - host plugin context (needs the `llm` service).
 * @param settings - resolved plugin settings.
 * @returns the pair, or null when the host advertises no usable model.
 */
export async function resolveTarget(ctx, settings) {
	const provider = settings.provider;
	const model = settings.model;
	if (provider !== "" && model !== "") {
		try {
			await ctx.llm.resolveModelInfo(provider, model);
			return { provider, model, source: "config" };
		} catch {
			// Fall through to discovery: a profile without this provider is not an error.
		}
	}
	try {
		const providers = ctx.llm.listProviders() ?? [];
		for (const entry of providers) {
			const id = typeof entry === "string" ? entry : entry?.id;
			if (typeof id !== "string" || id === "") continue;
			const models = await ctx.llm.listModels(id);
			if (!Array.isArray(models)) continue;
			const first = models.find((candidate) => typeof candidate === "string" && candidate !== "");
			if (first !== undefined) return { provider: id, model: first, source: "auto" };
		}
	} catch {
		// No discovery either — report the absence instead of guessing.
	}
	return null;
}

/**
 * Describe an adapter failure in one short human-readable line.
 *
 * @param failure - the failure carried by the assembler's finish state.
 * @returns a message suitable for the queue log.
 */
export function describeFailure(failure) {
	if (failure === null || typeof failure !== "object") return "model call failed";
	const message = failure.message ?? failure.code ?? failure.kind;
	return typeof message === "string" && message !== "" ? message : "model call failed";
}

/**
 * Drive one streamed model call and return the assembled text.
 *
 * @param ctx - host plugin context.
 * @param options - `{ system, prompt, provider, model, maxTokens, temperature,
 *   reasoningEffort, signal }`.
 * @returns `{ ok: true, text, usage? }` or `{ ok: false, code, detail }`.
 */
export async function runPrompt(ctx, options) {
	const { system, prompt, provider, model, maxTokens, temperature, reasoningEffort, signal } = options;

	const attempt = async (effort) => {
		const assembler = new BlockAssembler();
		const config = {
			provider,
			model,
			...(system === undefined || system === "" ? {} : { system }),
			messages: [
				createUserMessage({
					content: [{ type: "text", text: prompt }],
					source: { kind: "user" },
				}),
			],
			...(temperature === undefined ? {} : { temperature }),
			...(maxTokens === undefined ? {} : { maxTokens }),
			...(signal === undefined ? {} : { signal }),
		};
		if (typeof effort === "string" && effort !== "") config.reasoningEffort = effort;

		const stream = ctx.llm.stream(config);
		for await (const chunk of stream) {
			assembler.push(chunk);
		}
		const finish = assembler.finish;
		let text = "";
		try {
			for (const block of assembler.blocks()) {
				if (block?.type === "text" && typeof block.text === "string") text += block.text;
			}
		} catch {
			// A malformed stream still yields whatever text was assembled above.
		}
		const usage = typeof assembler.usage === "object" ? assembler.usage : undefined;
		if (finish !== undefined && finish !== null && (finish.kind === "error" || finish.kind === "aborted")) {
			return { ok: false, code: finish.kind, detail: describeFailure(finish.failure) };
		}
		return { ok: true, text, ...(usage === undefined ? {} : { usage }) };
	};

	try {
		return await attempt(reasoningEffort);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		// A model that advertises no reasoning support rejects the knob outright;
		// the call itself is still fine, so retry once without it.
		if (typeof reasoningEffort === "string" && reasoningEffort !== "" && /reasoning/i.test(detail)) {
			try {
				return await attempt("");
			} catch (retryError) {
				return {
					ok: false,
					code: "stream-failed",
					detail: retryError instanceof Error ? retryError.message : String(retryError),
				};
			}
		}
		return { ok: false, code: "stream-failed", detail };
	}
}
