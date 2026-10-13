/**
 * The task queue: one batch document in the plugin's storage domain, holding
 * every pending / running / finished task. Whole-document writes (one `put`
 * per change) mirror how `dsh-schedule` persists a task row.
 *
 * @module dsh-peak-runner/queue
 */

import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";

/** A permissive value schema: the domain only needs `parse()`. */
function recordSchema() {
	return {
		parse(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw new Error("peak-runner batch must be an object");
			}
			if (!Array.isArray(value.tasks)) throw new Error("peak-runner batch.tasks must be an array");
			return value;
		},
	};
}

export const peakRunnerDomain = defineDomain({
	// Domain names must match /^[a-z][a-z0-9_]*$/ — the hyphenated plugin name
	// is rejected by the host's schema, so the underscore spelling is used here.
	name: "peak_runner",
	version: 1,
	tables: {
		batches: domainTable(recordSchema()),
	},
});

/** The one and only batch document key. */
export const BATCH_KEY = "current";

/** Task statuses this queue uses. */
export const TASK_STATUSES = Object.freeze(["pending", "running", "done", "failed", "cancelled"]);

/**
 * Create an empty batch document.
 *
 * @returns a fresh batch with an empty task list.
 */
export function emptyBatch() {
	return { tasks: [] };
}

/**
 * Normalise a raw task into the stored shape.
 *
 * @param raw - caller-supplied task fields.
 * @param now - epoch ms used for `createdAt`.
 * @returns the normalised task.
 */
export function normalizeTask(raw, now) {
	const prompt = typeof raw?.prompt === "string" ? raw.prompt.trim() : "";
	if (prompt === "") throw new Error("task prompt must be a non-empty string");
	return {
		id: typeof raw?.id === "string" && raw.id !== "" ? raw.id : `task-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		prompt,
		status: "pending",
		createdAt: now,
		startedAt: null,
		finishedAt: null,
		result: null,
		error: null,
	};
}

/**
 * Open the queue against a storage-domain service.
 *
 * @param ctx - host plugin context (needs the `storageDomain` service).
 * @returns `{ ready, tasks(), put() }` where `ready` resolves once the domain
 *   is open and `tasks()` returns the current task list.
 */
export function createQueue(ctx) {
	const ready = ctx.storageDomain.open(peakRunnerDomain);

	/** @returns {Promise<Array>} the current task list (fresh copy). */
	async function tasks() {
		const domain = await ready;
		const table = domain.table("batches");
		const batch = table.get(BATCH_KEY);
		if (batch === undefined) return [];
		return Array.isArray(batch.tasks) ? batch.tasks : [];
	}

	/**
	 * Persist a whole task list.
	 *
	 * @param list - the task list to store.
	 * @returns {Promise<void>} resolves once the write is durable.
	 */
	async function put(list) {
		const domain = await ready;
		await domain.table("batches").put(BATCH_KEY, { tasks: list });
	}

	return { ready, tasks, put };
}
