import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import { join } from 'path';

// ---------------------------------------------------------------------------
// MCP Resource Handlers
// ---------------------------------------------------------------------------

/**
 * Register MCP Resource handlers on the server.
 *
 * Exposes static reference documents (e.g. SUITEQL_GUIDE.md) as MCP Resources
 * so that AI agents can discover and read them via the standard MCP protocol
 * without relying on IDE-specific file access.
 */
export function registerResourceHandlers(server: Server, projectRoot: string): void {

  // --- List Resources ---
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: 'netsuite://guides/suiteql',
          name: 'SuiteQL Query & Syntax Reference Guide',
          description:
            'Complete SuiteQL syntax reference including Oracle SQL subset rules, ' +
            'BUILTIN functions, date handling, common pitfalls, and NetSuite-specific ' +
            'query patterns like ScriptNote log queries.',
          mimeType: 'text/markdown',
        },
      ],
    };
  });

  // --- Read Resource ---
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    if (uri === 'netsuite://guides/suiteql') {
      const filePath = join(projectRoot, 'SUITEQL_GUIDE.md');
      const content = await fs.readFile(filePath, 'utf-8');
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: content,
          },
        ],
      };
    }

    throw new Error(`Resource not found: ${uri}`);
  });
}
