// Meus dados (LGPD) e as páginas de privacidade e termos (Android).
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test('política de privacidade e termos de uso abrem e apontam um para o outro', async ({ page }) => {
  await page.goto('/privacidade.html');
  await expect(page.getByRole('heading', { name: 'Política de Privacidade' })).toBeVisible();
  await expect(page.locator('main')).toContainText('dado sensível');
  await page.getByRole('link', { name: 'Termos de uso' }).click();
  await expect(page.getByRole('heading', { name: 'Termos de uso' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Política de Privacidade' }).last()).toBeVisible();
});

test('o membro baixa os próprios dados, e a exclusão só libera ao digitar EXCLUIR', async ({ page, playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  const api = await playwright.request.newContext();
  const member = await loginAs(api, 'membro-a');
  await api.dispose();

  await openLoggedIn(page, member.session, '/i/teste-a/#/menu');
  await page.getByRole('link', { name: /Meus dados/ }).click();
  await expect(page.getByRole('heading', { name: 'Meus dados', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sair da Igreja Teste A' })).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Baixar arquivo' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^meus-dados-\d{4}-\d{2}-\d{2}\.json$/);
  const data = JSON.parse(readFileSync(await file.path(), 'utf8'));
  expect(data.igrejas[0].cadastro.nome).toBe('Membro da A');

  const del = page.getByRole('button', { name: 'Excluir minha conta para sempre' });
  await expect(del).toBeDisabled();
  await page.getByLabel('Para confirmar, digite EXCLUIR').fill('excluir');
  await expect(del).toBeEnabled();
  await page.getByLabel('Para confirmar, digite EXCLUIR').fill('');
  await expect(del).toBeDisabled();
});
