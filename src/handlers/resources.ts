import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs/promises';
import { join, basename } from 'path';

// ---------------------------------------------------------------------------
// Helper: Parse YAML frontmatter simply
// ---------------------------------------------------------------------------
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const parts = content.split('---');
  if (parts.length < 3) return {};
  const frontmatterText = parts[1];
  const lines = frontmatterText.split('\n');
  const result: { name?: string; description?: string } = {};

  let currentKey: 'name' | 'description' | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if line starts with key:
    const nameMatch = line.match(/^name:\s*(.*)/);
    const descMatch = line.match(/^description:\s*(.*)/);

    if (nameMatch) {
      result.name = nameMatch[1].trim();
      currentKey = 'name';
    } else if (descMatch) {
      result.description = descMatch[1].trim();
      currentKey = 'description';
    } else if (line.match(/^[a-zA-Z0-9_-]+:/)) {
      currentKey = null;
    } else if (currentKey && line.startsWith(' ')) {
      // Continuation of multiline string
      if (currentKey === 'description' && result.description) {
        result.description += ' ' + trimmed;
      }
    }
  }

  // Clean quotes
  if (result.name) result.name = result.name.replace(/^['"]|['"]$/g, '');
  if (result.description) result.description = result.description.replace(/^['"]|['"]$/g, '');

  return result;
}

// ---------------------------------------------------------------------------
// MCP Resource Handlers
// ---------------------------------------------------------------------------

/**
 * Register MCP Resource handlers on the server.
 *
 * Exposes static reference documents (e.g. SUITEQL_GUIDE.md) and downloaded
 * SuiteCloud Agent Skills as MCP Resources so that AI agents can discover
 * and read them via the standard MCP protocol.
 */
export function registerResourceHandlers(server: Server, projectRoot: string): void {

  // --- List Resources ---
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const resources = [
      {
        uri: 'netsuite://guides/suiteql',
        name: 'SuiteQL Query & Syntax Reference Guide',
        description:
          'Complete SuiteQL syntax reference including Oracle SQL subset rules, ' +
          'BUILTIN functions, date handling, common pitfalls, and NetSuite-specific ' +
          'query patterns like ScriptNote log queries.',
        mimeType: 'text/markdown',
      },
    ];

    const skillsDir = join(projectRoot, 'skills');
    try {
      const entries = await fs.readdir(skillsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillMdPath = join(skillsDir, entry.name, 'SKILL.md');
          try {
            const content = await fs.readFile(skillMdPath, 'utf-8');
            const meta = parseFrontmatter(content);
            resources.push({
              uri: `netsuite://skills/${entry.name}`,
              name: meta.name || entry.name,
              description: meta.description || `SuiteCloud Agent Skill: ${entry.name}`,
              mimeType: 'text/markdown',
            });
          } catch {
            // SKILL.md doesn't exist or is not readable - skip
          }
        }
      }
    } catch {
      // skills/ directory might not exist yet - ignore
    }

    return { resources };
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

    if (uri.startsWith('netsuite://skills/')) {
      const skillName = uri.substring('netsuite://skills/'.length);
      // Sanitize the directory name to prevent path traversal
      const sanitizedName = basename(skillName);
      
      const filePath = join(projectRoot, 'skills', sanitizedName, 'SKILL.md');
      try {
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Skill resource not found or unreadable: ${uri} (${msg})`);
      }
    }

    throw new Error(`Resource not found: ${uri}`);
  });
}
