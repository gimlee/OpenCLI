import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { withPlaywrightPage } from './playwright-runtime.js';
import { PopupManager } from './popup-manager.js';

const SELLER_DOMAIN = 'seller.tiktokshopglobalselling.com';
const ALL_CATEGORIES_ENDPOINT = '/api/v1/product/product_creation/preload_all_categories';

function normalizeRegion(value) {
    const region = String(value || 'MY').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(region)) {
        throw new ArgumentError('region must be a two-letter market code such as MY or TH');
    }
    return region;
}

function versionFromDate(value = new Date()) {
    const parts = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(value);
    const get = (type) => parts.find((part) => part.type === type)?.value || '00';
    return `${get('year')}.${get('month')}.${get('day')}.${get('hour')}${get('minute')}${get('second')}`;
}

function normalizeCategoryTree(rawCategories, options = {}) {
    const categories = Array.isArray(rawCategories) ? rawCategories : [];
    const rows = categories
        .map((item) => {
            const externalId = String(item?.id || '').trim();
            const name = String(item?.name || '').replace(/\s+/g, ' ').trim();
            if (!externalId || !name) return null;
            const disableReasons = Array.isArray(item.disable_reasons) ? item.disable_reasons : [];
            return {
                external_id: externalId,
                parent_external_id: String(item.parent_id || '0'),
                name,
                level: Number(item.level) || 1,
                is_leaf: Boolean(item.is_leaf),
                enabled: item.unauthorized !== true && item.is_displayed !== false && disableReasons.length === 0,
                unauthorized: Boolean(item.unauthorized),
                is_displayed: item.is_displayed !== false,
                disable_reasons: disableReasons,
                sale_platforms: (Array.isArray(item.sale_platform_categories) ? item.sale_platform_categories : [])
                    .map((entry) => Number(entry?.sale_platform))
                    .filter(Number.isFinite),
            };
        })
        .filter(Boolean);
    const byId = new Map(rows.map((item) => [item.external_id, item]));
    const pathFor = (item) => {
        const names = [];
        const seen = new Set();
        let current = item;
        while (current && !seen.has(current.external_id)) {
            seen.add(current.external_id);
            names.unshift(current.name);
            current = current.parent_external_id === '0' ? null : byId.get(current.parent_external_id);
        }
        return names.join(' > ');
    };
    const normalized = rows
        .map((item) => ({ ...item, path: pathFor(item) }))
        .sort((left, right) => left.level - right.level || left.path.localeCompare(right.path, 'zh-CN'));
    const capturedAt = options.capturedAt || new Date().toISOString();
    return {
        version: options.version || versionFromDate(new Date(capturedAt)),
        captured_at: capturedAt,
        platform: 'tiktok',
        region: normalizeRegion(options.region),
        interface_locale: options.interfaceLocale || 'zh_CN',
        marketplace_locale: options.marketplaceLocale || null,
        source_url: options.sourceUrl || '',
        category_count: normalized.length,
        categories: normalized,
    };
}

async function waitForSellerPage(page, loginWaitSeconds) {
    const deadline = Date.now() + Math.max(0, Number(loginWaitSeconds) || 0) * 1000;
    for (;;) {
        const state = await page.evaluate(`(() => ({
          currentHref: location.href,
          needsPassword: Boolean(document.querySelector('input[type="password"]')),
          needsVerification: Array.from(document.querySelectorAll('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i]'))
            .some((node) => node.offsetParent !== null && getComputedStyle(node).visibility !== 'hidden')
            || /请完成安全验证|请输入验证码|security verification|verify your identity/i.test(String(document.body?.innerText || '').slice(0, 3000)),
        }))()`);
        const loginRequired = state.needsPassword || state.needsVerification
            || /login|passport|accounts/i.test(String(state.currentHref || ''));
        if (!loginRequired) return state;
        if (Date.now() >= deadline) {
            throw new AuthRequiredError(
                SELLER_DOMAIN,
                'Complete login/security verification in the Playwright Chrome window; the command will continue waiting until --login-wait-seconds expires',
            );
        }
        await page.sleep(2);
    }
}

function categoryResponsePromise(page, timeoutMs) {
    return new Promise((resolveResponse, reject) => {
        const timer = setTimeout(() => {
            reject(new CommandExecutionError('TikTok Shop did not return its full category taxonomy in time'));
        }, timeoutMs);
        const listener = async (response) => {
            if (!response.url().includes(ALL_CATEGORIES_ENDPOINT) || response.status() !== 200) return;
            try {
                const payload = await response.json();
                if (!Array.isArray(payload?.categories)) return;
                clearTimeout(timer);
                page.off('response', listener);
                resolveResponse(payload.categories);
            }
            catch {}
        };
        page.on('response', listener);
    });
}

cli({
    site: 'tk-seller',
    name: 'categories',
    access: 'write',
    description: 'Capture the complete TikTok Shop regional category taxonomy from the authenticated product page',
    example: 'opencli tk-seller categories --region MY --output E:\\github\\product-info-management\\config\\tiktok-my-category-tree.json',
    domain: SELLER_DOMAIN,
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'region', default: 'MY', help: 'TikTok Shop market code, e.g. MY or TH' },
        { name: 'output', required: true, help: 'Destination JSON file for the complete category taxonomy' },
        { name: 'browser-executable-path', help: 'Chrome executable used by Playwright (or TIKTOK_BROWSER_EXECUTABLE_PATH)' },
        { name: 'user-data-dir', help: 'Dedicated persistent TikTok Chrome profile (or TIKTOK_BROWSER_USER_DATA_DIR)' },
        { name: 'headless', type: 'boolean', default: false, help: 'Run Playwright without a visible browser window' },
        { name: 'login-wait-seconds', type: 'int', default: 600, help: 'Pause for manual login/security verification in the visible Playwright window' },
        { name: 'artifacts-dir', help: 'Directory for Playwright traces and failure screenshots' },
    ],
    columns: ['status', 'region', 'version', 'categories', 'roots', 'leaves', 'enabled', 'output'],
    func: async (kwargs) => {
        const region = normalizeRegion(kwargs.region);
        const output = String(kwargs.output || '').trim();
        if (!output) throw new ArgumentError('output is required');
        const outputPath = resolve(output);
        const waitSeconds = Math.max(0, Number(kwargs['login-wait-seconds']) || 0);
        const attemptId = `categories-${region.toLowerCase()}-${Date.now()}`;
        const sourceUrl = `https://${SELLER_DOMAIN}/product/create?channel=manage&shop_region=${region}`;
        return await withPlaywrightPage(kwargs, attemptId, async (adapter) => {
            const page = adapter.rawPage;
            const popupManager = new PopupManager(adapter, {
                waitSeconds,
                interactive: String(kwargs.headless).toLowerCase() !== 'true',
            });
            const allCategories = categoryResponsePromise(page, Math.max(30_000, waitSeconds * 1000));
            await adapter.goto(`${sourceUrl}&opencli_category_sync=${Date.now()}`, { waitUntil: 'load', settleMs: 5000 });
            const state = await waitForSellerPage(adapter, waitSeconds);
            if (!String(state.currentHref || '').includes(SELLER_DOMAIN)) {
                throw new CommandExecutionError(`TikTok Shop redirected to an unexpected page: ${state.currentHref || '(unknown)'}`);
            }
            await popupManager.checkpoint('category taxonomy page');
            const selector = page.locator('#product-cascader-select-view');
            try {
                await selector.waitFor({ state: 'visible', timeout: Math.max(60_000, waitSeconds * 1000) });
            }
            catch {
                throw new CommandExecutionError('TikTok Shop product category selector was not found after the product form finished loading');
            }
            if (await selector.count() !== 1) {
                throw new CommandExecutionError('TikTok Shop product category selector was not uniquely identifiable');
            }
            await selector.click();
            await popupManager.checkpoint('category selector opened');
            const capturedAt = new Date().toISOString();
            const categories = await allCategories;
            const manifest = normalizeCategoryTree(categories, {
                region,
                capturedAt,
                sourceUrl,
                interfaceLocale: 'zh_CN',
                marketplaceLocale: region === 'MY' ? 'ms_MY' : null,
            });
            mkdirSync(dirname(outputPath), { recursive: true });
            writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
            return [{
                status: 'captured',
                region,
                version: manifest.version,
                categories: manifest.category_count,
                roots: manifest.categories.filter((item) => item.level === 1).length,
                leaves: manifest.categories.filter((item) => item.is_leaf).length,
                enabled: manifest.categories.filter((item) => item.enabled).length,
                output: outputPath,
            }];
        });
    },
});

export { normalizeCategoryTree, normalizeRegion, versionFromDate };
