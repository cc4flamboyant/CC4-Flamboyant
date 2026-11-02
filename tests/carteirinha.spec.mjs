// Carteirinha digital nas telas, com contas da igreja Teste A (Android).
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['lider-a', 'membro-a']) as[u] = await loginAs(api, u);
});

test.afterAll(async () => {
  if (!api) return;
  await api.patch(rest(`members?user_id=eq.${as['membro-a'].id}`), { headers: as['lider-a'].headers, data: { member_since: null } });
  await api.dispose();
});

const myCard = async () =>
  (await (await api.get(rest(`members?select=id,card_token&user_id=eq.${as['membro-a'].id}`), { headers: as['membro-a'].headers })).json())[0];

test('a liderança preenche "membro desde" e o membro vê a carteirinha com o QR Code', async ({ page }) => {
  const { id } = await myCard();
  await openLoggedIn(page, as['lider-a'].session, `/i/teste-a/#/membros/${id}`);
  await page.getByLabel('Membro desde (opcional)').fill('2015-04-12');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Cadastro salvo.')).toBeVisible();

  const member = await page.context().newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/menu');
  await member.getByRole('link', { name: 'Minha carteirinha' }).click();
  const card = member.locator('.member-card');
  await expect(card).toContainText('Membro da A');
  await expect(card).toContainText('Membro desde 12 de abril de 2015');
  await expect(card.locator('#card-qr svg')).toBeVisible();
  const download = member.waitForEvent('download');
  await member.getByRole('button', { name: 'Salvar imagem' }).click();
  expect((await download).suggestedFilename()).toBe('carteirinha-membro.png');
});

test('quem lê o QR Code, sem conta, vê "Membro ativo" e só o que está na carteirinha', async ({ page }) => {
  const { card_token } = await myCard();
  await page.goto(`/i/teste-a/#/carteirinha/verificar/${card_token}`);
  const result = page.locator('.verify-result');
  await expect(result).toContainText('Membro ativo');
  await expect(result).toContainText('Membro da A');
  await expect(result).toContainText('Membro desde 12 de abril de 2015');
  await expect(page.locator('.page')).not.toContainText('@teste.igrejaconecta.invalid');
  await page.goto('/i/teste-a/#/carteirinha/verificar/00000000-0000-4000-8000-000000000000');
  await expect(page.locator('.verify-result')).toContainText('Carteirinha não reconhecida');
});

test('gerar um novo QR Code invalida o anterior', async ({ page }) => {
  const { card_token: old } = await myCard();
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/carteirinha');
  await page.getByRole('button', { name: 'Gerar novo QR Code' }).click();
  await answer(page);
  await expect(page.getByText('Novo QR Code gerado.')).toBeVisible();
  const { card_token: fresh } = await myCard();
  expect(fresh).not.toBe(old);
  await page.goto(`/i/teste-a/#/carteirinha/verificar/${old}`);
  await expect(page.locator('.verify-result')).toContainText('Carteirinha não reconhecida');
  await page.goto(`/i/teste-a/#/carteirinha/verificar/${fresh}`);
  await expect(page.locator('.verify-result')).toContainText('Membro ativo');
});

test('a carteirinha abre na hora, mesmo com o banco demorando', async ({ page }) => {
  const prefetched = page.waitForResponse(/members\?select=\*/);
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await prefetched;
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Minha carteirinha' }).click();
  await expect(page.locator('.member-card')).toContainText('Membro da A', { timeout: 1000 });
});
