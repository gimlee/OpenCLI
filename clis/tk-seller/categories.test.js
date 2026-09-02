import { describe, expect, it } from 'vitest';

import { normalizeCategoryTree, normalizeRegion, versionFromDate } from './categories.js';

describe('tk-seller categories helpers', () => {
    it('normalizes a flat TikTok response into deterministic paths', () => {
        const manifest = normalizeCategoryTree([
            { id: '20', parent_id: '10', name: '手机配件', level: 2, is_leaf: true, unauthorized: false },
            { id: '10', parent_id: '0', name: '手机与数码', level: 1, is_leaf: false, unauthorized: false },
        ], { region: 'my', capturedAt: '2026-09-01T12:34:56.000Z' });

        expect(manifest.region).toBe('MY');
        expect(manifest.category_count).toBe(2);
        expect(manifest.categories[1].path).toBe('手机与数码 > 手机配件');
        expect(manifest.categories[1].parent_external_id).toBe('10');
    });

    it('preserves disabled and unauthorized category state', () => {
        const manifest = normalizeCategoryTree([
            { id: '10', parent_id: '0', name: '家居用品', level: 1, is_leaf: true, unauthorized: true, disable_reasons: [2] },
        ], { region: 'MY', capturedAt: '2026-09-01T12:34:56.000Z' });

        expect(manifest.categories[0].enabled).toBe(false);
        expect(manifest.categories[0].disable_reasons).toEqual([2]);
    });

    it('validates market codes and creates timestamped versions', () => {
        expect(normalizeRegion('th')).toBe('TH');
        expect(() => normalizeRegion('Malaysia')).toThrow(/two-letter/);
        expect(versionFromDate(new Date('2026-09-01T12:34:56.000Z'))).toMatch(/^2026\.09\.01\./);
    });
});
