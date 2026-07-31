import * as os from 'node:os';
import * as path from 'node:path';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { saveBase64ToFile } from '@jackwener/opencli/utils';
import { ArgumentError, CommandExecutionError, EmptyResultError, TimeoutError } from '@jackwener/opencli/errors';
import {
    QIANWEN_DOMAIN,
    authRequired,
    dismissLoginModal,
    ensureOnQianwen,
    hasLoginGate,
    normalizeBooleanFlag,
    sendMessage,
    setFeatureToggle,
    startNewChat,
} from './utils.js';

function displayPath(filePath) {
    const home = os.homedir();
    return filePath.startsWith(home) ? `~${filePath.slice(home.length)}` : filePath;
}

function extFromMime(mime) {
    if (!mime) return '.jpg';
    if (mime.includes('png')) return '.png';
    if (mime.includes('webp')) return '.webp';
    if (mime.includes('gif')) return '.gif';
    return '.jpg';
}

export function resolveQwenOutputDir(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return process.cwd();
    if (raw === '~') return os.homedir();
    if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2));
    return path.resolve(raw);
}

export function stripQwenOssProcess(url) {
    try {
        const parsed = new URL(String(url || ''));
        let changed = false;
        for (const key of [...parsed.searchParams.keys()]) {
            if (key.toLowerCase() === 'x-oss-process') {
                parsed.searchParams.delete(key);
                changed = true;
            }
        }
        return changed ? parsed.toString() : String(url || '');
    } catch {
        return String(url || '');
    }
}

export function isQwenResultImageUrl(url) {
    const raw = String(url || '').trim();
    if (!raw || raw.startsWith('data:') || /^blob:/i.test(raw)) return false;
    if (/\.svg(?:[?#]|$)/i.test(raw)) return false;
    const lowered = raw.toLowerCase();
    if (lowered.includes('images.quark.cn') || lowered.includes('alicdn.com')) return false;
    try {
        const parsed = new URL(raw, 'https://www.qianwen.com/');
        const host = parsed.hostname.toLowerCase();
        const pathName = parsed.pathname.toLowerCase();
        const isWorkspaceCdn = host === 'workspace-zb-cdn.qianwen.com';
        const isQianwenObject = (host === 'qianwen.com' || host.endsWith('.qianwen.com')) && pathName.includes('/o/');
        return (isWorkspaceCdn || isQianwenObject) && pathName.endsWith('.png');
    } catch {
        return false;
    }
}

export function qwenImageKey(url) {
    const cleaned = stripQwenOssProcess(url);
    try {
        const parsed = new URL(cleaned);
        return `${parsed.hostname}${parsed.pathname}${parsed.search}`;
    } catch {
        return cleaned.replace(/^https?:\/\//i, '');
    }
}

function sniffImageMimeFromBuffer(data, fallback) {
    try {
        if (data.length >= 8 && data[0] === 0x89 && data.slice(1, 4).toString('ascii') === 'PNG') return 'image/png';
        if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
        if (data.length >= 12 && data.slice(0, 4).toString('ascii') === 'RIFF' && data.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
        if (data.length >= 4 && data.slice(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
    } catch {
        // Keep the server-provided type if sniffing cannot inspect the payload.
    }
    return fallback || 'image/jpeg';
}

function sniffImageMimeFromBase64(base64, fallback) {
    try {
        return sniffImageMimeFromBuffer(Buffer.from(String(base64 || '').slice(0, 64), 'base64'), fallback);
    } catch {
        return fallback || 'image/jpeg';
    }
}

async function collectImageCandidates(page) {
    const items = await page.evaluate(`(() => {
    const isVisible = (node) => {
      if (!(node instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const normalizeUrl = (value) => {
      const raw = String(value || '').trim();
      if (!raw || raw === 'none') return '';
      if (/^(?:https?:|blob:|data:)/i.test(raw)) return raw;
      try { return new URL(raw, window.location.href).href; } catch { return raw; }
    };
    const isQwenResultImageUrl = (value) => {
      const raw = String(value || '').trim();
      if (!raw || raw.startsWith('data:') || /^blob:/i.test(raw)) return false;
      if (/\\.svg(?:[?#]|$)/i.test(raw)) return false;
      const lowered = raw.toLowerCase();
      if (lowered.includes('images.quark.cn') || lowered.includes('alicdn.com')) return false;
      try {
        const parsed = new URL(raw, window.location.href);
        const host = parsed.hostname.toLowerCase();
        const pathName = parsed.pathname.toLowerCase();
        const isWorkspaceCdn = host === 'workspace-zb-cdn.qianwen.com';
        const isQianwenObject = (host === 'qianwen.com' || host.endsWith('.qianwen.com')) && pathName.includes('/o/');
        return (isWorkspaceCdn || isQianwenObject) && pathName.endsWith('.png');
      } catch {
        return false;
      }
    };
    const stripOssProcess = (value) => {
      try {
        const parsed = new URL(value, window.location.href);
        for (const key of Array.from(parsed.searchParams.keys())) {
          if (key.toLowerCase() === 'x-oss-process') parsed.searchParams.delete(key);
        }
        return parsed.href;
      } catch {
        return value;
      }
    };
    const keyOf = (value) => {
      const cleaned = stripOssProcess(value);
      try {
        const parsed = new URL(cleaned, window.location.href);
        return parsed.hostname + parsed.pathname + parsed.search;
      } catch {
        return cleaned.replace(/^https?:\\/\\//i, '');
      }
    };
    const add = (out, value, width = 0, height = 0) => {
      const url = normalizeUrl(value);
      if (!isQwenResultImageUrl(url)) return;
      const key = keyOf(url);
      if (out.some((item) => item.key === key)) return;
      out.push({ url, key, width: Number(width || 0), height: Number(height || 0) });
    };
    const resultRoots = Array.from(document.querySelectorAll(
      '[data-message-id]:has(.card_card_ai_generate_image), [data-chat-answers-wrap], [data-msgid$="-answer"]'
    )).filter((node) => node instanceof HTMLElement && isVisible(node));
    const scopes = resultRoots.length ? resultRoots : [document.body].filter(Boolean);
    const out = [];
    for (const scope of scopes) {
      for (const anchor of Array.from(scope.querySelectorAll('a[href]'))) {
        add(out, anchor.href || anchor.getAttribute('href') || '');
      }
      for (const img of Array.from(scope.querySelectorAll('img'))) {
        if (!(img instanceof HTMLImageElement) || !isVisible(img)) continue;
        const width = img.naturalWidth || img.width || 0;
        const height = img.naturalHeight || img.height || 0;
        if (width < 180 || height < 180) continue;
        add(out, img.currentSrc || img.src || img.getAttribute('src') || '', width, height);
      }
    }
    return out;
  })()`);
    if (!Array.isArray(items)) return [];
    const seen = new Set();
    const candidates = [];
    for (const item of items) {
        const url = String(item?.url || '');
        if (!isQwenResultImageUrl(url)) continue;
        const key = qwenImageKey(url);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({
            url,
            key,
            width: Number(item?.width || 0),
            height: Number(item?.height || 0),
        });
    }
    return candidates;
}

async function waitForImageCandidates(page, beforeKeys, timeoutSeconds) {
    const startTime = Date.now();
    let lastCandidates = [];
    while (Date.now() - startTime < timeoutSeconds * 1000) {
        await page.wait(2);
        if (await hasLoginGate(page)) return { status: 'auth_required', urls: [] };
        const candidates = (await collectImageCandidates(page)).filter((item) => !beforeKeys.has(item.key));
        const key = candidates.map((item) => `${item.key}:${item.width}x${item.height}`).join('\n');
        const lastKey = lastCandidates.map((item) => `${item.key}:${item.width}x${item.height}`).join('\n');
        if (candidates.length && key === lastKey) {
            return { status: 'ok', urls: candidates.map((item) => stripQwenOssProcess(item.url)), candidates };
        }
        if (candidates.length) {
            await page.wait(2);
            const candidates2 = (await collectImageCandidates(page)).filter((item) => !beforeKeys.has(item.key));
            const key2 = candidates2.map((item) => `${item.key}:${item.width}x${item.height}`).join('\n');
            if (key2 && key2 === key) {
                return { status: 'ok', urls: candidates2.map((item) => stripQwenOssProcess(item.url)), candidates: candidates2 };
            }
            lastCandidates = candidates2;
            continue;
        }
        lastCandidates = candidates;
    }
    return lastCandidates.length
        ? { status: 'partial', urls: lastCandidates.map((item) => stripQwenOssProcess(item.url)), candidates: lastCandidates }
        : { status: 'timeout', urls: [], candidates: [] };
}

async function fetchImageAsset(page, url) {
    const asset = await page.evaluate(`(async () => {
    try {
      const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      if (!res.ok) return { ok: false, status: res.status };
      const mime = res.headers.get('content-type') || '';
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return { ok: true, mime, base64: btoa(binary) };
    } catch (error) {
      return { ok: false, status: 0, error: String(error?.message || error) };
    }
  })()`);
    if (asset?.ok) {
        asset.mime = sniffImageMimeFromBase64(asset.base64, String(asset.mime || '').split(';', 1)[0]);
    }
    return asset;
}

async function fetchImageAssetWithNode(url) {
    try {
        const response = await fetch(url, {
            headers: {
                accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
                referer: 'https://www.qianwen.com/',
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
            },
            signal: AbortSignal.timeout(45_000),
        });
        if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}` };
        const bytes = Buffer.from(await response.arrayBuffer());
        const headerMime = String(response.headers.get('content-type') || '').split(';', 1)[0];
        const mime = sniffImageMimeFromBuffer(bytes, headerMime);
        if (!String(mime || '').startsWith('image/')) {
            return { ok: false, status: response.status, error: `Not an image response: ${mime || headerMime || 'unknown'}` };
        }
        return { ok: true, mime, base64: bytes.toString('base64') };
    } catch (error) {
        return { ok: false, status: 0, error: String(error?.message || error) };
    }
}

async function fetchBestImageAsset(page, url) {
    const candidates = Array.from(new Set([stripQwenOssProcess(url), url].filter(Boolean)));
    let lastFailure = null;
    for (const candidateUrl of candidates) {
        const asset = await fetchImageAssetWithNode(candidateUrl);
        if (asset?.ok && String(asset.mime || '').startsWith('image/')) {
            return { ...asset, url: candidateUrl };
        }
        lastFailure = asset;
        const pageAsset = await fetchImageAsset(page, candidateUrl);
        if (pageAsset?.ok && String(pageAsset.mime || '').startsWith('image/')) {
            return { ...pageAsset, url: candidateUrl };
        }
        lastFailure = pageAsset || lastFailure;
    }
    return lastFailure || { ok: false, status: 0 };
}

cli({
    site: 'qwen',
    name: 'image',
    access: 'write',
    description: 'Generate images with Qianwen (AI生图) and save them locally',
    domain: QIANWEN_DOMAIN,
    strategy: Strategy.COOKIE,
    browser: true,
    siteSession: 'persistent',
    navigateBefore: false,
    defaultFormat: 'plain',
    args: [
        { name: 'prompt', required: true, positional: true, help: 'Image prompt to send' },
        { name: 'op', default: '.', help: 'Output directory (default: current directory)' },
        { name: 'new', type: 'boolean', default: true, help: 'Start a new chat before generating (default: true)' },
        { name: 'sd', type: 'boolean', default: false, help: 'Skip download; only show the Qianwen link' },
        { name: 'timeout', type: 'int', default: 180, help: 'Max seconds to wait for the image response' },
    ],
    columns: ['Status', 'File', 'Link'],
    func: async (page, kwargs) => {
        const prompt = String(kwargs.prompt || '').trim();
        if (!prompt) throw new ArgumentError('prompt is required');
        const outputDir = resolveQwenOutputDir(kwargs.op);
        const startFresh = normalizeBooleanFlag(kwargs.new, true);
        const skipDownload = normalizeBooleanFlag(kwargs.sd, false);
        const timeout = Number(kwargs.timeout ?? 180);
        if (!Number.isInteger(timeout) || timeout <= 0) {
            throw new ArgumentError('timeout must be a positive integer');
        }

        await ensureOnQianwen(page);
        await dismissLoginModal(page);
        if (startFresh) {
            await startNewChat(page);
            await dismissLoginModal(page);
        }
        await setFeatureToggle(page, 'image', true);
        await page.wait(0.5);
        const beforeKeys = new Set((await collectImageCandidates(page)).map((item) => item.key));

        const send = await sendMessage(page, prompt);
        if (!send?.ok) {
            if (await hasLoginGate(page)) throw authRequired();
            throw new CommandExecutionError(send?.reason || 'Failed to send Qianwen image prompt');
        }

        const waitResult = await waitForImageCandidates(page, beforeKeys, timeout);
        const link = await page.evaluate('window.location.href').catch(() => 'https://www.qianwen.com/');
        if (waitResult.status === 'auth_required') throw authRequired();
        if (waitResult.status === 'timeout') {
            throw new TimeoutError('qianwen image', timeout, 'No generated images observed before timeout.');
        }

        const urls = waitResult.urls;
        if (skipDownload) {
            return [{ Status: '🎨 generated', File: null, Link: link }];
        }

        const stamp = Date.now();
        const results = [];
        for (let i = 0; i < urls.length; i += 1) {
            const url = urls[i];
            const asset = await fetchBestImageAsset(page, url);
            if (!asset?.ok) {
                throw new CommandExecutionError(`Failed to fetch generated Qianwen image ${i + 1}: status=${asset?.status ?? '?'}, error=${asset?.error || 'unknown'}`);
            }
            const suffix = urls.length > 1 ? `_${i + 1}` : '';
            const ext = extFromMime(asset.mime);
            const filePath = path.join(outputDir, `qianwen_${stamp}${suffix}${ext}`);
            await saveBase64ToFile(asset.base64, filePath);
            results.push({ Status: '✅ saved', File: displayPath(filePath), Link: link });
        }
        if (!results.length) {
            throw new EmptyResultError('qwen image', 'No generated images were available to download.');
        }
        return results;
    },
});
