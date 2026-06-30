import { cleanRecordPayload, formatMetadataToCompactMarkdown } from './contextSlimmer.js';
import { describe, it, expect } from '@jest/globals';

describe('Context Slimmer Utilities', () => {
  describe('cleanRecordPayload', () => {
    it('should strip null, undefined, empty strings, and links', () => {
      const payload = {
        id: '123',
        name: 'John Doe',
        emptyStr: '',
        nullVal: null,
        undefVal: undefined,
        links: [
          { rel: 'self', href: 'http://localhost' }
        ],
        sublist: [
          { line: 1, item: 'A', links: [], nullField: null },
          { line: 2, item: 'B', emptyField: '' }
        ],
        address: {
          city: 'New York',
          zip: null,
          links: [{ rel: 'edit' }]
        }
      };

      const expected = {
        id: '123',
        name: 'John Doe',
        sublist: [
          { line: 1, item: 'A' },
          { line: 2, item: 'B' }
        ],
        address: {
          city: 'New York'
        }
      };

      expect(cleanRecordPayload(payload)).toEqual(expected);
    });

    it('should preserve false and 0 values', () => {
      const payload = {
        isMain: false,
        amount: 0,
        nullVal: null
      };

      const expected = {
        isMain: false,
        amount: 0
      };

      expect(cleanRecordPayload(payload)).toEqual(expected);
    });

    it('should return empty object/array when everything is stripped', () => {
      const payloadObj = {
        links: [{ rel: 'self' }],
        nullVal: null
      };
      expect(cleanRecordPayload(payloadObj)).toEqual({});

      const payloadArr = [
        { links: [] },
        null
      ];
      expect(cleanRecordPayload(payloadArr)).toEqual([]);
    });
  });

  describe('formatMetadataToCompactMarkdown', () => {
    it('should convert standard properties schema to Markdown table', () => {
      const schema = {
        properties: {
          id: { title: 'Internal ID', type: 'string', nullable: false },
          email: { title: 'Email Address', type: 'string', description: 'Primary email\nUsed for login.', nullable: true },
          customObj: {
            title: 'Custom Ref',
            type: 'object',
            properties: {
              refId: { type: 'string' }
            }
          }
        }
      };

      const md = formatMetadataToCompactMarkdown(schema);
      expect(md).toContain('| Field | Type | Description | Nullable |');
      expect(md).toContain('| id | string | Internal ID | No |');
      expect(md).toContain('| email | string | Primary email Used for login. | Yes |');
      expect(md).toContain('| customObj | object (refId) | Custom Ref | Yes |');
    });

    it('should handle metadata wrapper object', () => {
      const wrapped = {
        success: true,
        metadata: {
          properties: {
            name: { title: 'Name', type: 'string' }
          }
        }
      };

      const md = formatMetadataToCompactMarkdown(wrapped);
      expect(md).toContain('| name | string | Name | Yes |');
    });

    it('should unwrap content wrapper structure', () => {
      const contentWrapper = {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              properties: {
                status: { title: 'Status', type: 'string' }
              }
            })
          }
        ]
      };

      const md = formatMetadataToCompactMarkdown(contentWrapper);
      expect(md).toContain('| status | string | Status | Yes |');
    });

    it('should fallback to stringification if schema format is unrecognized', () => {
      const badSchema = { weirdKey: 'no properties' };
      const md = formatMetadataToCompactMarkdown(badSchema);
      expect(md).toContain('weirdKey');
      expect(md).toContain('no properties');
    });
  });
});
