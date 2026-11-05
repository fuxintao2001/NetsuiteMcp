declare module "redlock" {
	import { EventEmitter } from "node:events";
	import type { Redis } from "ioredis";

	export interface Settings {
		readonly driftFactor: number;
		readonly retryCount: number;
		readonly retryDelay: number;
		readonly retryJitter: number;
		readonly automaticExtensionThreshold: number;
	}

	export class Lock {
		readonly redlock: Redlock;
		readonly resources: string[];
		readonly value: string;
		expiration: number;
		release(): Promise<unknown>;
		extend(duration: number): Promise<Lock>;
	}

	export default class Redlock extends EventEmitter {
		constructor(clients: Iterable<Redis>, settings?: Partial<Settings>);
		acquire(resources: string[], duration: number): Promise<Lock>;
		release(lock: Lock): Promise<unknown>;
		extend(lock: Lock, duration: number): Promise<Lock>;
		quit(): Promise<void>;
	}
}
