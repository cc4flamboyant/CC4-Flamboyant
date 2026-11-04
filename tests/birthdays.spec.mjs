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
  await page.getByLabel('Título', { exact: true }).fill('Parabéns, ');
  await page.getByRole('button', { name: '{primeiro_nome}' }).click();
  await expect(page.locator('#pv-title')).toHaveText('Parabéns, Admin');
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('{instituicao} deseja feliz {idade} anos!');
  await expect(page.locator('#pv-body')).toHaveText('Igreja Teste A deseja feliz 30 anos!');
  // Emoji entra onde está o cursor (aqui, no fim da mensagem).
  await page.getByRole('button', { name: 'Colocar 🎂' }).click();
  await expect(page.locator('#pv-body')).toHaveText('Igreja Teste A deseja feliz 30 anos!🎂');
  await page.getByLabel('Título', { exact: true }).focus();
  await page.getByRole('button', { name: 'Colocar 🎉' }).click();
  await expect(page.locator('#pv-title')).toHaveText('Parabéns, Admin🎉');
});

test('cartão (031): texto dentro da imagem, arrastar, tamanho, cor e letra (nada é salvo)', async ({ page }) => {
  await openLoggedIn(page, accounts['adm-a'].session, '/i/teste-a/#/config/aniversario');
  // Imagem 400x200 de uma cor só.
  const png = await page.evaluate(() => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 200;
    const g = c.getContext('2d');
    g.fillStyle = '#123456';
    g.fillRect(0, 0, 400, 200);
    return c.toDataURL('image/png').split(',')[1];
  });
  await page.locator('input[name="image"]').setInputFiles({ name: 'arte.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await page.getByLabel(/como um cartão/).check();
  const card = page.locator('#pv-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveJSProperty('width', 1080);
  await expect(card).toHaveJSProperty('height', 540);

  // Conta os pontos brancos (texto branco) numa faixa do cartão, de a até b (0 a 1).
  const white = (a = 0, b = 1) =>
    card.evaluate(
      (c, [a, b]) => {
        const x0 = Math.round(c.width * a);
        const d = c.getContext('2d').getImageData(x0, 0, Math.round(c.width * b) - x0, c.height).data;
        let n = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) n++;
        return n;
      },
      [a, b],
    );
  expect(await white()).toBeGreaterThan(500);

  // Área estreita, arrastada para a esquerda: nada de texto na metade direita.
  await page.locator('input[name="card_width"]').fill('40');
  const editor = page.locator('#card-edit');
  await editor.scrollIntoViewIfNeeded();
  const r = await editor.boundingBox();
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.15, r.y + r.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => white(0.5, 1)).toBeLessThan(20);
  await page.getByRole('button', { name: 'Centralizar' }).click();
  await expect.poll(() => white(0.5, 1)).toBeGreaterThan(100);

  // Letras maiores = mais pontos brancos.
  await page.locator('input[name="card_width"]').fill('100');
  await page.locator('input[name="card_size"]').fill('50');
  const before = await white();
  await page.locator('input[name="card_size"]').fill('80');
  await expect.poll(() => white()).toBeGreaterThan(before * 1.5);

  // Cor pronta e cor digitada.
  await page.getByRole('button', { name: 'Preto' }).click();
  await expect.poll(() => white()).toBeLessThan(50);
  await page.locator('.color-code[data-for="card_text_color"]').fill('#ffffff');
  await expect.poll(() => white()).toBeGreaterThan(500);

  // Letra: o arquivo é baixado quando escolhida.
  await page.locator('select[name="card_font"]').selectOption('greatvibes');
  await expect
    .poll(() => page.evaluate(() => [...document.fonts].some((f) => f.family.includes('Cartao GreatVibes') && f.status === 'loaded')))
    .toBe(true);

  // Desligado: volta a imagem sozinha.
  await page.getByLabel(/como um cartão/).uncheck();
  await expect(card).toBeHidden();
  await expect(page.locator('#pv-image')).toBeVisible();
});

test('o Início mostra avisos, eventos e aniversariantes num carrossel abaixo dos atalhos', async ({ page }) => {
  // 10/06/2027. Aviso, evento e aniversariante fixos; o casamento (o CC4 não usa) não aparece.
  await page.clock.setFixedTime(new Date('2027-06-10T12:00:00-03:00'));
  await page.route('**/rest/v1/announcements?*', (r) =>
    r.fulfill({ json: [{ id: 'a1', title: 'Retiro de jovens', body: 'Inscrições abertas', pinned: false, created_at: '2027-06-09T12:00:00Z' }] }),
  );
  await page.route('**/rest/v1/rpc/events_between', (r) =>
    r.fulfill({ json: [{ event_id: 'e1', title: 'Culto de domingo', starts_at: '2027-06-13T22:00:00Z', ends_at: null, location: null, repeat_weekly: false }] }),
  );
  await page.route('**/rest/v1/rpc/celebrations_between', (r) =>
    r.fulfill({ json: [
      { member_id: 'm1', name: 'Casada da A', kind: 'casamento', on_date: '2027-06-12', photo_path: null, years: 17 },
      { member_id: 'm2', name: 'Fulano da A', kind: 'aniversario', on_date: '2027-06-13', photo_path: null, years: null },
    ] }),
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
  await expect(carousel.locator('#week-birthdays')).toContainText('Fulano da A');
  await expect(carousel.locator('#week-birthdays')).not.toContainText('Casada da A');
});
