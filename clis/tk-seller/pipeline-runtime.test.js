import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { ensureLocalPipeline, isLoopbackPipelineUrl, pipelineProjectCandidates } from './pipeline-runtime.js';

describe('tk-seller local pipeline runtime', () => {
    it('only auto-starts loopback pipeline URLs', () => {
        expect(isLoopbackPipelineUrl('http://127.0.0.1:8020')).toBe(true);
        expect(isLoopbackPipelineUrl('http://localhost:8020')).toBe(true);
        expect(isLoopbackPipelineUrl('https://pipeline.example.com')).toBe(false);
    });

    it('discovers an explicitly configured project directory first', () => {
        expect(pipelineProjectCandidates('C:/workspace/pim')[0]).toMatch(/workspace[\\/]pim$/);
    });

    it('reuses an already healthy pipeline without owning or stopping it', async () => {
        const startProcess = vi.fn();
        const runtime = await ensureLocalPipeline({
            baseUrl: 'http://127.0.0.1:8020',
            healthCheck: async () => true,
            startProcess,
        });

        expect(runtime.started).toBe(false);
        expect(startProcess).not.toHaveBeenCalled();
        await runtime.stop();
    });

    it('starts, waits for, and stops only the process it owns', async () => {
        const child = new EventEmitter();
        child.exitCode = null;
        child.killed = false;
        child.kill = vi.fn(() => {
            child.killed = true;
            child.exitCode = 0;
            child.emit('exit', 0);
        });
        let checks = 0;
        const runtime = await ensureLocalPipeline({
            baseUrl: 'http://127.0.0.1:18020',
            healthCheck: async () => ++checks >= 2,
            resolveProjectDir: () => 'C:/workspace/product-info-management',
            startProcess: () => child,
            sleep: async () => {},
        });

        expect(runtime.started).toBe(true);
        expect(runtime.projectDir).toMatch(/product-info-management$/);
        await runtime.stop();
        expect(child.kill).toHaveBeenCalledOnce();
    });
});
