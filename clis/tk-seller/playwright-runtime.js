import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

import { CommandExecutionError } from '@jackwener/opencli/errors';
import { chromium } from 'playwright-core';

const DEFAULT_CHROME_PATH = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const DEFAULT_PROFILE_DIR = String.raw`D:\tk-seller-playwright-profile`;

function booleanValue(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function runtimeOptions(kwargs = {}) {
    const executablePath = String(
        kwargs['browser-executable-path']
        || process.env.TIKTOK_BROWSER_EXECUTABLE_PATH
        || DEFAULT_CHROME_PATH,
    );
    const userDataDir = resolve(String(
        kwargs['user-data-dir']
        || process.env.TIKTOK_BROWSER_USER_DATA_DIR
        || DEFAULT_PROFILE_DIR,
    ));
    const artifactsDir = resolve(String(
        kwargs['artifacts-dir']
        || process.env.TIKTOK_PLAYWRIGHT_ARTIFACTS_DIR
        || 'artifacts/tk-seller',
    ));
    return {
        executablePath,
        userDataDir,
        artifactsDir,
        headless: booleanValue(kwargs.headless, false),
    };
}

function createPageAdapter(page) {
    return {
        rawPage: page,
        async evaluate(script) {
            return await page.evaluate(script);
        },
        async goto(url, options = {}) {
            await page.goto(url, {
                waitUntil: options.waitUntil === 'none' ? 'commit' : (options.waitUntil || 'load'),
                timeout: 60_000,
            });
            if (Number(options.settleMs) > 0) {
                await page.waitForTimeout(Number(options.settleMs));
            }
        },
        async wait(options) {
            if (typeof options === 'number') {
                await page.waitForTimeout(options * 1000);
                return;
            }
            if (Number(options?.time) >= 0) {
                await page.waitForTimeout(Number(options.time) * 1000);
                return;
            }
            if (options?.selector) {
                await page.locator(options.selector).waitFor({
                    state: 'attached',
                    timeout: Number(options.timeout || 10) * 1000,
                });
                return;
            }
            if (options?.text) {
                await page.getByText(options.text, { exact: false }).first().waitFor({
                    state: 'visible',
                    timeout: Number(options.timeout || 30) * 1000,
                });
            }
        },
        async sleep(seconds) {
            await page.waitForTimeout(Number(seconds) * 1000);
        },
        async click(selector) {
            const locator = page.locator(selector);
            const matches = await locator.count();
            if (matches !== 1) {
                throw new CommandExecutionError(`Playwright click target must match exactly once; got ${matches}: ${selector}`);
            }
            await locator.click();
        },
        async fillText(selector, value) {
            const locator = page.locator(selector);
            const matches = await locator.count();
            if (matches !== 1) {
                throw new CommandExecutionError(`Playwright fill target must match exactly once; got ${matches}: ${selector}`);
            }
            await locator.fill(String(value));
        },
        async uploadFiles(selector, paths) {
            const locator = page.locator(selector);
            const matches = await locator.count();
            if (matches !== 1) {
                throw new CommandExecutionError(`Playwright file input must match exactly once; got ${matches}: ${selector}`);
            }
            const multiple = await locator.getAttribute('multiple') !== null;
            const accept = await locator.getAttribute('accept') || '';
            await locator.setInputFiles(paths);
            return {
                uploaded: true,
                files: paths.length,
                file_names: paths.map((path) => path.split(/[\\/]/).pop()),
                target: selector,
                matches_n: 1,
                match_level: 'exact',
                multiple,
                accept,
            };
        },
    };
}

async function freeLocalPort() {
    return await new Promise((resolvePort, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close((error) => error ? reject(error) : resolvePort(port));
        });
    });
}

async function launchNormalChrome(options) {
    const port = await freeLocalPort();
    const args = [
        `--remote-debugging-port=${port}`,
        '--remote-allow-origins=*',
        `--user-data-dir=${options.userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--lang=zh-CN',
        '--start-maximized',
    ];
    if (options.headless) args.push('--headless=new');
    args.push('about:blank');
    const chromeProcess = spawn(options.executablePath, args, {
        stdio: 'ignore',
        windowsHide: false,
    });
    let exitCode = null;
    chromeProcess.once('exit', (code) => { exitCode = code; });
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (exitCode !== null) {
            throw new CommandExecutionError(
                `TikTok Chrome exited during startup (code ${exitCode})`,
                `Close the Chrome window using this dedicated profile, then rerun: ${options.userDataDir}`,
            );
        }
        try {
            const response = await fetch(`${endpoint}/json/version`, { signal: AbortSignal.timeout(1000) });
            if (response.ok) return { chromeProcess, endpoint };
        }
        catch {}
        await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
    chromeProcess.kill();
    throw new CommandExecutionError(
        'TikTok Chrome did not expose its local debugging connection within 30 seconds',
        `Close the Chrome window using this dedicated profile, then rerun: ${options.userDataDir}`,
    );
}

async function withPlaywrightPage(kwargs, attemptId, task) {
    const options = runtimeOptions(kwargs);
    if (!existsSync(options.executablePath)) {
        throw new CommandExecutionError(`Chrome executable does not exist: ${options.executablePath}`);
    }
    mkdirSync(options.userDataDir, { recursive: true });
    mkdirSync(options.artifactsDir, { recursive: true });
    const tracePath = resolve(options.artifactsDir, `${attemptId}.zip`);
    const failureScreenshot = resolve(options.artifactsDir, `${attemptId}-failure.png`);
    let context;
    let page;
    let browser;
    let chromeProcess;
    try {
        const launched = await launchNormalChrome(options);
        chromeProcess = launched.chromeProcess;
        browser = await chromium.connectOverCDP(launched.endpoint);
        context = browser.contexts()[0];
        if (!context) throw new CommandExecutionError('TikTok Chrome did not expose a browser context');
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        page = context.pages().find((candidate) => candidate.url() === 'about:blank') || await context.newPage();
        page.setDefaultTimeout(20_000);
        page.setDefaultNavigationTimeout(60_000);
        return await task(createPageAdapter(page), { tracePath, failureScreenshot, userDataDir: options.userDataDir });
    }
    catch (error) {
        if (page && !page.isClosed()) {
            await page.screenshot({ path: failureScreenshot, fullPage: true }).catch(() => {});
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/user data directory is already in use|process singleton|profile.*in use/i.test(message)) {
            throw new CommandExecutionError(
                `TikTok Playwright profile is already in use: ${options.userDataDir}`,
                'Close the Chrome window using this dedicated profile, then rerun the command.',
            );
        }
        throw error;
    }
    finally {
        if (context) {
            await context.tracing.stop({ path: tracePath }).catch(() => {});
        }
        if (browser) await browser.close().catch(() => {});
        if (chromeProcess && chromeProcess.exitCode === null) chromeProcess.kill();
    }
}

export { booleanValue, createPageAdapter, freeLocalPort, runtimeOptions, withPlaywrightPage };
