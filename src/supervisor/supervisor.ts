import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export interface SupervisorConfig {
	scriptPath: string;
	distDir: string;
	pollIntervalMs?: number;
}

export class McpSupervisor {
	private currentWorker: ChildProcess | null = null;
	private workerRl: readline.Interface | null = null;
	private savedInitRequest: string | null = null;
	private savedInitializedNotification: string | null = null;
	private readonly activeRequestIds = new Set<string | number>();
	private isReloading = false;
	private reloadPending = false;
	private readonly queuedInputLines: string[] = [];
	private lastStampTime = 0;
	private pollTimer: NodeJS.Timeout | null = null;
	private isShuttingDown = false;
	private readonly pollIntervalMs: number;

	constructor(private readonly config: SupervisorConfig) {
		this.pollIntervalMs = config.pollIntervalMs ?? 1000;
	}

	public start(): void {
		this.lastStampTime = this.getLatestBuildTimestamp();
		this.spawnWorker();
		this.setupStdinListener();
		this.setupFileWatcher();
		this.setupProcessSignals();
	}

	private getLatestBuildTimestamp(): number {
		const stampPath = path.join(this.config.distDir, ".build_stamp");
		try {
			if (fs.existsSync(stampPath)) {
				const stat = fs.statSync(stampPath);
				return stat.mtimeMs;
			}
		} catch {
			// Fallback to checking scriptPath
		}

		try {
			if (fs.existsSync(this.config.scriptPath)) {
				const stat = fs.statSync(this.config.scriptPath);
				return stat.mtimeMs;
			}
		} catch {
			// Non-fatal
		}

		return 0;
	}

	private spawnWorker(attachStdout = true): ChildProcess {
		const worker = spawn(
			process.execPath,
			[this.config.scriptPath, ...process.argv.slice(2)],
			{
				env: {
					...process.env,
					__NETSUITE_MCP_WORKER__: "true",
				},
				stdio: ["pipe", "pipe", "inherit"],
			},
		);

		this.currentWorker = worker;
		if (attachStdout) {
			this.attachWorkerStdout(worker);
		}

		worker.on("exit", (code, signal) => {
			if (this.isShuttingDown || this.isReloading) {
				return;
			}
			console.error(
				`⚠️ [Supervisor] Worker process exited unexpectedly (code: ${code}, signal: ${signal}). Restarting in 500ms...`,
			);
			setTimeout(() => {
				if (!this.isShuttingDown) {
					void this.performReload();
				}
			}, 500);
		});

		worker.on("error", (err) => {
			console.error("❌ [Supervisor] Worker process error:", err);
		});

		return worker;
	}

	private setupStdinListener(): void {
		const rlStdin = readline.createInterface({
			input: process.stdin,
			terminal: false,
		});

		rlStdin.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;

			try {
				const parsed = JSON.parse(trimmed);
				if (parsed.method === "initialize") {
					this.savedInitRequest = trimmed;
				} else if (parsed.method === "notifications/initialized") {
					this.savedInitializedNotification = trimmed;
				} else if (parsed.id !== undefined && parsed.id !== null) {
					this.activeRequestIds.add(parsed.id);
				}
			} catch {
				// Non-JSON line
			}

			if (this.isReloading) {
				this.queuedInputLines.push(line);
			} else if (
				this.currentWorker?.stdin &&
				!this.currentWorker.stdin.destroyed
			) {
				this.currentWorker.stdin.write(`${line}\n`);
			}
		});

		process.stdin.on("close", () => this.shutdown());
		process.stdin.on("end", () => this.shutdown());
	}

	private attachWorkerStdout(worker: ChildProcess): void {
		if (this.workerRl) {
			this.workerRl.close();
			this.workerRl = null;
		}

		if (!worker.stdout) return;

		const rl = readline.createInterface({
			input: worker.stdout,
			terminal: false,
		});
		this.workerRl = rl;

		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;

			try {
				const parsed = JSON.parse(trimmed);
				if (parsed.id !== undefined && parsed.id !== null) {
					this.activeRequestIds.delete(parsed.id);
				}
			} catch {
				// Non-JSON
			}

			// Forward line to parent stdout (Antigravity)
			process.stdout.write(`${line}\n`);

			if (this.reloadPending && this.activeRequestIds.size === 0) {
				this.reloadPending = false;
				void this.performReload();
			}
		});
	}

	private setupFileWatcher(): void {
		this.pollTimer = setInterval(() => {
			if (this.isShuttingDown || this.isReloading) return;
			const latestStamp = this.getLatestBuildTimestamp();
			if (latestStamp > this.lastStampTime) {
				this.lastStampTime = latestStamp;
				this.triggerReload();
			}
		}, this.pollIntervalMs);
	}

	private triggerReload(): void {
		if (this.activeRequestIds.size > 0) {
			this.reloadPending = true;
			return;
		}
		this.reloadPending = false;
		void this.performReload();
	}

	private async performReload(): Promise<void> {
		if (this.isReloading) return;
		this.isReloading = true;
		console.error(
			"🔄 [HotReload] New build detected. Seamlessly reloading NetSuite MCP Worker...",
		);

		const oldWorker = this.currentWorker;
		this.currentWorker = null;

		if (this.workerRl) {
			this.workerRl.close();
			this.workerRl = null;
		}

		if (oldWorker) {
			try {
				oldWorker.removeAllListeners("exit");
				oldWorker.kill("SIGTERM");
			} catch {
				// Non-fatal
			}
		}

		try {
			const newWorker = this.spawnWorker(false);

			if (this.savedInitRequest && this.savedInitializedNotification) {
				await this.replayHandshake(
					newWorker,
					this.savedInitRequest,
					this.savedInitializedNotification,
				);
			}

			// Attach stdout now that handshake is complete
			this.attachWorkerStdout(newWorker);

			// Drain queued inputs to new worker
			while (this.queuedInputLines.length > 0) {
				const queuedLine = this.queuedInputLines.shift();
				if (queuedLine && newWorker.stdin && !newWorker.stdin.destroyed) {
					newWorker.stdin.write(`${queuedLine}\n`);
				}
			}

			// Notify client that tools may have changed
			try {
				process.stdout.write(
					`${JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/tools/list_changed",
					})}\n`,
				);
			} catch {
				// Non-fatal
			}

			console.error(
				"✅ [HotReload] NetSuite MCP Worker reloaded and ready with latest code!",
			);
		} catch (err) {
			console.error("❌ [HotReload] Failed to reload worker:", err);
		} finally {
			this.isReloading = false;
		}
	}

	private replayHandshake(
		worker: ChildProcess,
		initReq: string,
		initializedNotif: string,
	): Promise<void> {
		return new Promise((resolve) => {
			if (!worker.stdout || !worker.stdin) {
				resolve();
				return;
			}

			const rl = readline.createInterface({
				input: worker.stdout,
				terminal: false,
			});

			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				rl.close();
				resolve();
			};

			rl.once("line", (_line) => {
				// We consumed the replayed initialize response without forwarding to client
				if (worker.stdin && !worker.stdin.destroyed) {
					worker.stdin.write(`${initializedNotif}\n`);
				}
				finish();
			});

			worker.stdin.write(`${initReq}\n`);

			// Timeout safety: if worker doesn't respond in 5s, proceed anyway
			setTimeout(() => finish(), 5000);
		});
	}

	private setupProcessSignals(): void {
		process.on("SIGINT", () => this.shutdown());
		process.on("SIGTERM", () => this.shutdown());
		process.stdout.on("error", (err: unknown) => {
			if ((err as { code?: string })?.code === "EPIPE") {
				this.shutdown();
			}
		});
	}

	private shutdown(): void {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;

		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		if (this.workerRl) {
			this.workerRl.close();
			this.workerRl = null;
		}

		if (this.currentWorker) {
			try {
				this.currentWorker.kill("SIGTERM");
			} catch {
				// Non-fatal
			}
			this.currentWorker = null;
		}

		process.exit(0);
	}
}
