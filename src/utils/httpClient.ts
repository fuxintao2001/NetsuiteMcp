import http from "node:http";
import https from "node:https";
import axios from "axios";

const httpAgent = new http.Agent({
	keepAlive: true,
	keepAliveMsecs: 1000,
	maxSockets: 25,
	maxFreeSockets: 10,
	timeout: 60000,
});

// 排除非 https.AgentOptions 支持的 freeSocketTimeout
const httpsAgent = new https.Agent({
	keepAlive: true,
	keepAliveMsecs: 1000,
	maxSockets: 25,
	maxFreeSockets: 10,
	timeout: 60000,
});

// 全局配置了 Keep-Alive 连接池与请求超时的 Axios 实例
export const httpClient = axios.create({
	httpAgent,
	httpsAgent,
	timeout: 30000,
});

/**
 * Creates an AbortController with an optional auto-abort timeout.
 */
export function createAbortController(timeoutMs?: number): {
	controller: AbortController;
	signal: AbortSignal;
	clear: () => void;
} {
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	if (timeoutMs && timeoutMs > 0) {
		timer = setTimeout(() => {
			controller.abort(new Error(`Request timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	}
	const clear = () => {
		if (timer) clearTimeout(timer);
	};
	return { controller, signal: controller.signal, clear };
}
