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

// Exclude freeSocketTimeout which is not supported by https.AgentOptions
const httpsAgent = new https.Agent({
	keepAlive: true,
	keepAliveMsecs: 1000,
	maxSockets: 25,
	maxFreeSockets: 10,
	timeout: 60000,
});

// Global Axios instance configured with Keep-Alive connection pool and request timeout
export const httpClient = axios.create({
	httpAgent,
	httpsAgent,
	timeout: 30000,
});
