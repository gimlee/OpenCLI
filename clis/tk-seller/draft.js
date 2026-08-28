import { ArgumentError, AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';
import { cli, Strategy } from '@jackwener/opencli/registry';
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { withPlaywrightPage } from './playwright-runtime.js';

const DEFAULT_PIM_URL = 'http://127.0.0.1:8020';
const DEFAULT_PIM_TOKEN = 'pim-opencli-local-token';
const SELLER_DOMAIN = 'seller.tiktokshopglobalselling.com';

function boolValue(value) {
    if (typeof value === 'boolean') return value;
    const normalized = String(value ?? '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function normalizeRegion(value) {
    const region = String(value || 'MY').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(region)) {
        throw new ArgumentError('region must be a two-letter market code such as MY or TH');
    }
    return region;
}

async function waitForSellerPage(page, loginWaitSeconds) {
    const deadline = Date.now() + Math.max(0, Number(loginWaitSeconds) || 0) * 1000;
    for (;;) {
        const state = await page.evaluate(`(() => ({
          currentHref: location.href,
          pageTitle: document.title,
          bodyExcerpt: String(document.body?.innerText || '').slice(0, 3000),
          needsPassword: Boolean(document.querySelector('input[type="password"]')),
          needsVerification: Array.from(document.querySelectorAll('iframe[src*="captcha" i], [class*="captcha" i], [id*="captcha" i]'))
            .some((node) => node.offsetParent !== null && getComputedStyle(node).visibility !== 'hidden')
            || /请完成安全验证|请输入验证码|security verification|verify your identity/i.test(String(document.body?.innerText || '').slice(0, 3000)),
        }))()`);
        if (!state || typeof state !== 'object') {
            throw new CommandExecutionError('TikTok Shop returned malformed page state');
        }
        const loginRequired = state.needsPassword || state.needsVerification
            || /login|passport|accounts/i.test(String(state.currentHref || ''));
        if (!loginRequired) return state;
        if (Date.now() >= deadline) {
            throw new AuthRequiredError(
                SELLER_DOMAIN,
                'Log in in the Playwright Chrome window, or rerun with --login-wait-seconds 600 for first-time setup',
            );
        }
        await page.sleep(2);
    }
}

async function pimRequest(baseUrl, token, path, payload) {
    let response;
    try {
        response = await fetch(`${baseUrl}${path}`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-PIM-Token': token,
            },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000),
        });
    }
    catch (error) {
        throw new CommandExecutionError(
            `Cannot reach the local product pipeline at ${baseUrl}`,
            `Start it with: uvicorn app.main:app --host 127.0.0.1 --port 8020. ${String(error)}`,
        );
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) {
        throw new CommandExecutionError(
            `Local product pipeline rejected the request: ${body.message || body.detail || `HTTP ${response.status}`}`,
        );
    }
    return body.data;
}

async function callbackResult(baseUrl, token, result) {
    try {
        await fetch(`${baseUrl}/api/opencli/listings/result`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'X-PIM-Token': token,
            },
            body: JSON.stringify(result),
            signal: AbortSignal.timeout(10000),
        });
    }
    catch {
        // The listing result remains visible in OpenCLI output even if the local
        // callback service stopped after the command began.
    }
}

function evaluateScript(payload) {
    return `(() => {
      const input = ${JSON.stringify(payload)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const visible = (node) => {
        if (!node) return false;
        const style = window.getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none' && node.offsetParent !== null;
      };
      const controls = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).filter(visible);
      const context = (node) => {
        const own = [node.getAttribute('placeholder'), node.getAttribute('aria-label'), node.getAttribute('name')]
          .filter(Boolean).join(' ');
        const container = node.closest('label, [id^="preview-product-"], [class*="form-item"], [class*="FormItem"], [class*="field"], [class*="Field"]');
        return normalize(own + ' ' + (container ? String(container.innerText || container.textContent || '').slice(0, 500) : ''));
      };
      const setValue = (node, value) => {
        node.focus();
        if (node.isContentEditable) {
          node.textContent = String(value);
          node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
        } else {
          const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
          if (descriptor && descriptor.set) descriptor.set.call(node, String(value));
          else node.value = String(value);
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
        }
        node.blur();
      };
      const findControl = (terms, options = {}) => {
        const candidates = controls.filter((node) => {
          if (options.type && String(node.getAttribute('type') || '').toLowerCase() !== options.type) return false;
          const text = context(node);
          return terms.some((term) => text.includes(normalize(term)));
        });
        return candidates.find((node) => !node.disabled && !node.readOnly) || null;
      };
      const touched = {};
      const titleNode = document.querySelector('#preview-product-title input[placeholder="请输入中文"]')
        || findControl(['product name', 'product title', '商品名称', '商品标题', 'nama produk', 'ชื่อสินค้า']);
      if (titleNode) { setValue(titleNode, input.title); touched.product_name = true; }
      const descriptionNode = document.querySelector('#preview-product-description [contenteditable="true"]')
        || findControl(['product description', 'description', '商品描述', '描述', '商品详情', 'penerangan produk', 'รายละเอียดสินค้า']);
      if (descriptionNode) { setValue(descriptionNode, input.description); touched.description = true; }
      const sellerSkuNode = findControl(['seller sku', 'sku id', 'sku', '商家编码', 'seller stock keeping unit']);
      if (sellerSkuNode) { setValue(sellerSkuNode, input.sku); touched.seller_sku = true; }
      const priceNode = findControl(['retail price', 'sales price', 'price', '售价', '销售价', 'harga runcit']);
      if (priceNode && Number(input.price) > 0) { setValue(priceNode, Number(input.price).toFixed(2)); touched.price = true; }
      const stockNode = findControl(['stock', 'quantity', 'inventory', '库存', 'kuantiti stok']);
      if (stockNode) { setValue(stockNode, Math.max(0, Number(input.stock) || 0)); touched.stock = true; }

      return { probeTouched: touched, languageWasOpened: false, currentHref: location.href, pageTitle: document.title };
    })()`;
}

function sellerLanguageLabel(productLanguage) {
    const normalized = String(productLanguage || '').trim().toLowerCase();
    if (normalized.includes('chinese') || normalized.includes('中文') || normalized.startsWith('zh')) return '中文';
    if (normalized.includes('malay') || normalized.includes('马来') || normalized.startsWith('ms')) return '马来语';
    if (normalized.includes('thai') || normalized.includes('泰') || normalized.startsWith('th')) return '泰语';
    return '英语';
}

async function selectProductLanguage(page, payload) {
    const rawPage = page.rawPage;
    if (!rawPage) throw new CommandExecutionError('Playwright page is required for deterministic language selection');
    const desired = sellerLanguageLabel(payload.product_language || payload.content_locale);
    const control = rawPage.locator('.core-select-view-with-prefix').filter({ hasText: '输入语言' });
    const controls = await control.count();
    if (controls !== 1) {
        throw new CommandExecutionError(`TikTok Shop input-language selector must match exactly once; got ${controls}`);
    }
    const input = control.locator('input');
    const selectedText = async () => {
        const inputValue = String(await input.inputValue().catch(() => '')).trim();
        if (inputValue) return inputValue;
        const selected = control.locator('.core-select-selection-item, [class*="selection-item"]');
        const selectedValue = String(await selected.first().innerText().catch(() => '')).trim();
        if (selectedValue) return selectedValue;
        const controlText = String(await control.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        return controlText.replace(/^输入语言\s*/, '').trim();
    };
    const current = await selectedText();
    if (current !== desired) {
        await control.click();
        const option = rawPage
            .locator('.core-select-popup:visible [role="option"], .core-select-popup:visible [role="menuitem"]')
            .filter({ hasText: desired });
        const options = await option.count();
        if (options !== 1) {
            throw new CommandExecutionError(
                `TikTok Shop input-language option must match exactly once; got ${options}: ${desired}`,
            );
        }
        await option.click();
    }
    for (let attempt = 0; attempt < 10; attempt += 1) {
        if (await selectedText() === desired) return desired;
        await rawPage.waitForTimeout(500);
    }
    throw new CommandExecutionError(`TikTok Shop did not confirm the input language: ${desired}`);
}

async function fillForm(page, payload) {
    const result = await page.evaluate(evaluateScript(payload));
    if (!result || typeof result !== 'object' || !result.probeTouched) {
        throw new CommandExecutionError('TikTok Shop returned a malformed form-fill result');
    }
    return result.probeTouched;
}

async function ensureAutoTranslation(page, accepted) {
    let state = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
        state = await page.evaluate(`(() => {
      const isConsentText = (value) => {
        const text = String(value || '').toLowerCase();
        return ['自动翻译', 'auto translation', 'automatic translation', 'terjemahan automatik', 'แปลอัตโนมัติ']
          .some((term) => text.includes(term));
      };
      const contextFor = (checkbox) => {
        let node = checkbox;
        for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
          const text = String(node.innerText || '').replace(/\s+/g, ' ').trim();
          if (isConsentText(text)) return text;
        }
        return '';
      };
      const checkbox = Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .find((node) => Boolean(contextFor(node)));
      if (!checkbox) return { required: false, checked: false };
      return { required: true, checked: Boolean(checkbox.checked), context: contextFor(checkbox) };
    })()`);
        if (state?.required) break;
        await page.sleep(1);
    }
    if (!state?.required) return { required: false, translated: false };
    if (!state.checked && !accepted) {
        throw new CommandExecutionError(
            'TikTok Shop requires consent for automatic translation. Review the translation notice, then rerun with --accept-auto-translation true',
        );
    }
    if (!state.checked) {
        const clicked = await page.evaluate(`(() => {
          const isConsentText = (value) => {
            const text = String(value || '').toLowerCase();
            return ['自动翻译', 'auto translation', 'automatic translation', 'terjemahan automatik', 'แปลอัตโนมัติ']
              .some((term) => text.includes(term));
          };
          const checkbox = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((candidate) => {
            let node = candidate;
            for (let depth = 0; node && depth < 8; depth += 1, node = node.parentElement) {
              if (isConsentText(node.innerText)) return true;
            }
            return false;
          });
          if (!checkbox) return false;
          checkbox.click();
          return Boolean(checkbox.checked);
        })()`);
        if (!clicked) throw new CommandExecutionError('TikTok Shop automatic-translation consent could not be enabled');
    }

    for (let attempt = 0; attempt < 15; attempt += 1) {
        const translation = await page.evaluate(`(() => {
          const visible = (node) => node && node.offsetParent !== null && getComputedStyle(node).display !== 'none';
          const titleInputs = Array.from(document.querySelectorAll('#preview-product-title input')).filter(visible);
          const translatedTitle = titleInputs.find((node) => /翻译为|translate to|terjemah|แปลเป็น/i.test(String(node.placeholder || '')));
          const editors = Array.from(document.querySelectorAll('#preview-product-description [contenteditable="true"]')).filter(visible);
          const translatedDescription = editors.length > 1 ? editors[editors.length - 1] : null;
          const title = String(translatedTitle?.value || '').trim();
          const description = String(translatedDescription?.innerText || '').replace(/\s+/g, ' ').trim();
          const descriptionReady = description.length >= 10 && !/^(翻译为|translate to|terjemah|แปลเป็น)/i.test(description);
          return { ready: title.length >= 5 && descriptionReady, title, description };
        })()`);
        if (translation?.ready) return { required: true, translated: true };
        await page.sleep(2);
    }
    throw new CommandExecutionError('TikTok Shop did not finish translating the local title and description within 30 seconds');
}

async function selectCategory(page, payload) {
    const category = String(payload.category_path || '').trim();
    if (!category) throw new CommandExecutionError('UnoPIM did not provide a TikTok Shop category path');
    const rawPage = page.rawPage;
    if (!rawPage) throw new CommandExecutionError('Playwright page is required for deterministic category selection');
    const segments = category.split('>').map((value) => value.trim()).filter(Boolean);
    const selectView = rawPage.locator('#product-cascader-select-view');
    if (await selectView.count() !== 1) {
        throw new CommandExecutionError('TikTok Shop category selector was not found');
    }
    const selectedText = String(await selectView.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (segments.every((segment) => selectedText.includes(segment))) {
        return { selected: true, path: category };
    }
    await selectView.click();
    for (const segment of segments) {
        const option = rawPage.getByText(segment, { exact: true });
        const matches = await option.count();
        if (matches !== 1) {
            throw new CommandExecutionError(
                `TikTok Shop category segment must match exactly once; got ${matches}: ${segment}`,
            );
        }
        const disabled = await option.evaluate((node) => Boolean(
            node.matches('.disabled-node, [aria-disabled="true"]')
            || node.closest('.disabled-node, [aria-disabled="true"]')
            || node.querySelector('.disabled-node, [aria-disabled="true"]')
        ));
        if (disabled) {
            throw new CommandExecutionError(
                `TikTok Shop account main category does not allow: ${category}`,
                'Use a shop whose main category includes this product; the command will not misclassify it into an unrelated category.',
            );
        }
        await option.click();
        await rawPage.waitForTimeout(500);
    }
    let confirmed = '';
    for (let attempt = 0; attempt < 20; attempt += 1) {
        confirmed = String(await selectView.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
        if (segments.every((segment) => confirmed.includes(segment))) break;
        await rawPage.waitForTimeout(500);
    }
    if (!segments.every((segment) => confirmed.includes(segment))) {
        throw new CommandExecutionError(
            `TikTok Shop did not confirm the selected category within 10 seconds: ${category}`,
        );
    }
    return { selected: true, path: category };
}

function attributeLabel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return { color: '颜色', colour: '颜色', size: '尺寸', material: '材质' }[normalized] || value || '颜色';
}

async function configureVariants(page, payload) {
    if (!Array.isArray(payload.variants) || payload.variants.length < 2) {
        const touched = await page.evaluate(evaluateScript(payload));
        return { matched: 0, complete: Boolean(touched?.probeTouched?.price && touched?.probeTouched?.stock), warning: null };
    }
    let enabled = null;
    for (let attempt = 0; attempt < 12; attempt += 1) {
        enabled = await page.evaluate(`(() => {
          const button = document.querySelector('#publish_enable_variation button[role="switch"]');
          if (!button) return { found: false };
          if (button.getAttribute('aria-checked') !== 'true') button.click();
          return { found: true };
        })()`);
        if (enabled?.found) break;
        await page.sleep(1);
    }
    if (!enabled?.found) throw new CommandExecutionError('TikTok Shop variation switch was not found');
    await page.sleep(1);
    await page.wait({ selector: '#sale_properties input[placeholder="请选择或输入销售属性"]', timeout: 10 });

    const propertyName = attributeLabel(payload.variant_attribute);
    const hasProperty = await page.evaluate(`(() => {
      const root = document.querySelector('#sale_properties');
      return Boolean(root && String(root.innerText || '').includes(${JSON.stringify(propertyName)}));
    })()`);
    if (!hasProperty) {
        const propertyInput = page.rawPage?.locator(
            '#sale_properties input[placeholder="请选择或输入销售属性"]',
        );
        const propertyInputs = propertyInput ? await propertyInput.count() : 0;
        if (propertyInputs !== 1) {
            throw new CommandExecutionError(
                `TikTok Shop sales-property input must match exactly once; got ${propertyInputs}`,
            );
        }
        await propertyInput.click();
        const propertyOption = page.rawPage
            .locator('.core-cascader-popup:visible [role="menuitem"]')
            .filter({ hasText: propertyName });
        const propertyOptions = await propertyOption.count();
        if (propertyOptions !== 1) {
            throw new CommandExecutionError(
                `TikTok Shop sales property must match exactly once; got ${propertyOptions}: ${propertyName}`,
            );
        }
        await propertyOption.click();
        let propertyConfirmed = false;
        for (let attempt = 0; attempt < 10; attempt += 1) {
            propertyConfirmed = await page.evaluate(`(() => {
              const root = document.querySelector('#sale_properties');
              return Boolean(root && String(root.innerText || '').includes(${JSON.stringify(propertyName)}));
            })()`);
            if (propertyConfirmed) break;
            await page.rawPage.waitForTimeout(500);
        }
        if (!propertyConfirmed) {
            throw new CommandExecutionError(`TikTok Shop did not confirm the sales property: ${propertyName}`);
        }
        await page.sleep(2);
    }

    for (let index = 0; index < payload.variants.length; index += 1) {
        const optionName = String(payload.variants[index].name || Object.values(payload.variants[index].options || {})[0] || '').trim();
        if (!optionName) throw new CommandExecutionError(`UnoPIM variant ${payload.variants[index].sku} has no option label`);
        const exists = await page.evaluate(`(() => {
          const root = document.querySelector('#sale_properties');
          return Boolean(root && String(root.innerText || '').split(/\\n/).some((line) => line.trim() === ${JSON.stringify(optionName)}));
        })()`);
        if (exists) continue;
        const optionInputs = page.rawPage?.locator('#sale_properties input.core-input-tag-input:visible');
        const optionInputCount = optionInputs ? await optionInputs.count() : 0;
        if (optionInputCount !== index + 1) {
            throw new CommandExecutionError(
                `TikTok Shop option row count must be ${index + 1}; got ${optionInputCount}: ${optionName}`,
            );
        }
        const optionInput = optionInputs.nth(index);
        await optionInput.fill(optionName);
        if (index < payload.variants.length - 1) {
            const addOption = page.rawPage.locator('#sale_properties button').filter({ hasText: '添加选项' });
            const addOptionCount = await addOption.count();
            if (addOptionCount !== 1) {
                throw new CommandExecutionError(
                    `TikTok Shop Add option button must match exactly once; got ${addOptionCount}`,
                );
            }
            await addOption.click();
        }
        else {
            const propertyLabel = page.rawPage.getByText('销售变体名称', { exact: true });
            const propertyLabelCount = await propertyLabel.count();
            if (propertyLabelCount !== 1) {
                throw new CommandExecutionError(
                    `TikTok Shop sales-property label must match exactly once; got ${propertyLabelCount}`,
                );
            }
            await propertyLabel.click();
        }
        await page.sleep(4);
        const committed = await page.evaluate(`(() => {
          const root = document.querySelector('#sale_properties');
          return Boolean(root && String(root.innerText || '').split(/\\n/).some((line) => line.trim() === ${JSON.stringify(optionName)}));
        })()`);
        if (!committed) throw new CommandExecutionError(`TikTok Shop did not commit variant option: ${optionName}`);
    }
    return await fillVariantGrid(page, payload);
}

async function fillShipping(page, payload) {
    const packageInfo = payload.package || {};
    const values = {
        '输入包裹重量': packageInfo.weight_grams,
        '高度': packageInfo.height_cm,
        '宽度': packageInfo.width_cm,
        '长度': packageInfo.length_cm,
    };
    return await page.evaluate(`(() => {
      const supplied = ${JSON.stringify(values)};
      const setValue = (node, value) => {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        descriptor.set.call(node, String(value));
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.blur();
      };
      const filled = [];
      for (const [placeholder, value] of Object.entries(supplied)) {
        const node = Array.from(document.querySelectorAll('#add_product_shipping_title input'))
          .find((candidate) => candidate.getAttribute('placeholder') === placeholder);
        if (node && value !== null && value !== undefined && Number(value) > 0) {
          setValue(node, value);
          filled.push(placeholder);
        }
      }
      return filled;
    })()`);
}

function variantFillScript(variants) {
    return `(() => {
      const variants = ${JSON.stringify(variants)};
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const visible = (node) => {
        if (!node) return false;
        const style = window.getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none' && node.offsetParent !== null;
      };
      const context = (node) => {
        const own = [node.getAttribute('placeholder'), node.getAttribute('aria-label'), node.getAttribute('name')]
          .filter(Boolean).join(' ');
        const container = node.closest('label, td, [class*="form-item"], [class*="FormItem"], [class*="field"], [class*="Field"]');
        return normalize(own + ' ' + (container ? String(container.innerText || container.textContent || '').slice(0, 400) : ''));
      };
      const setValue = (node, value) => {
        node.focus();
        const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(node, String(value));
        else node.value = String(value);
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        node.blur();
      };
      const directRows = Array.from(document.querySelectorAll('#preview-sale-information tbody tr'));
      const rowSelectors = [
        '[class*="variation-row"]', '[class*="VariationRow"]',
        '[class*="sku-row"]', '[class*="SkuRow"]', '[data-testid*="sku-row"]'
      ];
      const rows = Array.from(new Set(rowSelectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)))))
        .concat(directRows)
        .filter(visible)
        .filter((row) => {
          const controls = Array.from(row.querySelectorAll('input')).filter(visible);
          if (controls.length < 2) return false;
          const text = normalize(row.innerText || row.textContent || '');
          return /sku|price|stock|inventory|售价|价格|库存|harga|stok/.test(text + ' ' + controls.map(context).join(' '))
            || controls.some((node) => node.id.startsWith('skus'));
        });
      let matchedRows = 0;
      let skuFields = 0;
      let priceFields = 0;
      let stockFields = 0;
      const used = new Set();
      for (let index = 0; index < variants.length; index += 1) {
        const variant = variants[index];
        const optionNames = [variant.name, ...Object.values(variant.options || {})].filter(Boolean).map(normalize);
        let row = rows.find((candidate, candidateIndex) => {
          if (used.has(candidateIndex)) return false;
          const text = normalize(candidate.innerText || candidate.textContent || '');
          return optionNames.some((name) => name && text.includes(name));
        });
        let rowIndex = row ? rows.indexOf(row) : -1;
        if (!row) {
          rowIndex = rows.findIndex((_, candidateIndex) => !used.has(candidateIndex));
          row = rowIndex >= 0 ? rows[rowIndex] : null;
        }
        if (!row) continue;
        used.add(rowIndex);
        matchedRows += 1;
        const controls = Array.from(row.querySelectorAll('input')).filter(visible);
        const find = (terms) => controls.find((node) => terms.some((term) => context(node).includes(term)) && !node.disabled && !node.readOnly);
        const sku = controls.find((node) => node.id.startsWith('skus'))
          || find(['seller sku', 'sku id', 'sku', '商家编码']);
        const price = controls.find((node) => node.hasAttribute('currency'))
          || find(['retail price', 'sales price', 'price', '售价', '价格', 'harga']);
        const stock = controls.find((node) => node.getAttribute('aria-valuemax') === '999999')
          || find(['stock', 'quantity', 'inventory', '库存', 'kuantiti', 'stok']);
        if (sku) { setValue(sku, variant.sku); skuFields += 1; }
        if (price && Number(variant.price) > 0) { setValue(price, Number(variant.price).toFixed(2)); priceFields += 1; }
        if (stock) { setValue(stock, Math.max(0, Number(variant.stock) || 0)); stockFields += 1; }
      }
      return { gridRowsMatched: matchedRows, skuInputsFilled: skuFields, priceInputsFilled: priceFields, stockInputsFilled: stockFields };
    })()`;
}

async function fillVariantGrid(page, payload) {
    if (!Array.isArray(payload.variants) || payload.variants.length < 2) {
        return { matched: 0, complete: true, warning: null };
    }
    const result = await page.evaluate(variantFillScript(payload.variants));
    const matched = Number(result?.gridRowsMatched || 0);
    const complete = matched === payload.variants.length
        && Number(result?.skuInputsFilled || 0) === payload.variants.length
        && Number(result?.priceInputsFilled || 0) === payload.variants.length
        && Number(result?.stockInputsFilled || 0) === payload.variants.length;
    return {
        matched,
        complete,
        warning: complete
            ? null
            : `variation grid incomplete (${matched}/${payload.variants.length} rows matched); verify category, options, SKU, price, and stock`,
    };
}

function fileMime(pathname) {
    const extension = extname(pathname).toLowerCase();
    return {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.mp4': 'video/mp4',
        '.mov': 'video/quicktime',
    }[extension] || 'application/octet-stream';
}

async function injectFiles(page, selector, paths) {
    const files = paths.map((pathname) => ({
        name: basename(pathname),
        type: fileMime(pathname),
        base64: readFileSync(pathname).toString('base64'),
    }));
    let result;
    try {
        result = await page.evaluate(`(() => {
      const selector = ${JSON.stringify(selector)};
      const files = ${JSON.stringify(files)};
      const input = document.querySelector(selector);
      if (!input || input.type !== 'file') return { injected: false, reason: 'input-not-found' };
      const transfer = new DataTransfer();
      for (const item of files) {
        const binary = atob(item.base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        transfer.items.add(new File([bytes], item.name, { type: item.type, lastModified: Date.now() }));
      }
      input.files = transfer.files;
      const assignedCount = input.files.length;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { injected: true, count: assignedCount };
    })()`);
    }
    catch {
        // Large DataTransfer payloads can outlive the bridge acknowledgement.
        // The next DOM probe authoritatively verifies the resulting upload.
        result = { injected: true, count: paths.length, acknowledgementLost: true };
    }
    if (!result?.injected || Number(result.count) !== paths.length) {
        throw new CommandExecutionError(`TikTok Shop file injection failed: ${result?.reason || 'count mismatch'}`);
    }
    await page.wait({ time: 2 });
    return paths.length;
}

async function finishImageEditor(page, maximumSteps) {
    let steps = 0;
    for (; steps < Math.max(3, maximumSteps + 3); steps += 1) {
        const editor = await page.evaluate(`(() => {
          const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
          const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((node) => node.offsetParent !== null);
          const dialog = dialogs.find((node) => /编辑图片|edit image|sunting imej/i.test(String(node.innerText || node.textContent || '')));
          if (!dialog) return { open: false };
          const allowed = ['下一步', 'next', '完成', 'finish', '确认', 'confirm', '应用', 'apply', '保存', 'save'];
          const forbidden = ['取消', 'cancel', '删除', 'delete'];
          const button = Array.from(dialog.querySelectorAll('button')).find((node) => {
            const text = normalize(node.innerText || node.textContent || '');
            return allowed.includes(text) && !forbidden.includes(text) && !node.disabled;
          });
          if (!button) return { open: true, actionable: false, text: String(dialog.innerText || '').slice(0, 500) };
          button.click();
          return { open: true, actionable: true, text: button.innerText || button.textContent || '' };
        })()`);
        if (!editor?.open) return { completed: true, steps };
        if (!editor.actionable) {
            throw new CommandExecutionError(`TikTok Shop image editor has no safe Next/Finish action: ${editor.text || ''}`);
        }
        await page.sleep(1);
    }
    const stillOpen = await page.evaluate(`(() => Array.from(document.querySelectorAll('[role="dialog"]'))
      .some((node) => node.offsetParent !== null && /编辑图片|edit image|sunting imej/i.test(String(node.innerText || ''))))()`);
    if (stillOpen) throw new CommandExecutionError('TikTok Shop image editor did not finish all images');
    return { completed: true, steps };
}

async function uploadWithFallback(page, selector, paths) {
    try {
        const upload = await page.uploadFiles(selector, paths);
        if (upload?.uploaded) return upload.files || paths.length;
    } catch {
        return await injectFiles(page, selector, paths);
    }
    return await injectFiles(page, selector, paths);
}

async function uploadMedia(page, payload) {
    const summary = { images: 0, video: 0, warnings: [] };
    if (payload.image_paths.length > 0) {
        if (!page.uploadFiles) throw new CommandExecutionError('This OpenCLI browser bridge cannot upload product images');
        const marker = await page.evaluate(`(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
          const target = document.querySelector('#main_image_item_0 input[type="file"]')
            || inputs.find((node) => /\.jpg|\.jpeg|\.png/.test(String(node.accept || '').toLowerCase()));
          if (!target) return { marked: false };
          target.setAttribute('data-opencli-tk-product-images', '1');
          return { marked: true, multiple: Boolean(target.multiple) };
        })()`);
        if (!marker?.marked) {
            summary.warnings.push('product image input was not found');
        } else {
            const files = marker.multiple ? payload.image_paths.slice(0, 9) : payload.image_paths.slice(0, 1);
            summary.images = await uploadWithFallback(page, 'input[data-opencli-tk-product-images="1"]', files);
            await finishImageEditor(page, files.length);
            const verified = await page.evaluate(`(() => {
              const items = Array.from(document.querySelectorAll('#preview-product-image [id^="main_image_item_"]'));
              return items.filter((node) => !/上传图片|upload image/i.test(String(node.innerText || node.textContent || ''))).length;
            })()`);
            if (Number(verified || 0) < Math.min(5, files.length)) {
                summary.warnings.push(`only ${Number(verified || 0)} product images were confirmed by TikTok Shop`);
            } else {
                summary.images = Number(verified);
            }
        }
    }
    if (payload.video_paths.length > 0 && page.uploadFiles) {
        const marker = await page.evaluate(`(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
          const target = document.querySelector('#preview-product-video input[type="file"]')
            || inputs.find((node) => /\.mp4|video/.test(String(node.accept || '').toLowerCase()));
          if (!target) return { marked: false };
          target.setAttribute('data-opencli-tk-product-video', '1');
          return { marked: true };
        })()`);
        if (marker?.marked) {
            summary.video = await uploadWithFallback(
                page,
                'input[data-opencli-tk-product-video="1"]',
                payload.video_paths.slice(0, 1),
            );
        } else {
            summary.warnings.push('product video input was not found');
        }
    }
    return summary;
}

async function saveDraft(page) {
    const clicked = await page.evaluate(`(() => {
      const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const allowed = ['save as draft', 'save draft', '保存草稿', '另存为草稿', 'simpan sebagai draf', 'บันทึกฉบับร่าง'];
      const forbidden = ['publish', 'submit', '发布', '提交', 'terbitkan'];
      const visible = (node) => {
        const style = window.getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none' && node.offsetParent !== null;
      };
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
      const button = candidates.find((node) => {
        const text = normalize(node.innerText || node.textContent || '');
        return allowed.some((label) => text === normalize(label)) && !forbidden.some((label) => text.includes(normalize(label)));
      });
      if (!button) return { clicked: false, available: candidates.map((node) => normalize(node.innerText || node.textContent || '')).filter(Boolean).slice(-30) };
      button.click();
      return { clicked: true, text: button.innerText || button.textContent || '' };
    })()`);
    if (!clicked?.clicked) {
        throw new CommandExecutionError('TikTok Shop Save draft button was not found; the form may still have required fields or the UI changed');
    }
    for (let attempt = 0; attempt < 15; attempt += 1) {
        await page.sleep(2);
        const result = await page.evaluate(`(() => {
          const text = String(document.body?.innerText || '');
          const currentHref = location.href;
          const confirmation = /draft saved|saved as draft|草稿.*保存|已保存.*草稿|保存成功|draf.*disimpan/i.test(text);
          const leftCreatePage = !/\/product\/create(?:[/?#]|$)/i.test(currentHref);
          const validationErrors = text.split('\n').map((value) => value.trim())
            .filter((value) => /必填|不能为空|请选择|错误|error|required/i.test(value)).slice(0, 20);
          return { wasSaved: confirmation || leftCreatePage, currentHref, pageTitle: document.title, validationErrors };
        })()`);
        if (result?.wasSaved) return result;
    }
    return await page.evaluate(`(() => ({
      wasSaved: false,
      currentHref: location.href,
      pageTitle: document.title,
      validationErrors: String(document.body?.innerText || '').split('\n').map((value) => value.trim())
        .filter((value) => /必填|不能为空|请选择|错误|error|required/i.test(value)).slice(0, 20),
    }))()`);
}

cli({
    site: 'tk-seller',
    name: 'draft',
    access: 'write',
    description: 'Fill a TikTok Shop product from local UnoPIM data and optionally save it as a draft; never publish',
    example: 'opencli tk-seller draft 999376601750 --region MY --accept-auto-translation true --save false',
    domain: SELLER_DOMAIN,
    strategy: Strategy.LOCAL,
    browser: false,
    args: [
        { name: 'sku', positional: true, required: true, help: 'UnoPIM product SKU' },
        { name: 'region', default: 'MY', help: 'TikTok Shop market code, e.g. MY or TH' },
        { name: 'accept-auto-translation', type: 'boolean', default: false, help: 'Explicitly accept TikTok Shop automatic-translation terms when translation is required' },
        { name: 'save', type: 'boolean', default: false, help: 'Save as draft after filling; publish is always blocked' },
        { name: 'pim-url', help: 'Local product pipeline base URL (or PIM_API_URL)' },
        { name: 'pim-token', help: 'Local product pipeline callback token (or PIM_OPENCLI_TOKEN)' },
        { name: 'browser-executable-path', help: 'Chrome executable used by Playwright (or TIKTOK_BROWSER_EXECUTABLE_PATH)' },
        { name: 'user-data-dir', help: 'Dedicated persistent TikTok Chrome profile (or TIKTOK_BROWSER_USER_DATA_DIR)' },
        { name: 'headless', type: 'boolean', default: false, help: 'Run Playwright without a visible browser window' },
        { name: 'login-wait-seconds', type: 'int', default: 600, help: 'Pause for manual login/security verification in the visible Playwright window' },
        { name: 'artifacts-dir', help: 'Directory for Playwright traces and failure screenshots' },
    ],
    columns: ['status', 'sku', 'region', 'product_name', 'url', 'fields_filled', 'images_uploaded', 'video_uploaded', 'variant_count', 'draft_saved', 'published', 'warnings'],
    func: async (kwargs) => {
        const skuInput = String(kwargs.sku || '').trim();
        if (!skuInput) throw new ArgumentError('sku is required');
        const marketRegion = normalizeRegion(kwargs.region);
        const acceptAutoTranslation = boolValue(kwargs['accept-auto-translation']);
        const shouldSave = boolValue(kwargs.save);
        const pimUrl = String(kwargs['pim-url'] || process.env.PIM_API_URL || DEFAULT_PIM_URL).replace(/\/$/, '');
        const pimToken = String(kwargs['pim-token'] || process.env.PIM_OPENCLI_TOKEN || DEFAULT_PIM_TOKEN);
        const payload = await pimRequest(pimUrl, pimToken, '/api/opencli/listings/start', {
            sku: skuInput,
            region: marketRegion,
            save: shouldSave,
        });
        const callbackBase = {
            attempt_id: payload.attempt_id,
            published: false,
            seller_url: payload.seller_url,
        };
        try {
            return await withPlaywrightPage(kwargs, payload.attempt_id, async (page, artifacts) => {
                const cleanUrl = new URL(payload.seller_url);
                cleanUrl.searchParams.set('opencli_run', String(Date.now()));
                await page.goto(cleanUrl.toString(), { waitUntil: 'load', settleMs: 5000 });
                const state = await waitForSellerPage(page, kwargs['login-wait-seconds']);
                if (!String(state.currentHref || '').includes(SELLER_DOMAIN)) {
                    throw new CommandExecutionError(`TikTok Shop redirected to an unexpected page: ${state.currentHref || '(unknown)'}`);
                }

                await selectProductLanguage(page, payload);
                const touched = await fillForm(page, payload);
                touched.product_language = true;
                const category = await selectCategory(page, payload);
                if (category.selected) touched.category = true;
                const translation = await ensureAutoTranslation(page, acceptAutoTranslation);
                if (translation.translated) touched.local_translation = true;
                const variantGrid = await configureVariants(page, payload);
                if (variantGrid.complete && payload.variants.length > 1) touched.variants = true;
                const shipping = await fillShipping(page, payload);
                if (Array.isArray(shipping) && shipping.length === 4) touched.shipping = true;
                const media = await uploadMedia(page, payload);
                const warnings = [...media.warnings];
                if (variantGrid.warning) warnings.push(variantGrid.warning);
                const essential = ['product_name', 'description'];
                const missing = essential.filter((name) => !touched[name]);
                if (missing.length > 0) {
                    throw new CommandExecutionError(`Required TikTok Shop fields were not found: ${missing.join(', ')}`);
                }

                let statusValue = 'form_filled';
                let draftSaved = false;
                let currentUrl = state.currentHref;
                if (shouldSave) {
                    const saved = await saveDraft(page);
                    draftSaved = Boolean(saved?.wasSaved);
                    currentUrl = saved?.currentHref || currentUrl;
                    statusValue = draftSaved ? 'draft_saved' : 'draft_save_unconfirmed';
                    if (!draftSaved) {
                        warnings.push('Save draft was clicked but no authoritative saved confirmation was detected');
                        if (Array.isArray(saved?.validationErrors) && saved.validationErrors.length > 0) {
                            warnings.push(`TikTok validation: ${saved.validationErrors.join(' / ')}`);
                        }
                    }
                }
                const fields = Object.keys(touched).filter((key) => touched[key]);
                await callbackResult(pimUrl, pimToken, {
                    ...callbackBase,
                    status: statusValue,
                    draft_url: draftSaved ? currentUrl : null,
                    filled_fields: fields,
                    response_payload: {
                        images_uploaded: media.images,
                        video_uploaded: media.video,
                        warnings,
                        playwright_trace: artifacts.tracePath,
                    },
                });
                return [{
                    status: statusValue,
                    sku: skuInput,
                    region: marketRegion,
                    product_name: payload.title,
                    url: currentUrl,
                    fields_filled: fields.join(', '),
                    images_uploaded: media.images,
                    video_uploaded: media.video,
                    variant_count: payload.variants.length,
                    draft_saved: draftSaved,
                    published: false,
                    warnings: warnings.join(' | '),
                }];
            });
        }
        catch (error) {
            await callbackResult(pimUrl, pimToken, {
                ...callbackBase,
                status: 'failed',
                filled_fields: [],
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    },
});

export { boolValue, evaluateScript, normalizeRegion, sellerLanguageLabel, variantFillScript };
