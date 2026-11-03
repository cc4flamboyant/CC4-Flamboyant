// Calendário do ano na Agenda, com contas da Teste A (Android).
// O calendário do teste leva uma marca no nome e é apagado no fim.
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const title = `Cal UI ${Date.now().toString(36)}`;
const year = new Date().getFullYear();

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
  const rows = await (await api.get(rest(`agenda_calendars?select=id,path&title=eq.${encodeURIComponent(title)}`), { headers: as['lider-a'].headers })).json();
  for (const k of rows) {
    await api.delete(`${SUPABASE_URL}/storage/v1/object/calendarios`, { headers: as['lider-a'].headers, data: { prefixes: [k.path] } });
    await api.delete(rest(`agenda_calendars?id=eq.${k.id}`), { headers: as['lider-a'].headers });
  }
  await api.dispose();
});

test('a liderança envia o calendário do ano pela Agenda', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/agenda');
  // Uma imagem de verdade (captura da tela).
  await page.setViewportSize({ width: 1200, height: 900 });
  const shot = await page.screenshot();
  await page.setViewportSize({ width: 412, height: 915 });
  await page.locator('#year-calendars a.link').click();
  await expect(page.getByRole('heading', { name: 'Calendário do ano' })).toBeVisible();
  await page.getByLabel('Nome').fill(title);
  await page.getByLabel('Imagem ou PDF (até 15 MB)').setInputFiles({ name: 'calendario.png', mimeType: 'image/png', buffer: shot });
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByText('Calendário enviado.')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.cal-row').filter({ hasText: `${title} ${year}` })).toBeVisible();
});

test('o membro abre o calendário na Agenda, com zoom; abre na hora', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.getByRole('link', { name: 'Agenda' }).first().click();
  const btn = page.locator('#year-calendars a').filter({ hasText: `${title} ${year}` });
  await expect(btn).toBeVisible({ timeout: 1000 });
  // O membro não gerencia.
  await expect(page.locator('#year-calendars a.link')).toHaveCount(0);
  await btn.click();
  await expect(page.getByRole('heading', { name: `${title} ${year}` })).toBeVisible({ timeout: 1000 });
  const img = page.locator('#zoom-img');
  await expect(img).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Aumentar' }).click();
  await expect(img).toHaveAttribute('style', /scale\(1\.5\)/);
  await page.getByRole('button', { name: 'Tamanho original' }).click();
  await expect(img).toHaveAttribute('style', /scale\(1\)/);
  await page.unroute('**/rest/v1/**');
});

test('a liderança apaga o calendário', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/agenda/calendarios');
  await page.locator('.cal-row').filter({ hasText: `${title} ${year}` }).getByRole('button', { name: 'Apagar' }).click();
  await answer(page);
  await expect(page.getByText('Calendário apagado.')).toBeVisible();
  await expect(page.locator('.cal-row').filter({ hasText: title })).toHaveCount(0);
});
