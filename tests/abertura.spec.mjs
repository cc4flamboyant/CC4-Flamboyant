// Abertura rápida (Android): a tela aparece com o que ficou guardado no aparelho, sem esperar o banco.
import { test, expect } from '@playwright/test';
import { configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

const accounts = {};

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  const api = await playwright.request.newContext();
  for (const u of ['membro-a']) accounts[u] = await loginAs(api, u);
  await api.dispose();
});

const hero = (page) => page.locator('.church-hero h1');

test('na segunda abertura a tela aparece mesmo com o banco demorando', async ({ page }) => {
  await openLoggedIn(page, accounts['membro-a'].session, '/i/teste-a/#/');
  await expect(hero(page)).toHaveText('Igreja Teste A');
  await expect(page.getByRole('link', { name: 'Agenda' }).first()).toBeVisible();

  // O banco "trava": sem a abertura rápida, a tela ficaria em "Carregando…".
  await page.route('**/rest/v1/**', () => {});
  await page.reload();
  await expect(hero(page)).toHaveText('Igreja Teste A', { timeout: 3000 });
  await expect(page.locator('#tabbar')).toBeVisible();
});

test('a abertura rápida não vale para outra conta nem depois de sair', async ({ page }) => {
  await openLoggedIn(page, accounts['membro-a'].session, '/i/teste-a/#/');
  await expect(page.locator('#tabbar')).toBeVisible();
  expect(await page.evaluate(() => !!localStorage.getItem('abertura-rapida'))).toBe(true);

  // Sem a sessão desta conta no aparelho, o retrato guardado é ignorado.
  const [key, token] = await page.evaluate(() => {
    const k = Object.keys(localStorage).find((x) => x.endsWith('-auth-token'));
    const v = localStorage.getItem(k);
    localStorage.removeItem(k);
    return [k, v];
  });
  await page.reload();
  await expect(page.locator('.page').getByRole('link', { name: 'Entrar' })).toBeVisible();
  await expect(page.locator('#tabbar')).toBeHidden();

  // De volta à conta: sair apaga o retrato.
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, token]);
  await page.goto('/i/teste-a/#/menu');
  await page.reload();
  await page.getByRole('button', { name: 'Sair' }).click();
  await expect(page.locator('.page').getByRole('link', { name: 'Entrar' })).toBeVisible();
  // Pode ficar só o retrato da igreja para visitante: sem conta e sem cadastros.
  const saved = async () => {
    const raw = await page.evaluate(() => localStorage.getItem('abertura-rapida'));
    const snap = raw ? JSON.parse(JSON.parse(raw).snapshot) : null;
    return { user: snap?.user ?? null, memberships: snap?.memberships?.length ?? 0 };
  };
  await expect.poll(saved).toEqual({ user: null, memberships: 0 });
});

test.describe('com o service worker', () => {
  test.use({ serviceWorkers: 'allow' });

  test('abre sem internet depois da primeira vez', async ({ page, context }) => {
    await openLoggedIn(page, accounts['membro-a'].session, '/i/teste-a/#/');
    await expect(hero(page)).toHaveText('Igreja Teste A');
    // Espera o service worker guardar os arquivos do app.
    await page.evaluate(() => navigator.serviceWorker.ready);

    // O service worker da igreja tem o mesmo endereço do app instalado dela (os avisos saem pelo app).
    expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toMatch(/\/i\/teste-a\/$/);

    // Sem internet, os arquivos do app saem do aparelho.
    await context.setOffline(true);
    await page.goto('/i/teste-a/#/');
    await expect(page.locator('#brand-logo')).toBeVisible();
    await expect(page.locator('.topbar')).toBeVisible();
  });
});
