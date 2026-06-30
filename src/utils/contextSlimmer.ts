/**
 * Utility functions for slimming down response payloads to reduce MCP context token usage.
 */

/**
 * Clean helper function to recursively remove nulls, undefineds, and 'links' keys.
 */
function cleanRecordPayloadHelper(val: any): any {
  if (val === null || val === undefined) {
    return undefined;
  }
  if (Array.isArray(val)) {
    const cleanedArr = val
      .map(item => cleanRecordPayloadHelper(item))
      .filter(item => item !== undefined);
    return cleanedArr.length > 0 ? cleanedArr : undefined;
  }
  if (typeof val === 'object') {
    const cleaned: Record<string, any> = {};
    let hasKeys = false;
    for (const key of Object.keys(val)) {
      if (key === 'links') continue;
      const cleanedVal = cleanRecordPayloadHelper(val[key]);
      if (cleanedVal !== undefined && cleanedVal !== null && cleanedVal !== '') {
        cleaned[key] = cleanedVal;
        hasKeys = true;
      }
    }
    return hasKeys ? cleaned : undefined;
  }
  return val;
}

/**
 * Recursively removes redundant fields (like 'links') and null/undefined values from record objects.
 * Always returns a fallback empty object/array if the root is completely stripped.
 */
export function cleanRecordPayload(val: any): any {
  const result = cleanRecordPayloadHelper(val);
  if (result === undefined) {
    return Array.isArray(val) ? [] : {};
  }
  return result;
}

/**
 * Formats JSON schema (from NetSuite record metadata) into a compact Markdown table.
 */
export function formatMetadataToCompactMarkdown(schema: any): string {
  if (!schema || typeof schema !== 'object') {
    return String(schema);
  }

  // Handle various formats of JSON Schema / responses
  let properties = schema.properties;
  if (schema.metadata && typeof schema.metadata === 'object') {
    properties = schema.metadata.properties;
  }

  // Unwrap array/content wrapper if it's from local converted record format or MCP response format
  if (Array.isArray(schema.content)) {
    const first = schema.content[0];
    if (first && first.text && typeof first.text === 'string') {
      try {
        const parsed = JSON.parse(first.text);
        return formatMetadataToCompactMarkdown(parsed);
      } catch {
        // Not JSON text, return content as string
        return first.text;
      }
    }
  }

  if (!properties || typeof properties !== 'object') {
    // If it's standard JSON but has a success status
    if (schema.success === true && schema.metadata) {
      return formatMetadataToCompactMarkdown(schema.metadata);
    }
    return typeof schema === 'string' ? schema : JSON.stringify(schema, null, 2);
  }

  let output = "| Field | Type | Description | Nullable |\n|---|---|---|---|\n";
  for (const [key, value] of Object.entries(properties)) {
    if (!value || typeof value !== 'object') continue;
    const valObj = value as Record<string, any>;
    const typeStr = valObj.type === 'object' && valObj.properties
      ? `object (${Object.keys(valObj.properties).join(', ')})`
      : (valObj.type || 'string');
    const desc = (valObj.description || valObj.title || '').trim();
    const nullable = valObj.nullable !== false ? 'Yes' : 'No';
    output += `| ${key} | ${typeStr} | ${desc.replace(/\n/g, ' ')} | ${nullable} |\n`;
  }
  return output;
}
