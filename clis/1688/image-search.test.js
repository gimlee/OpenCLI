import { describe, expect, it } from 'vitest';
import { __test__ } from './image-search.js';

describe('1688 image search', () => {
    it('builds the official image result URL', () => {
        const url = new URL(__test__.buildImageSearchUrl('abc-123'));
        expect(url.hostname).toBe('air.1688.com');
        expect(url.searchParams.get('tab')).toBe('imageSearch');
        expect(url.searchParams.get('imageId')).toBe('abc-123');
        expect(url.searchParams.get('imageIdList')).toBe('abc-123');
    });

    it('reads image ids from current and legacy mtop response shapes', () => {
        expect(__test__.extractImageId({ data: { data: { imageId: 'current' } } })).toBe('current');
        expect(__test__.extractImageId({ data: { imageId: 'legacy' } })).toBe('legacy');
    });

    it('downloads a remote image input', async () => {
        const bytes = await __test__.readImageInput('https://example.com/item.webp', async () => new Response(new Uint8Array([1, 2, 3])));
        expect([...bytes]).toEqual([1, 2, 3]);
    });
});
