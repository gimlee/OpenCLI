import { AuthRequiredError, CommandExecutionError } from '@jackwener/opencli/errors';

const SELLER_DOMAIN = 'seller.tiktokshopglobalselling.com';

const SAFE_DISMISS_LABELS = [
    '我知道了',
    '知道了',
    '稍后再说',
    '跳过',
    '关闭',
    'got it',
    'not now',
    'skip',
    'close',
];

const SAFE_CONTEXT_PATTERN = /新手|操作指引|功能介绍|欢迎使用|平台公告|系统公告|活动通知|营销活动|product tour|tutorial|what'?s new|announcement|promotion/i;
const CONSENT_PATTERN = /自动翻译|automatic translation|auto translation|条款|协议|责任|terms|consent|agree/i;
const DANGEROUS_BUTTON_PATTERN = /^(发布|提交审核|提交|删除|确认删除|publish|submit|delete|confirm delete|terbitkan)$/i;
const CLICK_OBSTRUCTION_PATTERN = /intercepts pointer events|not receiving pointer events|another element would receive|captcha_container|captcha_verify/i;

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function classifyPopupSnapshot(snapshot) {
    if (snapshot?.security?.visible) {
        return { action: 'wait_security', popup: snapshot.security };
    }
    const overlays = Array.isArray(snapshot?.overlays) ? snapshot.overlays : [];
    if (overlays.length === 0) return { action: 'none', popup: null };

    for (const popup of overlays) {
        const buttons = Array.isArray(popup.buttons) ? popup.buttons : [];
        const dangerous = buttons.find((button) => DANGEROUS_BUTTON_PATTERN.test(normalizeText(button.text)));
        if (dangerous) return { action: 'block_dangerous', popup, button: dangerous };
    }
    for (const popup of overlays) {
        if (CONSENT_PATTERN.test(normalizeText(popup.text))) {
            return { action: 'require_explicit_consent', popup };
        }
    }
    for (const popup of overlays) {
        if (!SAFE_CONTEXT_PATTERN.test(normalizeText(popup.text))) continue;
        const safeButtons = (popup.buttons || []).filter((button) => (
            !button.disabled
            && SAFE_DISMISS_LABELS.includes(normalizeText(button.text).toLowerCase())
        ));
        if (safeButtons.length === 1) {
            return { action: 'dismiss', popup, button: safeButtons[0] };
        }
    }
    return { action: 'wait_unknown', popup: overlays[0] };
}

function popupInspectionScript() {
    return `(() => {
      const visible = (node) => {
        if (!node || !node.isConnected) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden'
          && Number(style.opacity || 1) !== 0 && rect.width > 1 && rect.height > 1;
      };
      document.querySelectorAll('[data-opencli-popup-id], [data-opencli-popup-button-id]')
        .forEach((node) => {
          node.removeAttribute('data-opencli-popup-id');
          node.removeAttribute('data-opencli-popup-button-id');
        });
      const bodyText = String(document.body?.innerText || '').slice(0, 4000);
      const securityNodes = Array.from(document.querySelectorAll(
        '#captcha_container, [class*="captcha_verify"], iframe[src*="captcha" i], input[type="password"]'
      )).filter(visible);
      const securityVisible = securityNodes.length > 0
        || /login|passport|accounts/i.test(location.href)
        || /请完成安全验证|请输入验证码|security verification|verify your identity/i.test(bodyText);
      const candidates = Array.from(document.querySelectorAll(
        '[role="dialog"], [aria-modal="true"], [class*="-modal"], [class*="_modal"], [class*="Modal"]'
      )).filter(visible);
      const containers = candidates.filter((candidate) => !candidates.some((other) => (
        other !== candidate && candidate.contains(other)
      )));
      const overlays = containers.map((container, popupIndex) => {
        const popupId = 'popup-' + popupIndex;
        container.setAttribute('data-opencli-popup-id', popupId);
        const buttons = Array.from(container.querySelectorAll('button, [role="button"]'))
          .filter(visible)
          .map((button, buttonIndex) => {
            const buttonId = popupId + '-button-' + buttonIndex;
            button.setAttribute('data-opencli-popup-button-id', buttonId);
            return {
              id: buttonId,
              text: String(button.innerText || button.textContent || button.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim(),
              disabled: Boolean(button.disabled || button.getAttribute('aria-disabled') === 'true'),
            };
          });
        return {
          id: popupId,
          text: String(container.innerText || container.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1200),
          buttons,
        };
      });
      return {
        href: location.href,
        security: {
          visible: securityVisible,
          text: securityVisible ? bodyText.slice(0, 1200) : '',
        },
        overlays,
      };
    })()`;
}

class PopupManager {
    constructor(page, options = {}) {
        this.page = page;
        this.rawPage = page.rawPage;
        this.waitSeconds = Math.max(0, Number(options.waitSeconds ?? 600) || 0);
        this.interactive = options.interactive !== false;
        this.events = [];
        this.reported = new Set();
    }

    async inspect() {
        return await this.page.evaluate(popupInspectionScript());
    }

    record(kind, action, label, popup) {
        this.events.push({
            kind,
            action,
            label,
            excerpt: normalizeText(popup?.text).slice(0, 240),
            at: new Date().toISOString(),
        });
    }

    reportOnce(key, message) {
        if (this.reported.has(key)) return;
        this.reported.add(key);
        process.stderr.write(`${message}\n`);
    }

    async dismiss(button, label, popup) {
        if (!this.rawPage || !button?.id) return false;
        const locator = this.rawPage.locator(`[data-opencli-popup-button-id="${button.id}"]`);
        if (await locator.count() !== 1) return false;
        await locator.click();
        this.record('known', 'dismissed', label, popup);
        await this.rawPage.waitForTimeout(300);
        return true;
    }

    async checkpoint(label = 'page interaction') {
        const deadline = Date.now() + this.waitSeconds * 1000;
        let waitingKind = null;
        for (;;) {
            const snapshot = await this.inspect();
            const decision = classifyPopupSnapshot(snapshot);
            if (decision.action === 'none') {
                if (waitingKind) this.record(waitingKind, 'resolved_by_user', label, decision.popup);
                return decision;
            }
            if (decision.action === 'dismiss') {
                const dismissed = await this.dismiss(decision.button, label, decision.popup);
                if (dismissed) continue;
                await this.rawPage?.waitForTimeout(300);
                continue;
            }
            if (decision.action === 'block_dangerous') {
                this.record('dangerous', 'blocked', label, decision.popup);
                throw new CommandExecutionError(
                    `TikTok Shop displayed a dangerous confirmation during ${label}; OpenCLI will not click: ${normalizeText(decision.button?.text)}`,
                );
            }
            if (decision.action === 'require_explicit_consent') {
                this.record('consent', 'blocked', label, decision.popup);
                throw new CommandExecutionError(
                    `TikTok Shop displayed a consent dialog during ${label}; it requires an explicit command option and a dedicated rule`,
                );
            }
            waitingKind = decision.action === 'wait_security' ? 'security' : 'unknown';
            const excerpt = normalizeText(decision.popup?.text).slice(0, 160) || '(no text)';
            this.reportOnce(
                `${waitingKind}:${excerpt}`,
                waitingKind === 'security'
                    ? `TikTok Shop security verification detected during ${label}; waiting for manual completion.`
                    : `TikTok Shop unknown blocking dialog detected during ${label}; close or resolve it in the Chrome window to continue: ${excerpt}`,
            );
            if (!this.interactive || Date.now() >= deadline) {
                this.record(waitingKind, 'timeout', label, decision.popup);
                if (waitingKind === 'security') {
                    throw new AuthRequiredError(
                        SELLER_DOMAIN,
                        `TikTok Shop security verification was not completed within ${this.waitSeconds} seconds`,
                    );
                }
                throw new CommandExecutionError(
                    `TikTok Shop blocking dialog was not resolved within ${this.waitSeconds} seconds during ${label}: ${excerpt}`,
                );
            }
            await this.rawPage?.waitForTimeout(1000);
        }
    }

    async run(action, label = 'page interaction') {
        let lastError;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await this.checkpoint(label);
            try {
                return await action();
            }
            catch (error) {
                lastError = error;
                if (!CLICK_OBSTRUCTION_PATTERN.test(String(error?.message || error))) throw error;
                await this.checkpoint(label);
            }
        }
        throw lastError;
    }

    warnings() {
        return this.events.map((event) => (
            `popup ${event.kind} ${event.action} during ${event.label}`
            + (event.excerpt ? `: ${event.excerpt}` : '')
        ));
    }
}

export {
    CLICK_OBSTRUCTION_PATTERN,
    PopupManager,
    classifyPopupSnapshot,
    normalizeText,
    popupInspectionScript,
};
