import pLimit from "p-limit";

export interface BatchTaskResult<T = unknown> {
	index: number;
	success: boolean;
	durationMs: number;
	result?: T;
	error?: string;
}

export interface BatchRunResult<T = unknown> {
	total: number;
	successful: number;
	failed: number;
	totalDurationMs: number;
	individualResults: BatchTaskResult<T>[];
}

/**
 * Executes an array of items concurrently up to specified concurrency limit,
 * capturing timing, success/failure status, and duration for each task.
 */
export async function processParallelBatch<TIn, TOut>(
	items: TIn[],
	taskFn: (item: TIn, index: number) => Promise<TOut>,
	concurrency = 5,
): Promise<BatchRunResult<TOut>> {
	const limit = pLimit(concurrency);
	const startTime = Date.now();

	const individualResults = await Promise.all(
		items.map((item, index) =>
			limit(async () => {
				const itemStart = Date.now();
				try {
					const res = await taskFn(item, index);
					return {
						index,
						success: true,
						durationMs: Date.now() - itemStart,
						result: res,
					};
				} catch (err: unknown) {
					return {
						index,
						success: false,
						durationMs: Date.now() - itemStart,
						error: err instanceof Error ? err.message : String(err),
					};
				}
			}),
		),
	);

	return {
		total: items.length,
		successful: individualResults.filter((r) => r.success).length,
		failed: individualResults.filter((r) => !r.success).length,
		totalDurationMs: Date.now() - startTime,
		individualResults,
	};
}
