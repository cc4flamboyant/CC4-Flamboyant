// O site abre no Android e no iPhone: início, página da igreja e páginas que não existem.
import { test, expect } from '@playwright/test';
import { configured, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.beforeEach(() => test.skip(!configured, 'Falta a chave pública em js/config.js'));

test('início convida a entrar', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CC4', exact: true })).toBeVisible();
  await expect(page.locator('.hero').getByRole('link', { name: 'Entrar' })).toBeVisible();
});

// A Igreja Teste A nunca ganha pasta própria (igrejas de teste ficam fora da publicação), e o nome dela não muda.
test('página da igreja mostra o nome dela, mesmo antes de ganhar a pasta própria', async ({ page }) => {
  await page.goto('/i/teste-a/');
  await expect(page.locator('.church-hero h1')).toHaveText('Igreja Teste A');
  await expect(page.locator('#app-name')).toHaveText('Igreja Teste A');
  await expect(page).toHaveTitle('Igreja Teste A');
  await page.locator('.page').getByRole('link', { name: 'Entrar' }).click();
  // O link continua dentro da igreja (o <base> da página aponta para a raiz do site).
  await expect(page).toHaveURL(/\/i\/teste-a\/#\/entrar$/);
  await expect(page.locator('#app-name')).toHaveText('Igreja Teste A');
  await expect(page.getByRole('button', { name: 'Receber link de acesso' })).toBeVisible();
});

test('botão do Google só aparece com o login do Google ligado no Supabase', async ({ page }) => {
  const settings = (google) => (route) => route.fulfill({ json: { external: { email: true, google } } });
  await page.route('**/auth/v1/settings', settings(false));
  await page.goto('/i/exemplo/#/entrar');
  await expect(page.getByRole('button', { name: 'Receber link de acesso' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Entrar com Google' })).toBeHidden();

  await page.unroute('**/auth/v1/settings');
  await page.route('**/auth/v1/settings', settings(true));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Entrar com Google' })).toBeVisible();
});

test('limite de envio de e-mails aparece em português', async ({ page }) => {
  await page.route('**/auth/v1/otp*', (route) =>
    route.fulfill({ status: 429, json: { code: 429, error_code: 'over_email_send_rate_limit', msg: 'email rate limit exceeded' } }),
  );
  await page.goto('/i/exemplo/#/entrar');
  await page.getByLabel('Seu e-mail').fill('alguem@exemplo.com');
  await page.getByRole('button', { name: 'Receber link de acesso' }).click();
  await expect(page.locator('#toast')).toContainText('Muitos pedidos de link de acesso');
});

test('não dá para puxar a tela para atualizar (nem efeito elástico)', async ({ page }) => {
  await page.goto('/i/teste-a/');
  await expect(page.locator('.church-hero h1')).toHaveText('Igreja Teste A');
  // O WebKit dos testes não conhece a regra (o Safari do iPhone conhece desde o iOS 16).
  test.skip(!(await page.evaluate(() => CSS.supports('overscroll-behavior', 'none'))), 'navegador de teste sem overscroll-behavior');
  const pull = await page.evaluate(() => [document.documentElement, document.body].map((el) => getComputedStyle(el).overscrollBehaviorY));
  expect(pull).toEqual(['none', 'none']);
});

test('nenhuma tela deixa dar zoom (pinça ou dois toques)', async ({ page }) => {
  for (const url of ['/', '/i/teste-a/', '/privacidade.html', '/termos.html']) {
    await page.goto(url);
    await expect(page.locator('meta[name="viewport"]'), url).toHaveAttribute('content', /maximum-scale=1, user-scalable=no/);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).touchAction), url).toBe('pan-x pan-y');
  }
  // Página da igreja servida pelo 404.html (antes de ganhar a pasta própria): o mesmo.
  await page.goto('/i/teste-a/#/');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /user-scalable=no/);
});

test('igreja que não existe', async ({ page }) => {
  await page.goto('/i/nao-existe-esta/');
  await expect(page.getByRole('heading', { name: 'Instituição de ensino não encontrada' })).toBeVisible();
});

test('página que não existe', async ({ page }) => {
  const res = await page.goto('/qualquer-coisa');
  expect(res.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible();
});

test('textos da igreja não viram código na tela', async ({ page }) => {
  const evil = '<img src=x onerror="window.__xss=1">';
  await page.route('**/rest/v1/churches?*', async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    const poison = (r) => ({ ...r, welcome_text: evil, about_text: evil });
    await route.fulfill({ response: res, json: Array.isArray(data) ? data.map(poison) : poison(data) });
  });
  await page.goto('/i/exemplo/');
  await expect(page.locator('.church-hero p')).toContainText('<img');
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

// Pix: a Teste A ganha (só nesta aba do navegador) a funcionalidade e uma chave Pix.
test('Pix: QR Code e código Pix, mesmo sem entrar', async ({ page }) => {
  const key = '123e4567-e12b-12d1-a456-426655440000';
  await page.route('**/rest/v1/churches?*', async (route) => {
    const res = await route.fetch();
    const data = await res.json();
    const pix = (r) => ({ ...r, pix_key: key, pix_name: 'Igreja Teste A', city: 'Brasília', features: { ...r.features, pix: true } });
    await route.fulfill({ response: res, json: Array.isArray(data) ? data.map(pix) : pix(data) });
  });
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => window.__copied.push(t) } });
  });
  await page.goto('/i/teste-a/');
  await page.getByRole('link', { name: 'Pix' }).click();
  await expect(page.getByRole('heading', { name: 'Pix', exact: true })).toBeVisible();
  await expect(page.locator('#offer-qr svg')).toBeVisible();
  await expect(page.locator('.offer .key')).toHaveText(key);

  await page.getByLabel('Valor (opcional)').fill('50,00');
  await page.getByRole('button', { name: 'Copiar código Pix (copia e cola)' }).click();
  await page.getByRole('button', { name: 'Copiar chave' }).click();
  const [code, copiedKey] = await page.evaluate(() => window.__copied);
  expect(code).toContain('br.gov.bcb.pix');
  expect(code).toContain(key);
  expect(code).toContain('540550.00');
  expect(code).toContain('6008Brasilia');
  expect(copiedKey).toBe(key);

  await page.getByLabel('Valor (opcional)').fill('abc');
  await expect(page.getByText('Valor inválido')).toBeVisible();
});

test('Pix some com a funcionalidade desligada', async ({ page }) => {
  await page.goto('/i/teste-a/');
  await expect(page.locator('.church-hero h1')).toHaveText('Igreja Teste A');
  await expect(page.getByRole('link', { name: 'Pix' })).toHaveCount(0);
  await page.goto('/i/teste-a/#/pix');
  await expect(page.getByText('A instituição de ensino ainda não informou uma chave Pix.')).toBeVisible();
});
