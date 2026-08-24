import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { CommandExecutionError, EmptyResultError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import {
    assertAuthenticatedState, buildProvenance, canonicalizeItemUrl, canonicalizeSellerUrl, cleanText,
    extractLocation, extractMemberId, extractOfferId, extractShopId, gotoAndReadState, parseMoqText,
    parsePriceText, parseSearchLimit, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX,
} from './shared.js';

const IMAGE_UPLOAD_API = 'mtop.cbu.global.marketing.search.image.upload';
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.webp']);

export function buildImageSearchUrl(imageId) {
    const value = cleanText(imageId);
    if (!value) throw new CommandExecutionError('1688 image search did not receive an image id');
    const url = new URL('https://air.1688.com/kapp/1688-global/sales/search');
    url.searchParams.set('tab', 'imageSearch');
    url.searchParams.set('imageId', value);
    url.searchParams.set('imageIdList', value);
    return url.toString();
}

function validateImageSize(bytes) {
    if (!bytes.length) throw new CommandExecutionError('1688 image search received an empty image');
    if (bytes.length > MAX_IMAGE_BYTES) throw new CommandExecutionError('1688 image search image exceeds 30 MB');
    return bytes;
}

export async function readImageInput(input, fetchImpl = fetch) {
    const value = cleanText(input);
    if (!value) throw new CommandExecutionError('1688 image search requires an image URL or local file');
    if (/^https?:\/\//i.test(value)) {
        const response = await fetchImpl(value, { redirect: 'follow', signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new CommandExecutionError(`1688 image search could not download image (${response.status})`);
        return validateImageSize(Buffer.from(await response.arrayBuffer()));
    }
    const filePath = resolve(value);
    if (!ALLOWED_EXTENSIONS.has(extname(filePath).toLowerCase())) {
        throw new CommandExecutionError('1688 image search supports jpg, jpeg, png, bmp, and webp files');
    }
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw new CommandExecutionError(`1688 image search file does not exist: ${filePath}`);
    if (info.size > MAX_IMAGE_BYTES) throw new CommandExecutionError('1688 image search image exceeds 30 MB');
    return validateImageSize(await readFile(filePath));
}

export function extractImageId(payload) {
    return cleanText(payload?.data?.data?.imageId ?? payload?.data?.imageId ?? payload?.imageId);
}

function detectImageMime(bytes) {
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    if (bytes.subarray(0, 2).toString('ascii') === 'BM') return 'image/bmp';
    return 'image/jpeg';
}

async function uploadImage(page, imageBytes) {
    const state = await gotoAndReadState(page, 'https://www.1688.com/', 2200, 'image-search');
    assertAuthenticatedState(state, 'image-search');
    await page.evaluate(`
      (() => {
        const values = { oversealanguage: 'zh', oversearegion: 'GLOBAL', overseacurrency: 'CNY' };
        for (const [name, value] of Object.entries(values)) {
          document.cookie = name + '=' + value + '; path=/; domain=.1688.com; max-age=31536000; SameSite=Lax';
        }
        return true;
      })()
    `);
    const sourceDataUrl = `data:${detectImageMime(imageBytes)};base64,${imageBytes.toString('base64')}`;
    const payload = await page.evaluate(`
      (async () => {
        const mtop = window.lib && window.lib.mtop;
        if (!mtop || typeof mtop.request !== 'function') {
          return { error: 'MTOP_NOT_READY' };
        }
        try {
          const source = ${JSON.stringify(sourceDataUrl)};
          const image = await new Promise((resolve, reject) => {
            const node = new Image();
            node.onload = () => resolve(node);
            node.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'));
            node.src = source;
          });
          let width = image.naturalWidth || 1024;
          let height = image.naturalHeight || 1024;
          const maxSide = 360;
          if (width > maxSide && height > maxSide) {
            if (width < height) { height = Math.round(maxSide / width * height); width = maxSide; }
            else { width = Math.round(maxSide / height * width); height = maxSide; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext('2d');
          context.fillStyle = '#fff';
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          const imageBase64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
          return await mtop.request({
            api: ${JSON.stringify(IMAGE_UPLOAD_API)},
            v: '1.0',
            data: { imageBase64 },
            type: 'POST',
            dataType: 'json',
            needLogin: false,
            needLoginPC: false,
            sessionOption: 'AutoLoginOnly',
            ecode: 0,
          });
        } catch (error) {
          return { error: {
            message: String(error && (error.message || '')),
            ret: error && error.ret,
            data: error && error.data,
            name: error && error.name,
          } };
        }
      })()
    `);
    const imageId = extractImageId(payload);
    if (!imageId) {
        const details = payload?.error
            ? (typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error))
            : JSON.stringify(payload ?? {});
        throw new CommandExecutionError(
            `1688 image search upload did not return an image id: ${cleanText(details).slice(0, 800)}`,
            'Open the 1688 home page in Chrome, confirm login, and retry.',
        );
    }
    return imageId;
}

function normalizeImageCandidate(candidate, sourceUrl, rank) {
    const itemUrl = canonicalizeItemUrl(cleanText(candidate.item_url));
    const sellerUrl = canonicalizeSellerUrl(cleanText(candidate.seller_url));
    const text = cleanText(candidate.container_text);
    const price = parsePriceText(cleanText(candidate.price_text) || text);
    const moq = parseMoqText(cleanText(candidate.moq_text));
    const provenance = buildProvenance(sourceUrl);
    return {
        rank,
        offer_id: extractOfferId(itemUrl ?? '') ?? null,
        member_id: cleanText(candidate.member_id) || extractMemberId(sellerUrl ?? '') || null,
        shop_id: extractShopId(sellerUrl ?? '') ?? null,
        title: cleanText(candidate.title) || null,
        item_url: itemUrl,
        seller_name: cleanText(candidate.seller_name) || null,
        seller_url: sellerUrl,
        price_text: price.price_text || null,
        price_min: price.price_min,
        price_max: price.price_max,
        currency: price.currency,
        moq_text: moq.moq_text || null,
        moq_value: moq.moq_value,
        location: extractLocation(text),
        image_url: cleanText(candidate.image_url) || null,
        image_urls: Array.isArray(candidate.image_urls) ? candidate.image_urls.map(cleanText).filter(Boolean) : [],
        sales_text: cleanText(candidate.sales_text) || null,
        rating_text: cleanText(candidate.rating_text) || null,
        source_url: provenance.source_url,
        fetched_at: provenance.fetched_at,
        strategy: provenance.strategy,
    };
}

async function collectImageResults(page, resultUrl, limit) {
    const state = await gotoAndReadState(page, resultUrl, 4500, 'image-search-results');
    assertAuthenticatedState(state, 'image-search-results');
    const payload = await page.evaluate(`
      (async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let index = 0; index < 4; index += 1) {
          window.scrollTo(0, document.body.scrollHeight);
          await wait(700);
        }
        const text = (value) => (value || '').replace(/\\s+/g, ' ').trim();
        const itemHref = (href) => {
          const value = href || '';
          return value.includes('detail.1688.com/offer/') || value.includes('detail.m.1688.com/page/index.html');
        };
        const sellerHref = (href) => {
          try {
            const url = new URL(href || '', location.href);
            const genericHosts = new Set(['air.1688.com', 'detail.1688.com', 'detail.m.1688.com', 's.1688.com', 'www.1688.com']);
            return url.hostname.endsWith('.1688.com') && !genericHosts.has(url.hostname);
          } catch { return false; }
        };
        const cards = [...document.querySelectorAll('.cgf-sale-product-list-card-wrapper[data-offerid]')];
        const cardRows = cards.map((root) => {
          const offerId = root.getAttribute('data-offerid') || '';
          const supplierId = (root.getAttribute('data-supplierid') || '').replace(/^b2b-/, '');
          const imageUrls = [...root.querySelectorAll('.cgf-card-image img[src]')].map((node) => node.src).filter(Boolean);
          const price = [
            text(root.querySelector('.cgf-unit')?.textContent),
            text(root.querySelector('.cgf-integer')?.textContent),
            text(root.querySelector('.cgf-dot')?.textContent),
            text(root.querySelector('.cgf-decimal')?.textContent),
          ].join('');
          return {
            item_url: offerId ? 'https://detail.1688.com/offer/' + offerId + '.html' : '',
            title: text(root.querySelector('.cgf-card-title')?.textContent),
            container_text: text(root.innerText || root.textContent),
            price_text: price,
            moq_text: '',
            seller_name: text(root.querySelector('.cgf-text')?.textContent),
            seller_url: '',
            member_id: supplierId,
            image_url: imageUrls[0] || '',
            image_urls: imageUrls,
            sales_text: text([...root.querySelectorAll('.cgf-item')].find((node) => /已售/.test(node.textContent || ''))?.textContent),
            rating_text: text(root.querySelector('.cgf-rating-score')?.textContent),
          };
        });
        const anchors = [...document.querySelectorAll('a')].filter((anchor) => itemHref(anchor.href));
        const seen = new Set();
        const rows = [];
        for (const anchor of anchors) {
          if (!anchor.href || seen.has(anchor.href)) continue;
          seen.add(anchor.href);
          let root = anchor;
          while (root.parentElement && root.parentElement !== document.body) {
            const candidateText = text(root.parentElement.innerText || root.parentElement.textContent);
            if (candidateText.length > 1200) break;
            root = root.parentElement;
            if (candidateText.length >= 30) break;
          }
          const containerText = text(root.innerText || root.textContent);
          const image = root.querySelector('img') || anchor.querySelector('img');
          const seller = [...root.querySelectorAll('a')].find((node) => sellerHref(node.href));
          const price = containerText.match(/[¥￥]\\s*\\d+(?:\\.\\d+)?(?:\\s*[~-]\\s*\\d+(?:\\.\\d+)?)?/)?.[0] || '';
          const moq = containerText.match(/(?:≥\\s*)?\\d+(?:\\.\\d+)?\\s*(?:件|个|套|箱|包|双|台|把|只)(?:\\s*起批)?/)?.[0] || '';
          rows.push({
            item_url: anchor.href,
            title: text(anchor.getAttribute('title')) || text(image && image.getAttribute('alt')) || text(anchor.innerText || anchor.textContent),
            container_text: containerText,
            price_text: price,
            moq_text: moq,
            seller_name: seller ? text(seller.innerText || seller.textContent) : '',
            seller_url: seller ? seller.href : '',
          });
        }
        return {
          href: location.href,
          title: document.title,
          bodyText: document.body ? document.body.innerText : '',
          hrefSamples: [...document.querySelectorAll('a[href]')].slice(0, 80).map((node) => node.href),
          rows: cardRows.length ? cardRows : rows,
        };
      })()
    `);
    if (!payload || typeof payload !== 'object') throw new CommandExecutionError('1688 image result page was not readable');
    assertAuthenticatedState(payload, 'image-search-results');
    const rows = (Array.isArray(payload.rows) ? payload.rows : [])
        .map((row, index) => normalizeImageCandidate(row, cleanText(payload.href) || resultUrl, index + 1))
        .filter((row) => row.item_url && row.offer_id)
        .slice(0, limit);
    if (!rows.length) throw new EmptyResultError('1688 image search', 'No visible matching products were extracted. Try another image or retry after confirming the 1688 locale and login state.');
    return rows;
}

cli({
    site: '1688',
    name: 'image-search',
    access: 'read',
    description: '1688 以图搜同款（支持图片 URL 或本地图片）',
    domain: 'www.1688.com',
    strategy: Strategy.COOKIE,
    navigateBefore: false,
    args: [
        {
            name: 'input',
            required: true,
            positional: true,
            help: '图片 URL 或本地 jpg/jpeg/png/bmp/webp 文件',
        },
        {
            name: 'limit',
            type: 'int',
            default: SEARCH_LIMIT_DEFAULT,
            help: `结果数量上限（默认 ${SEARCH_LIMIT_DEFAULT}，最大 ${SEARCH_LIMIT_MAX}）`,
        },
    ],
    columns: ['rank', 'offer_id', 'title', 'item_url', 'image_url', 'price_text', 'moq_text', 'seller_name', 'sales_text', 'member_id', 'location'],
    func: async (page, kwargs) => {
        const imageBytes = await readImageInput(String(kwargs.input ?? ''));
        const imageId = await uploadImage(page, imageBytes);
        return collectImageResults(page, buildImageSearchUrl(imageId), parseSearchLimit(kwargs.limit));
    },
});

export const __test__ = { buildImageSearchUrl, detectImageMime, extractImageId, normalizeImageCandidate, readImageInput };
