// Telas de aniversário com contas de teste da igreja Teste A (Android).
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
  for (const u of ['membro-a', 'lider-a', 'adm-a']) accounts[u] = await loginAs(api, u);
  await api.dispose();
});

test('o membro vê no mês só quem autorizou mostrar o aniversário', async ({ page }) => {
  await openLoggedIn(page, accounts['membro-a'].session, '/i/teste-a/#/aniversariantes?mes=2027-02');
  await expect(page.getByRole('heading', { name: 'Aniversariantes de fevereiro' })).toBeVisible();
  const day = page.locator('.bday-day', { hasText: 'Bissexto da A' });
  await expect(day.locator('.bday-date strong')).toHaveText('28');
  await expect(day).not.toContainText('anos');
  await page.evaluate(() => (location.hash = '/aniversariantes?mes=2027-03'));
  await expect(page.getByRole('heading', { name: 'Aniversariantes de março' })).toBeVisible();
  await expect(page.getByText('Nenhum aniversariante em março.')).toBeVisible();
});

test('a liderança vê todos, com a idade, e pode imprimir', async ({ page }) => {
  await openLoggedIn(page, accounts['lider-a'].session, '/i/teste-a/#/aniversariantes?mes=2027-03');
  await expect(page.locator('.bday-day', { hasText: 'Fulano da A' })).toContainText('faz 47 anos');
  await page.getByRole('link', { name: 'Próximo mês' }).click();
  await expect(page.getByRole('heading', { name: 'Aniversariantes de abril' })).toBeVisible();
  // Imprimir fica no botão redondo (com o ícone da impressora, não o "+").
  // O botão mostra primeiro a folha na tela (prévia), com o mês que estava aberto.
  await page.locator('.fab#print').click();
  await expect(page).toHaveURL(/#\/aniversariantes\/imprimir\?mes=2027-04$/);
  await expect(page.getByRole('heading', { name: 'Aniversariantes de abril de 2027' })).toBeVisible();
  await expect(page.locator('.sheet .sheet-church')).toHaveText('Igreja Teste A');
  await expect(page.locator('.sheet-foot')).toContainText('Gerado pelo app da Igreja Teste A');
  await expect(page.locator('.sheet-signs')).toHaveCount(0);
  // Na impressão sai só a folha: o voltar e o botão somem.
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.sheet-foot')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Imprimir ou salvar PDF' })).toBeHidden();
  await expect(page.getByRole('link', { name: '← Aniversariantes' })).toBeHidden();
  await page.emulateMedia({ media: 'screen' });
  await page.getByRole('link', { name: '← Aniversariantes' }).click();
  await expect(page.getByRole('heading', { name: 'Aniversariantes de abril' })).toBeVisible();

  // A folha de março traz as pessoas, sem fotos.
  await page.evaluate(() => (location.hash = '/aniversariantes/imprimir?mes=2027-03'));
  await expect(page.locator('.sheet-bday', { hasText: 'Fulano da A' })).toContainText('faz 47 anos');
  await expect(page.locator('.sheet .avatar')).toHaveCount(0);
});

test('o admin vê a prévia da mensagem com os campos trocados', async ({ page }) => {
  await openLoggedIn(page, accounts['adm-a'].session, '/i/teste-a/#/config/aniversario');
  await page.getByLabel('Título').fill('Parabéns, ');
  await page.getByRole('button', { name: '{primeiro_nome}' }).click();
  await expect(page.locator('#pv-title')).toHaveText('Parabéns, Admin');
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('{igreja} deseja feliz {idade} anos!');
  await expect(page.locator('#pv-body')).toHaveText('Igreja Teste A deseja feliz 30 anos!');
  // Emoji entra onde está o cursor (aqui, no fim da mensagem).
  await page.getByRole('button', { name: 'Colocar 🎂' }).click();
  await expect(page.locator('#pv-body')).toHaveText('Igreja Teste A deseja feliz 30 anos!🎂');
  await page.getByLabel('Título').focus();
  await page.getByRole('button', { name: 'Colocar 🎉' }).click();
  await expect(page.locator('#pv-title')).toHaveText('Parabéns, Admin🎉');
});

test('o Início mostra avisos, eventos e aniversariantes num carrossel abaixo dos atalhos', async ({ page }) => {
  // 10/06/2027: "Casada da A" faz aniversário de casamento no dia 12. Aviso e evento fixos.
  await page.clock.setFixedTime(new Date('2027-06-10T12:00:00-03:00'));
  await page.route('**/rest/v1/announcements?*', (r) =>
    r.fulfill({ json: [{ id: 'a1', title: 'Retiro de jovens', body: 'Inscrições abertas', pinned: false, created_at: '2027-06-09T12:00:00Z' }] }),
  );
  await page.route('**/rest/v1/rpc/events_between', (r) =>
    r.fulfill({ json: [{ event_id: 'e1', title: 'Culto de domingo', starts_at: '2027-06-13T22:00:00Z', ends_at: null, location: null, repeat_weekly: false }] }),
  );
  await openLoggedIn(page, accounts['lider-a'].session, '/i/teste-a/#/');
  const carousel = page.locator('#home-carousel');
  await expect(carousel).toBeVisible();
  // Abaixo dos atalhos.
  expect(await page.evaluate(() => {
    const s = document.querySelector('.shortcuts');
    return !!(s.compareDocumentPosition(document.getElementById('home-carousel')) & Node.DOCUMENT_POSITION_FOLLOWING);
  })).toBe(true);
  await expect(carousel.locator('.slide h2')).toHaveText([/Avisos/, /Próximos eventos/, /Aniversariantes/]);
  const dots = carousel.locator('.carousel-dots button');
  await expect(dots).toHaveCount(3);
  await dots.nth(2).click();
  await expect(dots.nth(2)).toHaveAttribute('aria-current', 'true');
  await expect(carousel.locator('#week-birthdays')).toBeInViewport();
});
