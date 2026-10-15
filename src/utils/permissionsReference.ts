import {
	type NetSuitePermissionItem,
	OFFICIAL_PERMISSIONS_DATA,
} from "./permissionsData.js";

export interface PermissionCategorySummary {
	category: string;
	label: string;
	count: number;
}

const RECORD_TO_PERMISSION_MAP: Record<string, string[]> = {
	salesorder: ["TRAN_SALESORD", "TRAN_SALESORDAPPRV"],
	invoice: ["TRAN_CUSTINVC"],
	purchaseorder: ["TRAN_PURCHORD", "TRAN_PURCHORDAPPRV"],
	estimate: ["TRAN_ESTIMATE"],
	opportunity: ["TRAN_OPPRTNTY"],
	customer: ["LIST_CUSTJOB"],
	vendor: ["LIST_VENDOR"],
	item: ["LIST_ITEM"],
	inventoryitem: ["LIST_ITEM"],
	employee: ["LIST_EMPLOYEE"],
	contact: ["LIST_CONTACT"],
	journalentry: ["TRAN_JOURNAL", "TRAN_JOURNALAPPRV"],
	creditmemo: ["TRAN_CUSTCRED"],
	vendorbill: ["TRAN_VENDBILL", "TRAN_VENDBILLAPPRV"],
	vendorpayment: ["TRAN_VENDPYMT"],
	vendorcredit: ["TRAN_VENDCRED"],
	customerpayment: ["TRAN_CUSTPYMT"],
	customerdeposit: ["TRAN_CUSTDEP"],
	customerrefund: ["TRAN_CUSTRFND"],
	itemfulfillment: ["TRAN_ITEMSHIP"],
	itemreceipt: ["TRAN_ITEMRCPT"],
	returnauthorization: ["TRAN_RTNAUTH", "TRAN_RTNAUTHAPPRV"],
	transferorder: ["TRAN_TRNFRORD", "TRAN_TRNFRORDAPPRV"],
	workorder: ["TRAN_WORKORD"],
	assemblybuild: ["TRAN_BUILD"],
	assemblyunbuild: ["TRAN_UNBUILD"],
	inventoryadjustment: ["TRAN_INVADJST"],
	inventorytransfer: ["TRAN_INVTRNFR"],
	account: ["ADMI_ACCOUNTING", "LIST_ACCOUNT"],
	subsidiary: ["ADMI_COMPANY", "LIST_SUBSIDIARY"],
	department: ["LIST_DEPARTMENT"],
	class: ["LIST_CLASS"],
	classification: ["LIST_CLASS"],
	location: ["LIST_LOCATION"],
	customrecord: ["ADMI_CUSTRECORD"],
	script: ["ADMI_CUSTOMSCRIPT"],
	suitelet: ["ADMI_CUSTOMSCRIPT"],
	restlet: ["ADMI_CUSTOMSCRIPT"],
	billingrevenueevent: ["TRAN_REVENUEARRANGEMENT"],
	revenuearrangement: ["TRAN_REVENUEARRANGEMENT"],
	transactionaccountingline: ["ADMI_ACCOUNTING", "TRAN_JOURNAL"],
	transactionline: ["TRAN_SALESORD", "TRAN_PURCHORD"],
	systemnote: ["ADMI_AUDITLOGIN"],
};

export class PermissionsReferenceService {
	private readonly permissions: NetSuitePermissionItem[];
	private readonly idMap: Map<string, NetSuitePermissionItem>;
	private readonly categoryMap: Map<string, NetSuitePermissionItem[]>;

	constructor(data: NetSuitePermissionItem[] = OFFICIAL_PERMISSIONS_DATA) {
		this.permissions = data;
		this.idMap = new Map();
		this.categoryMap = new Map();

		for (const item of data) {
			this.idMap.set(item.id.toUpperCase(), item);
			const cat = item.category.toUpperCase();
			let list = this.categoryMap.get(cat);
			if (!list) {
				list = [];
				this.categoryMap.set(cat, list);
			}
			list.push(item);
		}
	}

	/**
	 * Lists all 5 permission categories with counts.
	 */
	listCategories(): PermissionCategorySummary[] {
		const order: Array<{ category: string; label: string }> = [
			{ category: "TRAN", label: "Transactions" },
			{ category: "LIST", label: "Lists/Records" },
			{ category: "ADMI", label: "Administration" },
			{ category: "REPO", label: "Reports" },
			{ category: "REGT", label: "Registers" },
		];

		return order.map((o) => ({
			category: o.category,
			label: o.label,
			count: this.categoryMap.get(o.category)?.length || 0,
		}));
	}

	/**
	 * Returns all 680 permissions in the dictionary.
	 */
	getAllPermissions(): NetSuitePermissionItem[] {
		return [...this.permissions];
	}

	/**
	 * Looks up a permission by its standard ID (e.g. 'ADMI_ACCOUNTING', 'TRAN_SALESORD').
	 */
	getPermissionById(id: string): NetSuitePermissionItem | undefined {
		if (!id) return undefined;
		return this.idMap.get(id.trim().toUpperCase());
	}

	/**
	 * Returns all permissions for a specific category ('ADMI', 'LIST', 'TRAN', 'REPO', 'REGT').
	 */
	getPermissionsByCategory(category: string): NetSuitePermissionItem[] {
		if (!category) return [];
		return this.categoryMap.get(category.trim().toUpperCase()) || [];
	}

	/**
	 * Searches permissions by query keyword against ID, name, or category.
	 */
	searchPermissions(keyword: string): NetSuitePermissionItem[] {
		const kw = keyword.trim().toLowerCase();
		if (!kw) return this.getAllPermissions();

		return this.permissions.filter(
			(p) =>
				p.id.toLowerCase().includes(kw) ||
				p.name.toLowerCase().includes(kw) ||
				p.category.toLowerCase().includes(kw) ||
				p.categoryLabel.toLowerCase().includes(kw),
		);
	}

	/**
	 * Maps an entity or record type (e.g. 'salesorder', 'customer') to its required permissions.
	 */
	lookupPermissionForRecordType(recordType: string): NetSuitePermissionItem[] {
		const cleanType = recordType.trim().toLowerCase();
		if (!cleanType) return [];

		// Direct lookup
		let ids = RECORD_TO_PERMISSION_MAP[cleanType];

		// Custom record lookup
		if (!ids && cleanType.startsWith("customrecord")) {
			ids = RECORD_TO_PERMISSION_MAP.customrecord;
		}

		if (ids && ids.length > 0) {
			const results: NetSuitePermissionItem[] = [];
			for (const id of ids) {
				const perm = this.getPermissionById(id);
				if (perm) results.push(perm);
			}
			return results;
		}

		// Fallback fuzzy search by record name
		return this.searchPermissions(cleanType).slice(0, 5);
	}

	/**
	 * Formats an authoritative Markdown reference document for MCP Resource.
	 */
	formatPermissionsMarkdown(filter?: string): string {
		let items = this.permissions;
		let filterNote = "";

		if (filter && filter.trim().length > 0) {
			const kw = filter.trim();
			items = this.searchPermissions(kw);
			filterNote = ` *(Filtered by: "${kw}" — ${items.length} matching entries)*`;
		}

		let md = `# Oracle NetSuite Official Standard Permissions Matrix Dictionary\n\n`;
		md += `> **Authority**: Oracle NetSuite Help Center & SuiteCloud Development Framework (SDF)\n`;
		md += `> **Scope**: 680 Official Standard Permissions across 5 Core ERP Categories\n\n`;

		// Category Summary
		const categories = this.listCategories();
		md += `## 📊 Permissions Category Distribution\n\n`;
		md += `| Category Code | Category Label | Standard Permissions Count |\n|:---|:---|:---:|\n`;
		for (const cat of categories) {
			md += `| \`${cat.category}\` | ${cat.label} | **${cat.count}** |\n`;
		}
		md += `\n---\n\n`;

		// 403 Self-Healing Diagnostic SOP
		md += `## 🛡️ 403 Permission Denied Self-Healing Diagnostic & Remediation SOP\n\n`;
		md += `When encountering an HTTP 403 / \`INSUFFICIENT_PERMISSION\` or \`PERMISSION_DENIED\` error in NetSuite:\n\n`;
		md += `1. **Zero Hallucination Hard-Stop**: Do NOT attempt to guess alternate queries or fabricate fake data. Stop the operation immediately.\n`;
		md += `2. **Identify Target Record & Required Permkey**: Use the table below or call \`lookupPermissionForRecordType\` to identify the required \`permkey\` (e.g. \`TRAN_SALESORD\` for Sales Orders, \`LIST_CUSTJOB\` for Customers).\n`;
		md += `3. **Role Permission Configuration Path**:\n`;
		md += `   - Navigate in NetSuite UI: **Setup > Users/Roles > Manage Roles**\n`;
		md += `   - Edit target role > Select **Permissions** subtab\n`;
		md += `   - Select relevant category tab: **Transactions** (\`TRAN\`), **Lists** (\`LIST\`), **Setup / Administration** (\`ADMI\`), **Reports** (\`REPO\`), or **Registers** (\`REGT\`)\n`;
		md += `   - Add permission and assign appropriate Access Level:\n`;
		md += `     * \`View\` (Level 1): Read-only inspection & SuiteQL queries\n`;
		md += `     * \`Create\` (Level 2): Creating new records\n`;
		md += `     * \`Edit\` (Level 3): Updating existing records\n`;
		md += `     * \`Full\` (Level 4): Create, edit, and delete permissions\n`;
		md += `4. **Session Re-authentication**: After updating permissions in NetSuite, perform token refresh or re-login to ensure new token scopes take effect.\n\n`;
		md += `---\n\n`;

		// Detailed Permissions Table
		md += `## 📖 Official Permissions Index${filterNote}\n\n`;
		md += `| Category | Permission ID (\`permkey\`) | Official Display Name |\n|:---|:---|:---|\n`;
		for (const item of items) {
			md += `| \`${item.category}\` | \`${item.id}\` | ${item.name} |\n`;
		}

		return md;
	}
}

export const permissionsReferenceService = new PermissionsReferenceService();
