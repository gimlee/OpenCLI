import { describe, expect, it } from 'vitest';

import { boolValue, draftStatusScript, evaluateScript, normalizeRegion, pimRequest, sellerLanguageLabel, variantFillScript } from './draft.js';
import { booleanValue, freeLocalPort, runtimeOptions } from './playwright-runtime.js';

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

    it('maps UnoPIM content languages to exact TikTok Seller source-language labels', () => {
        expect(sellerLanguageLabel('Chinese (Simplified)')).toBe('中文');
        expect(sellerLanguageLabel('zh_CN')).toBe('中文');
        expect(sellerLanguageLabel('Malay')).toBe('马来语');
        expect(sellerLanguageLabel('ms_MY')).toBe('马来语');
        expect(sellerLanguageLabel('English')).toBe('英语');
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

    it('builds syntactically valid save-draft status probes', () => {
        expect(() => new Function(`return ${draftStatusScript()}`)).not.toThrow();
        expect(() => new Function(`return ${draftStatusScript(true)}`)).not.toThrow();
    });

    it('uses a dedicated persistent Playwright profile without OpenCLI browser state', () => {
        expect(booleanValue('true')).toBe(true);
        expect(booleanValue(undefined, false)).toBe(false);
        const options = runtimeOptions({
            'browser-executable-path': 'C:/Chrome/chrome.exe',
            'user-data-dir': 'D:/tk-seller-test-profile',
            headless: 'true',
        });
        expect(options.executablePath).toBe('C:/Chrome/chrome.exe');
        expect(options.userDataDir).toMatch(/tk-seller-test-profile$/);
        expect(options.headless).toBe(true);
    });

    it('allocates a local CDP port for a normal Chrome launch', async () => {
        const port = await freeLocalPort();
        expect(port).toBeGreaterThan(0);
        expect(port).toBeLessThan(65536);
    });

    it('allows slow UnoPIM listing preparation beyond the old 15 second limit', async () => {
        const originalFetch = globalThis.fetch;
        let timeoutSignal;
        globalThis.fetch = async (_url, options) => {
            timeoutSignal = options.signal;
            return new Response(JSON.stringify({ success: true, data: { attempt_id: 'attempt-1' } }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        };

        try {
            await expect(pimRequest(
                'http://127.0.0.1:8020',
                'token',
                '/api/opencli/listings/start',
                { sku: 'SKU-1' },
                180_000,
            )).resolves.toEqual({ attempt_id: 'attempt-1' });
            expect(timeoutSignal).toBeInstanceOf(AbortSignal);
            expect(timeoutSignal.aborted).toBe(false);
        }
        finally {
            globalThis.fetch = originalFetch;
        }
    });
});
