import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';

export const defaultSelectors = {
  prompt: '#prompt-textarea',
  send: '[data-testid="send-button"]',
  assistant: '[data-message-author-role="assistant"]',
  stop: '[data-testid="stop-button"]',
  upload: 'input[type="file"]',
};

// Uses visible browser UI only. Selectors can be replaced when the site UI changes.
export class ChatGPTPageAdapter {
  constructor({ profile, headed = false, url = 'https://chatgpt.com/', selectors = {}, executablePath }) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://chatgpt.com' && !(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1')) throw new Error('Use chatgpt.com or a loopback test fixture');
    this.options = { profile, headed, url, executablePath };
    this.selectors = { ...defaultSelectors, ...selectors };
    this.pages = new Map();
    this.active = new Set();
  }
  async start() {
    this.starting ??= (async () => {
      this.context = await chromium.launchPersistentContext(this.options.profile, {
        headless: !this.options.headed, chromiumSandbox: process.platform === 'linux',
        executablePath: this.options.executablePath, viewport: { width: 1360, height: 900 }, acceptDownloads: false,
      });
      this.context.setDefaultTimeout(15000);
    })().catch(error => { this.starting = undefined; throw error; });
    await this.starting;
    return this;
  }
  async page(id) {
    await this.start();
    if (!this.pages.has(id)) {
      const page = await this.context.newPage();
      this.pages.set(id, page);
      await page.goto(this.options.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    }
    return this.pages.get(id);
  }
  async login() {
    await this.page('login');
  }
  async connectMcp({ url, name = 'MoonCode', steps }) {
    if (new URL(url).protocol !== 'https:') throw new Error('ChatGPT requires a reachable HTTPS MCP URL; configure --public-origin and your reverse proxy');
    if (!steps) return this.connectMcpByLabels(url, name);
    if (!Array.isArray(steps) || !steps.length) throw new Error('Provide a connection UI recipe (--connect-config); site UI varies by account');
    if (steps.at(-1).action !== 'wait') throw new Error('Connection recipe must end with a visible success check');
    const page = await this.page('settings');
    const values = { MCP_URL: url, APP_NAME: name };
    for (const step of steps) {
      const value = String(step.value ?? '').replace(/\{(MCP_URL|APP_NAME)\}/g, (_, key) => values[key]);
      if (step.action === 'goto') {
        const target = new URL(value, this.options.url);
        if (target.origin !== new URL(this.options.url).origin) throw new Error('Connection UI recipe must stay on the ChatGPT origin');
        await page.goto(target.href, { waitUntil: 'domcontentloaded' });
        continue;
      }
      const locator = step.selector ? page.locator(step.selector) : page.getByRole(step.role, { name: step.name, exact: true });
      if (step.action === 'click') await locator.click();
      else if (step.action === 'fill') await locator.fill(value);
      else if (step.action === 'check') await locator.check();
      else if (step.action === 'select') await locator.selectOption({ label: value });
      else if (step.action === 'wait') await locator.waitFor({ state: 'visible', timeout: 30000 });
      else throw new Error(`Unknown connection UI action: ${step.action}`);
    }
    // A final visible assertion is mandatory: clicking Save alone is not success.
    if (steps.at(-1).action !== 'wait') throw new Error('Connection recipe must end with a visible success check');
    return { status: 'ui-confirmed', name };
  }
  async connectMcpByLabels(url, name) {
    const page = await this.page('settings');
    await page.goto(new URL('/#settings/Connectors', this.options.url).href, { waitUntil: 'domcontentloaded' });
    const create = page.getByRole('button', { name: /^(Create app|Create connector|创建应用|创建连接器)$/i });
    try { await create.first().waitFor({ state: 'visible', timeout: 10000 }); }
    catch { throw new Error('CHATGPT_APP_SETUP_REQUIRED: enable Developer mode in Apps/Advanced settings, or supply --connect-config for this UI'); }
    await create.first().click();
    const dialog = page.getByRole('dialog').last();
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('textbox', { name: /^(Name|名称|应用名称)$/i }).fill(name);
    await dialog.getByRole('textbox', { name: /MCP.*(URL|网址|地址)|Server URL|服务器.*地址/i }).fill(url);
    const auth = dialog.getByRole('combobox', { name: /authentication|身份验证|认证/i });
    if (await auth.count()) {
      if (await auth.evaluate(el => el.tagName === 'SELECT')) {
        const label = await auth.locator('option').allTextContents();
        const none = label.find(x => /no authentication|无身份验证|无需认证|无认证/i.test(x));
        if (!none) throw new Error('No-auth capability URL option missing in ChatGPT UI');
        await auth.selectOption({ label: none });
      } else {
        await auth.click();
        await page.getByRole('option', { name: /no authentication|无身份验证|无需认证|无认证/i }).click();
      }
    }
    const acknowledge = dialog.getByRole('checkbox', { name: /understand|trust|了解|信任|风险/i });
    if (await acknowledge.count()) await acknowledge.first().check();
    await dialog.getByRole('button', { name: /^(Create|Add|创建|添加)$/i }).click();
    await dialog.waitFor({ state: 'hidden', timeout: 45000 });
    // Require the created app to be visible after the form closes.
    await page.getByText(name, { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
    return { status: 'ui-confirmed', name };
  }
  async *stream(prompt, { agentId = 'main', signal, images = [] } = {}) {
    if (this.active.has(agentId)) throw new Error('This ChatGPT conversation is busy');
    this.active.add(agentId);
    let page;
    try {
      page = await this.page(agentId);
      const input = page.locator(this.selectors.prompt);
      try { await input.waitFor({ state: 'visible', timeout: 15000 }); }
      catch { throw new Error('CHATGPT_LOGIN_REQUIRED_OR_UI_CHANGED: log in using the headed profile or update selectors'); }
      const before = await page.locator(this.selectors.assistant).count();
      if (images.length) await page.locator(this.selectors.upload).last().setInputFiles(images.map((image, i) => ({ name: `screen-${i}.png`, mimeType: image.mimeType, buffer: Buffer.from(image.data, 'base64') })));
      await input.fill(prompt);
      signal?.throwIfAborted();
      await page.locator(this.selectors.send).click();
      let previous = '';
      let stableSince = Date.now();
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const messages = page.locator(this.selectors.assistant);
        if (await messages.count() > before) {
          const current = await messages.last().innerText();
          if (current !== previous) {
            yield { type: current.startsWith(previous) ? 'delta' : 'replace', text: current.startsWith(previous) ? current.slice(previous.length) : current };
            previous = current;
            stableSince = Date.now();
          }
          const busy = await page.locator(this.selectors.stop).isVisible().catch(() => false);
          if (previous && !busy && Date.now() - stableSince >= 2500) {
            // Rendered Markdown omits the backticks in innerText. Recover explicitly
            // labelled action blocks from DOM instead of treating arbitrary JSON as a command.
            const actions = await messages.last().locator('pre').evaluateAll(blocks => blocks.flatMap(pre => {
              const code = pre.querySelector('code');
              const marked = code?.classList.contains('language-mooncode-action') || pre.getAttribute('data-language') === 'mooncode-action'
                || /^\s*mooncode-action(?:\s|$)/.test(pre.parentElement?.innerText ?? '');
              return marked && code ? [code.innerText] : [];
            }));
            yield { type: 'done', text: previous, actions }; return;
          }
        }
        await delay(150, undefined, { signal });
      }
      throw new Error('ChatGPT page response timed out');
    } finally {
      if (signal?.aborted && page) await page.locator(this.selectors.stop).click({ timeout: 1000 }).catch(() => {});
      this.active.delete(agentId);
    }
  }
  async closeAgent(id) {
    const page = this.pages.get(id);
    this.pages.delete(id);
    await page?.close();
  }
  async close() { await this.starting?.catch(() => {}); await this.context?.close(); }
}
