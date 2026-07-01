import { describe, it, expect } from '@jest/globals';
import { cleanRecordPayload, formatMetadataToCompactMarkdown } from './contextSlimmer.js';

describe('Context Slimmer', () => {
  describe('cleanRecordPayload', () => {
    it('should recursively remove null, undefined, empty strings, and links key', () => {
      const payload = {
        id: '123',
        name: 'John Doe',
        email: '',
        parent: null,
        links: [{ rel: 'self', href: '/url' }],
        nested: {
          active: true,
          value: undefined,
          links: { href: '/another-url' }
        },
        items: [
          { sku: 'A', discount: null, links: [] }
        ]
      };

      const result = cleanRecordPayload(payload);
      expect(result).toEqual({
        id: '123',
        name: 'John Doe',
        nested: {
          active: true
        },
        items: [
          { sku: 'A' }
        ]
      });
    });

    it('should fall back to empty object/array when everything is cleaned', () => {
      expect(cleanRecordPayload({ links: [], temp: null })).toEqual({});
      expect(cleanRecordPayload([null, undefined])).toEqual([]);
    });
  });

  describe('formatMetadataToCompactMarkdown', () => {
    it('should convert standard JSON Schema properties into a Markdown table', () => {
      const schema = {
        properties: {
          id: { title: 'Internal ID', type: 'string', nullable: false },
          name: { title: 'Name', type: 'string', description: 'Customer name' },
          company: {
            title: 'Company Reference',
            type: 'object',
            properties: { id: { type: 'string' }, refName: { type: 'string' } }
          }
        }
      };

      const markdown = formatMetadataToCompactMarkdown(schema);
      expect(markdown).toContain('| Field | Type | Description | Nullable |');
      expect(markdown).toContain('| id | string | Internal ID | No |');
      expect(markdown).toContain('| name | string | Customer name | Yes |');
      expect(markdown).toContain('| company | object (id, refName) | Company Reference | Yes |');
    });

    it('should unwrap schema when nested in success/metadata or content formats', () => {
      const mcpFormat = {
        content: [{
          text: JSON.stringify({
            success: true,
            metadata: {
              properties: {
                sku: { title: 'SKU', type: 'string' }
              }
            }
          })
        }]
      };

      const markdown = formatMetadataToCompactMarkdown(mcpFormat);
      expect(markdown).toContain('| sku | string | SKU | Yes |');
    });

    it('should return stringified fallback on non-object inputs', () => {
      expect(formatMetadataToCompactMarkdown('plain string')).toBe('plain string');
      expect(formatMetadataToCompactMarkdown(null)).toBe('null');
    });
  });
});
