import { describe, it, expect } from '@jest/globals';
import { generateNetSuiteUrl } from './netsuiteUrls.js';

describe('NetSuite UI URL Generation', () => {
  it('should return null if accountId or recordId is missing', () => {
    expect(generateNetSuiteUrl(undefined, 'customer', '123')).toBeNull();
    expect(generateNetSuiteUrl('123456', 'customer', undefined)).toBeNull();
  });

  it('should format host subdomain accurately', () => {
    const url = generateNetSuiteUrl('123456_SB1', 'customer', '789');
    expect(url).toContain('https://123456-sb1.app.netsuite.com');
  });

  it('should resolve standard mapped record types', () => {
    const custUrl = generateNetSuiteUrl('123456', 'customer', '100');
    expect(custUrl).toBe('https://123456.app.netsuite.com/app/common/entity/custjob.nl?id=100');

    const invUrl = generateNetSuiteUrl('123456', 'invoice', '200');
    expect(invUrl).toBe('https://123456.app.netsuite.com/app/accounting/transactions/custinvc.nl?id=200');
  });

  it('should handle custom records using rectype parameter', () => {
    const customTextUrl = generateNetSuiteUrl('123456', 'customrecord_my_script', '500');
    expect(customTextUrl).toBe('https://123456.app.netsuite.com/app/common/custom/custrecordentry.nl?rectype=customrecord_my_script&id=500');

    const customNumericUrl = generateNetSuiteUrl('123456', 'customrecord_type', '500', 105);
    expect(customNumericUrl).toBe('https://123456.app.netsuite.com/app/common/custom/custrecordentry.nl?rectype=105&id=500');
  });

  it('should fall back to standard transaction page if record type is unmapped', () => {
    const fallbackUrl = generateNetSuiteUrl('123456', 'unknown_type', '888');
    expect(fallbackUrl).toBe('https://123456.app.netsuite.com/app/accounting/transactions/transaction.nl?id=888');
  });
});
