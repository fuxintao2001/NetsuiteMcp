import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface RecordFieldMeta {
	internalId: string;
	label: string;
	type: string;
	required: boolean;
	help?: string;
}

export interface RecordTypeMeta {
	internalId: string;
	label?: string;
	fields: RecordFieldMeta[];
	sublists?: Array<{ name: string; label?: string }>;
}

/**
 * Service to access Oracle NetSuite official 272 SuiteScript Records Reference definitions.
 */
class RecordsReferenceService {
	private recordsCache: Map<string, RecordTypeMeta> | null = null;
	private recordNamesCache: string[] | null = null;

	private getRecordsJsonPath(): string {
		return path.join(
			os.homedir(),
			".gemini",
			"config",
			"skills",
			"netsuite-suitescript-records-reference",
			"references",
			"records.json",
		);
	}

	private ensureLoaded(): boolean {
		if (this.recordsCache) return true;

		const jsonPath = this.getRecordsJsonPath();
		if (!fs.existsSync(jsonPath)) {
			return false;
		}

		try {
			const rawContent = fs.readFileSync(jsonPath, "utf-8");
			const parsed = JSON.parse(rawContent) as {
				records?: Record<
					string,
					{
						internalId: string;
						fields?: Array<{
							internalId: string;
							label?: string;
							type?: string;
							required?: string | boolean;
							help?: string;
						}>;
						sublists?: Array<{ name: string; label?: string }>;
					}
				>;
			};

			if (!parsed.records) return false;

			this.recordsCache = new Map();
			this.recordNamesCache = [];

			for (const [key, val] of Object.entries(parsed.records)) {
				const lowerKey = key.toLowerCase();
				const fields: RecordFieldMeta[] = (val.fields || []).map((f) => ({
					internalId: f.internalId,
					label: f.label || f.internalId,
					type: f.type || "string",
					required: f.required === "true" || f.required === true,
					help: f.help || "",
				}));

				this.recordsCache.set(lowerKey, {
					internalId: val.internalId || key,
					fields,
					sublists: val.sublists || [],
				});
				this.recordNamesCache.push(lowerKey);
			}

			this.recordNamesCache.sort();
			return true;
		} catch (error) {
			console.error("⚠️ Failed to load records.json reference:", error);
			return false;
		}
	}

	/** List all supported standard record types (272 types) */
	listRecordTypes(): string[] {
		if (!this.ensureLoaded() || !this.recordNamesCache) {
			return [];
		}
		return [...this.recordNamesCache];
	}

	/** Get definition for a standard record type */
	getRecordDefinition(
		recordType: string,
		keyword?: string,
	): {
		recordType: string;
		found: boolean;
		totalFields: number;
		fields: RecordFieldMeta[];
		sublists?: Array<{ name: string; label?: string }>;
	} | null {
		if (!this.ensureLoaded() || !this.recordsCache) {
			return null;
		}

		const cleanType = recordType.toLowerCase().replace(/[^a-z0-9_]/g, "");
		const rec = this.recordsCache.get(cleanType);
		if (!rec) {
			return {
				recordType,
				found: false,
				totalFields: 0,
				fields: [],
			};
		}

		let filteredFields = rec.fields;
		if (keyword && keyword.trim().length > 0) {
			const kw = keyword.toLowerCase().trim();
			filteredFields = rec.fields.filter(
				(f) =>
					f.internalId.toLowerCase().includes(kw) ||
					f.label.toLowerCase().includes(kw) ||
					f.help?.toLowerCase().includes(kw),
			);
		}

		return {
			recordType: rec.internalId,
			found: true,
			totalFields: rec.fields.length,
			fields: filteredFields,
			...(rec.sublists ? { sublists: rec.sublists } : {}),
		};
	}
}

export const recordsReferenceService = new RecordsReferenceService();
