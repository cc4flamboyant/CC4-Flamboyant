// Foto do cadastro, logo da instituição e imagem da mensagem de aniversário: tocar na própria
// foto (com o lápis no canto) escolhe a imagem, como o ícone do grupo no chat. Nada é salvo aqui.
import { test, expect } from '@playwright/test';
import { configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

let as = {};
test.beforeAll(async ({ playwright }) => {
  test.skip(!configured || !testPassword(), 'Sem as contas de teste');
  const api = await playwright.request.newContext();
  for (const u of ['adm-a', 'membro-a']) as[u] = await loginAs(api, u);
  await api.dispose();
});

// Toca na foto, escolhe um arquivo e confere a prévia com a imagem escolhida.
async function pickByTapping(page, pick, preview) {
  await expect(pick.locator('.icon-pick-badge')).toBeVisible();
  const shot = await page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 200 } });
  const chooser = page.waitForEvent('filechooser');
  await pick.click();
  await (await chooser).setFiles({ name: 'foto.png', mimeType: 'image/png', buffer: shot });
  await expect(preview).toHaveAttribute('src', /^blob:/);
}

test('Meu cadastro: tocar na foto escolhe a foto; dá para remover', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/perfil');
  const pick = page.locator('.photo-field label.icon-pick');
  await expect(page.getByText(/Toque na foto para/)).toBeVisible();
  await pickByTapping(page, pick, pick.locator('#photo-preview img'));
  await page.getByRole('button', { name: 'Remover foto' }).click();
  await expect(pick.locator('#photo-preview img')).toHaveCount(0);
});

test('Configurar a instituição: tocar no ícone troca a logo', async ({ page }) => {
  await openLoggedIn(page, as['adm-a'].session, '/i/teste-a/#/config');
  const pick = page.locator('label.icon-pick.square');
  await expect(page.getByRole('button', { name: /Trocar a logo/ })).toHaveCount(0);
  await pickByTapping(page, pick, page.locator('#logo-preview'));
});

test('Mensagem de aniversário: tocar na caixa escolhe a imagem', async ({ page }) => {
  await openLoggedIn(page, as['adm-a'].session, '/i/teste-a/#/config/aniversario');
  const pick = page.locator('label.icon-pick.image-pick');
  await expect(pick).toBeVisible();
  await pickByTapping(page, pick, page.locator('#image-box img'));
  await page.getByRole('button', { name: 'Remover imagem' }).click();
  await expect(page.getByText('Toque para escolher uma imagem')).toBeVisible();
});
