import { describe, expect, it } from 'vitest';

import { boolValue, evaluateScript, normalizeRegion, variantFillScript } from './draft.js';

describe('tk-seller draft helpers', () => {
    it('normalizes region codes and rejects malformed values', () => {
        expect(normalizeRegion('my')).toBe('MY');
        expect(() => normalizeRegion('Malaysia')).toThrow(/two-letter/);
    });

    it('parses explicit save values without making save the default', () => {
        expect(boolValue(undefined)).toBe(false);
        expect(boolValue(false)).toBe(false);
        expect(boolValue('true')).toBe(true);
    });

    it('builds a fill script without publish actions', () => {
        const script = evaluateScript({
            sku: 'SKU-1',
            title: 'Product',
            description: 'Description',
            price: 10,
            stock: 3,
            product_language: 'English',
        });
        expect(script).toContain('product_name');
        expect(script).not.toContain("text === 'publish'");
        expect(script).not.toContain('发布按钮');
    });

    it('builds a variant-grid script for SKU, price, and stock only', () => {
        const script = variantFillScript([
            { sku: 'SKU-BLK', name: '黑色', options: { 颜色: '黑色' }, price: 15.5, stock: 12 },
        ]);
        expect(script).toContain('SKU-BLK');
        expect(script).toContain('skuInputsFilled');
        expect(script).not.toContain('publish');
    });
});
