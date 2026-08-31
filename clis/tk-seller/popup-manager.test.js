import { describe, expect, it, vi } from 'vitest';

import { PopupManager, classifyPopupSnapshot, popupInspectionScript } from './popup-manager.js';

function popup(text, buttons = []) {
    return { id: 'popup-0', text, buttons };
}

function pageWithSnapshots(snapshots, locator = null) {
    let index = 0;
    return {
        evaluate: vi.fn(async () => snapshots[Math.min(index++, snapshots.length - 1)]),
        rawPage: {
            locator: vi.fn(() => locator || {
                count: vi.fn(async () => 0),
                click: vi.fn(async () => {}),
            }),
            waitForTimeout: vi.fn(async () => {}),
        },
    };
}

describe('TikTok Seller PopupManager', () => {
    it('builds a syntactically valid browser inspection script', () => {
        expect(() => new Function(`return ${popupInspectionScript()}`)).not.toThrow();
    });

    it('prioritizes security verification over other overlays', () => {
        const result = classifyPopupSnapshot({
            security: { visible: true, text: 'security verification' },
            overlays: [popup('平台公告', [{ id: 'button-0', text: '知道了' }])],
        });
        expect(result.action).toBe('wait_security');
    });

    it('dismisses only an allow-listed button in a known safe context', () => {
        const result = classifyPopupSnapshot({
            security: { visible: false },
            overlays: [popup('欢迎使用，新手操作指引', [{ id: 'button-0', text: '我知道了', disabled: false }])],
        });
        expect(result.action).toBe('dismiss');
        expect(result.button.id).toBe('button-0');
    });

    it('blocks publish even when it appears in an otherwise safe dialog', () => {
        const result = classifyPopupSnapshot({
            security: { visible: false },
            overlays: [popup('欢迎使用，新手操作指引', [
                { id: 'button-0', text: '我知道了', disabled: false },
                { id: 'button-1', text: '发布', disabled: false },
            ])],
        });
        expect(result.action).toBe('block_dangerous');
    });

    it('requires a dedicated rule for consent and waits on unknown dialogs', () => {
        expect(classifyPopupSnapshot({
            security: { visible: false },
            overlays: [popup('请阅读并同意平台条款', [{ id: 'button-0', text: '同意' }])],
        }).action).toBe('require_explicit_consent');
        expect(classifyPopupSnapshot({
            security: { visible: false },
            overlays: [popup('无法分类的新消息', [{ id: 'button-0', text: '确定' }])],
        }).action).toBe('wait_unknown');
    });

    it('automatically closes a known safe popup and records the event', async () => {
        const click = vi.fn(async () => {});
        const locator = { count: vi.fn(async () => 1), click };
        const page = pageWithSnapshots([
            {
                security: { visible: false },
                overlays: [popup('系统公告', [{ id: 'popup-0-button-0', text: '关闭', disabled: false }])],
            },
            { security: { visible: false }, overlays: [] },
        ], locator);
        const manager = new PopupManager(page, { waitSeconds: 0, interactive: false });

        await manager.checkpoint('test field');

        expect(click).toHaveBeenCalledOnce();
        expect(manager.events).toMatchObject([{ kind: 'known', action: 'dismissed', label: 'test field' }]);
    });

    it('fails closed for an unknown dialog in non-interactive mode', async () => {
        const page = pageWithSnapshots([{
            security: { visible: false },
            overlays: [popup('无法分类的新消息', [{ id: 'button-0', text: '确定' }])],
        }]);
        const manager = new PopupManager(page, { waitSeconds: 0, interactive: false });

        await expect(manager.checkpoint('test field')).rejects.toThrow(/blocking dialog/i);
    });

    it('retries an interaction after an obstructing overlay error', async () => {
        const page = pageWithSnapshots([{ security: { visible: false }, overlays: [] }]);
        const manager = new PopupManager(page, { waitSeconds: 0, interactive: false });
        const action = vi.fn()
            .mockRejectedValueOnce(new Error('another element would receive the click'))
            .mockResolvedValue('done');

        await expect(manager.run(action, 'category')).resolves.toBe('done');
        expect(action).toHaveBeenCalledTimes(2);
    });
});
