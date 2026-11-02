// Tema claro ou escuro pelo botão do topo, guardado no aparelho (Android).
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

const bg = (page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test('o botão troca o tema, a escolha fica no aparelho e a página não pisca ao abrir', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  // Anota o tema no instante em que a página fica pronta (antes de o app desenhar).
  await page.addInitScript(() =>
    document.addEventListener('DOMContentLoaded', () => (window.__temaNaAbertura = document.documentElement.dataset.theme || 'celular')),
  );
  await page.goto('/i/teste-a/');
  const btn = page.locator('#theme-btn');
  await expect(btn).toHaveAttribute('aria-label', 'Usar tema escuro');
  expect(await bg(page)).toBe('rgb(245, 246, 250)');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-label', 'Usar tema claro');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await bg(page)).toBe('rgb(17, 19, 24)');

  await page.reload();
  expect(await page.evaluate(() => window.__temaNaAbertura)).toBe('dark');
  await expect(btn).toHaveAttribute('aria-label', 'Usar tema claro');
  // Também na raiz do site.
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.locator('#theme-btn').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('"Tema: seguir o celular" volta ao automático', async ({ page, playwright }) => {
  test.skip(!configured || !testPassword(), 'Sem as contas de teste');
  const api = await playwright.request.newContext();
  const membro = await loginAs(api, 'membro-a');
  await api.dispose();
  await page.emulateMedia({ colorScheme: 'dark' });
  await openLoggedIn(page, membro.session, '/i/teste-a/#/menu');
  await expect(page.getByRole('button', { name: 'Tema: seguir o celular' })).toHaveCount(0); // ainda não escolheu
  await page.locator('#theme-btn').click(); // celular escuro: passa para o claro
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('button', { name: 'Tema: seguir o celular' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /./);
  await expect(page.locator('#theme-btn')).toHaveAttribute('aria-label', 'Usar tema claro');
  expect(await bg(page)).toBe('rgb(17, 19, 24)');
});

// Cor de fundo de um elemento da página, já calculada pelo navegador.
const bgOf = (page, sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
const rgbOf = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

test('no tema escuro, o admin escolhe o fundo preto ou na cor principal; os botões não somem no fundo', async ({ page, playwright }) => {
  test.skip(!configured || !testPassword(), 'Sem as contas de teste');
  const api = await playwright.request.newContext();
  const admin = await loginAs(api, 'adm-a');
  const reset = () => api.patch(rest('churches?slug=eq.teste-a'), { headers: admin.headers, data: { dark_theme: 'preto' } });
  try {
    await reset();
    await page.emulateMedia({ colorScheme: 'dark' });
    await openLoggedIn(page, admin.session, '/i/teste-a/#/config');
    await expect(page.getByLabel('Preto', { exact: true })).toBeChecked();
    expect(await bg(page)).toBe('rgb(17, 19, 24)'); // preto, como sempre foi
    const color = await page.getByLabel('Cor principal', { exact: true }).inputValue();

    await page.getByLabel('Cor principal da igreja').check();
    await page.getByRole('button', { name: 'Salvar' }).click();
    await expect(page.locator('#toast')).toContainText(/salva|Pronto/);
    await expect(page.locator('html')).toHaveAttribute('data-dark-theme', 'principal');
    // O fundo é a cor principal (escurecida só se for clara demais), não o preto.
    const dark = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--church-dark').trim());
    expect(await bg(page)).toBe(rgbOf(dark));
    expect(await bg(page)).not.toBe('rgb(17, 19, 24)');
    // O botão + fica na cor clareada: diferente do fundo e da cor original.
    await page.goto('/i/teste-a/#/avisos');
    const fab = await bgOf(page, '.fab');
    expect(fab).not.toBe(rgbOf(dark));
    expect(fab).not.toBe(rgbOf(color));

    // Na próxima abertura, o fundo já vem certo antes de o app desenhar (sem piscar o preto).
    await page.addInitScript(() =>
      document.addEventListener('DOMContentLoaded', () => (window.__fundo = getComputedStyle(document.body).backgroundColor)),
    );
    await page.reload();
    expect(await page.evaluate(() => window.__fundo)).toBe(rgbOf(dark));
    // Tema claro: nada muda (fundo claro e o + na cor principal).
    await page.locator('#theme-btn').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await bg(page)).toBe('rgb(245, 246, 250)');
    expect(await bgOf(page, '.fab')).toBe(rgbOf(color));
  } finally {
    await reset();
    await api.dispose();
  }
});
