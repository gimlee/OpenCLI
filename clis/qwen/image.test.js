import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    isQwenResultImageUrl,
    qwenImageKey,
    resolveQwenOutputDir,
    stripQwenOssProcess,
} from './image.js';

describe('qwen image download helpers', () => {
    it('defaults downloads to the current working directory and expands home paths', () => {
        expect(resolveQwenOutputDir()).toBe(process.cwd());
        expect(resolveQwenOutputDir('~')).toBe(os.homedir());
        expect(resolveQwenOutputDir('~/tmp/qwen-images')).toBe(path.join(os.homedir(), 'tmp', 'qwen-images'));
    });

    it('only accepts generated Qwen PNG result URLs', () => {
        expect(isQwenResultImageUrl(
            'https://workspace-zb-cdn.qianwen.com/abc/o/1784542362094.png?auth_key=x',
        )).toBe(true);
        expect(isQwenResultImageUrl(
            'https://www.qianwen.com/workspace/o/1784542362094.png?auth_key=x',
        )).toBe(true);
        expect(isQwenResultImageUrl(
            'https://workspace-zb-cdn.qianwen.com/abc/o/1784542362094.jpg?auth_key=x',
        )).toBe(false);
        expect(isQwenResultImageUrl(
            'https://images.quark.cn/s/uae/g/1y/fea/prod/file/example.png',
        )).toBe(false);
        expect(isQwenResultImageUrl(
            'https://img.alicdn.com/imgextra/i1/example.png',
        )).toBe(false);
    });

    it('strips OSS rendering parameters so the original image URL is fetched', () => {
        const original = 'https://workspace-zb-cdn.qianwen.com/abc/o/123.png?auth_key=K';
        const webpVariant = `${original}&x-oss-process=image/format,webp`;

        expect(stripQwenOssProcess(webpVariant)).toBe(original);
        expect(qwenImageKey(webpVariant)).toBe(qwenImageKey(original));
    });
});
