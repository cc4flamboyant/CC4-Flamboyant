// Agenda, avisos e central de notificações nas telas, com contas da igreja Teste A (Android).
// O que o teste cria leva uma marca no título e é apagado no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const tag = `UI ${Date.now().toString(36)}`;

// Amanhã no horário de Brasília, o mesmo do navegador nos testes (o GitHub roda em UTC:
// entre 21h e meia-noite, o "amanhã" de lá já seria depois de amanhã aqui).
const tomorrow = () => new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });

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
  for (const table of ['events', 'announcements']) {
    await api.delete(rest(`${table}?title=like.*${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  }
  await api.dispose();
});

test('a líder cria um evento semanal e o membro vê na agenda, com "adicionar à agenda"', async ({ page, browser }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/agenda/novo');
  await page.getByLabel('Título').fill(`Culto ${tag}`);
  await page.getByLabel('Data').fill(tomorrow());
  await page.getByLabel('Começa: hora').selectOption('19');
  await page.getByLabel('Termina (opcional): hora').selectOption('21');
  await page.getByLabel('Local (opcional)').fill('Templo principal');
  await page.getByLabel('Repetir toda semana').check();
  await page.getByRole('button', { name: 'Criar evento' }).click();
  await expect(page.getByRole('heading', { name: `Culto ${tag}` })).toBeVisible();
  await expect(page.locator('.page')).toContainText('Amanhã · 19h–21h');
  await expect(page.locator('.page')).toContainText('Repete toda semana');

  const member = await (await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' })).newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/agenda');
  const card = member.locator('.event-card', { hasText: `Culto ${tag}` }).first();
  await expect(card).toContainText('19h');
  await expect(card).toContainText('Toda semana');
  await card.click();
  await expect(member.getByRole('button', { name: 'Editar' })).toHaveCount(0);
  const download = member.waitForEvent('download');
  await member.getByRole('button', { name: 'Adicionar à agenda' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^evento-\d{4}-\d{2}-\d{2}\.ics$/);
  await expect(member.getByRole('link', { name: 'Google Agenda' })).toHaveAttribute('href', /calendar\.google\.com/);
  await member.context().close();
});

test('a líder publica um aviso fixado e o membro vê no mural e no início', async ({ page, browser }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/avisos/novo');
  await page.getByLabel('Título').fill(`Aviso ${tag}`);
  await page.getByRole('textbox', { name: 'Aviso', exact: true }).fill('Ensaio do coral no sábado às 15h.');
  await page.getByLabel('Fixar no topo').check();
  await page.getByRole('button', { name: 'Publicar aviso' }).click();
  await expect(page.locator('.announcement', { hasText: `Aviso ${tag}` })).toContainText('Fixado');

  const member = await (await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' })).newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/avisos');
  const card = member.locator('.announcement', { hasText: `Aviso ${tag}` });
  await expect(card).toContainText('Ensaio do coral');
  await expect(card.getByRole('button', { name: 'Excluir' })).toHaveCount(0);
  await member.evaluate(() => (location.hash = '/'));
  await expect(member.locator('#home-notices')).toContainText(`Aviso ${tag}`);
  await member.context().close();
});

test('o membro busca nos avisos pelo título e pelo texto, sem acento e sem maiúsculas', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/avisos');
  const card = page.locator('.announcement', { hasText: `Aviso ${tag}` });
  await expect(card).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Buscar nos avisos' });
  // Pelo texto, sem acento e em maiúsculas.
  await search.fill('CORAL NO SABADO');
  await expect(card).toBeVisible();
  // Pelo título: só o aviso do teste.
  await search.fill(tag);
  await expect(page.locator('.announcement')).toHaveCount(1);
  await expect(page.locator('#announcement-count')).toHaveText('1 aviso encontrado');
  // Reagir não apaga a busca nem fecha o teclado.
  await card.getByRole('button', { name: 'Reagir com emoji' }).click();
  await expect(card.locator('.reaction-picker')).toBeVisible();
  await expect(search).toHaveValue(tag);
  // Nada encontrado.
  await search.fill('xyzw nada aqui');
  await expect(page.locator('.announcement')).toHaveCount(0);
  await expect(page.getByText('Nenhum aviso com “xyzw nada aqui”.')).toBeVisible();
  // Limpa: volta tudo.
  await search.fill('');
  await expect(card).toBeVisible();
  await expect(page.locator('#announcement-count')).toHaveText('');
});

test('o membro reage ao aviso com emoji, troca e tira, e a reação fica gravada', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/avisos');
  const card = page.locator('.announcement', { hasText: `Aviso ${tag}` });
  await card.getByRole('button', { name: 'Reagir com emoji' }).click();
  const saved = () => page.waitForResponse((res) => res.url().includes('rpc/set_announcement_reaction') && res.ok());
  await Promise.all([saved(), card.getByRole('button', { name: 'Reagir com 🎉' }).click()]);
  await expect(card.locator('.reaction.mine')).toHaveText('🎉1');
  await expect(card.locator('.reaction-picker')).toBeHidden();
  // Gravou no banco: abre de novo e espera a resposta do banco.
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(card.locator('.reaction.mine')).toHaveText('🎉1');
  // Trocar de emoji.
  await card.getByRole('button', { name: 'Reagir com emoji' }).click();
  await Promise.all([saved(), card.getByRole('button', { name: 'Reagir com 👍' }).click()]);
  await expect(card.locator('.reaction.mine')).toHaveText('👍1');
  await expect(card.locator('.reaction', { hasText: '🎉' })).toHaveCount(0);
  // Tocar na própria reação tira.
  await Promise.all([saved(), card.locator('.reaction.mine').click()]);
  await expect(card.locator('.reaction.mine')).toHaveCount(0);
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(card.locator('.reaction.mine')).toHaveCount(0);
});

test('o membro abre a central de notificações pelo sininho', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await page.getByRole('link', { name: 'Notificações' }).first().click();
  await expect(page.getByRole('heading', { name: 'Notificações', level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/\/i\/teste-a\/#\/notificacoes$/);
  // Nenhuma aba de baixo fica marcada: a central abre pelo sininho.
  await expect(page.locator('#tabbar a.active')).toHaveCount(0);
  await page.getByRole('link', { name: 'Avisos', exact: true }).first().click();
  await expect(page).toHaveURL(/#\/notificacoes\?ver=avisos$/);
  await expect(page.locator('.chip.active')).toHaveText('Avisos');
});

test('a central mostra as notificações por dia, com destaque nas não lidas', async ({ page }) => {
  // Meio-dia fixo: perto da meia-noite, "30 horas atrás" já não seria "ontem".
  const now = new Date('2027-06-10T12:00:00-03:00').getTime();
  await page.clock.setFixedTime(now);
  const rows = [
    { id: 1, kind: 'sala', title: 'Sala Kids: Domingo tem passeio', body: 'Toque para ler o aviso.', url: '#/filhos', read_at: null, created_at: new Date(now - 5 * 60e3).toISOString() },
    { id: 2, kind: 'evento', title: 'Culto de domingo', body: 'Amanhã às 19h', url: '#/agenda', read_at: new Date(now).toISOString(), created_at: new Date(now - 30 * 3600e3).toISOString() },
    { id: 3, kind: 'aviso', title: 'Retiro de jovens', body: 'Inscrições abertas', url: '#/avisos', read_at: new Date(now).toISOString(), created_at: new Date(now - 20 * 864e5).toISOString() },
  ];
  // Lista fixa (a central de verdade muda com os outros testes); "marcar como lida" não grava.
  await page.route('**/rest/v1/notifications?*', (route) =>
    route.request().method() === 'GET' && !route.request().headers()['prefer']?.includes('count')
      ? route.fulfill({ json: rows })
      : route.fulfill({ status: 204 }),
  );
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/notificacoes');
  await expect(page.locator('.notif-day')).toHaveText(['Hoje', 'Ontem', 'Mais antigas']);
  await expect(page.locator('.notif-row.unread')).toHaveCount(1);
  await expect(page.locator('.notif-row.unread')).toContainText('Sala Kids: Domingo tem passeio');
  await expect(page.locator('.notif-row').nth(1).locator('.notif-icon')).toHaveClass(/k-agenda/);
  await expect(page.getByRole('button', { name: 'Apagar as lidas' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ver mais' })).toBeHidden();
});

test('a líder marca o local do evento no mapa, e o membro vê o mapa e a rota', async ({ page, browser }) => {
  // A busca de endereço responde sempre o mesmo ponto (o serviço de verdade fica fora do teste).
  await page.route('https://nominatim.openstreetmap.org/**', (r) =>
    r.fulfill({ json: [{ lat: '-15.7942', lon: '-47.8822', display_name: 'Praça dos Três Poderes, Brasília' }] }),
  );
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/agenda/novo');
  await page.getByLabel('Título').fill(`Mapa ${tag}`);
  await page.getByLabel('Data').fill(tomorrow());
  await page.getByLabel('Começa: hora').selectOption('19');
  await page.getByLabel('Local (opcional)').fill('Praça dos Três Poderes');
  await expect(page.getByText('Sem alfinete no mapa')).toBeVisible();
  await page.getByRole('button', { name: 'Marcar no mapa' }).click();
  const dialog = page.getByRole('dialog', { name: 'Marcar no mapa' });
  // Já busca o endereço digitado; com um resultado só, o alfinete vai para lá.
  await expect(dialog.locator('.map-pin')).toBeVisible();
  await dialog.getByRole('button', { name: 'Usar este ponto' }).click();
  await expect(page.getByText('📍 Local marcado no mapa')).toBeVisible();
  await page.getByRole('button', { name: 'Criar evento' }).click();
  await expect(page.getByRole('heading', { name: `Mapa ${tag}` })).toBeVisible();

  const member = await (await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' })).newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/agenda');
  await member.locator('.event-card', { hasText: `Mapa ${tag}` }).first().click();
  await expect(member.locator('.place-map .map-pin')).toBeVisible();
  await expect(member.getByRole('link', { name: 'Rota no Google Maps' })).toHaveAttribute('href', /destination=-15\.7942,-47\.8822$/);
  await expect(member.getByRole('link', { name: 'Ir com o Waze' })).toHaveAttribute('href', /ll=-15\.7942,-47\.8822&navigate=yes$/);
  await member.context().close();
});

test('Agenda, Avisos e o evento abrem na hora pelas abas, mesmo com o banco demorando', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  // O Início já busca a Agenda, os Avisos e os detalhes dos eventos em segundo plano.
  await expect(page.locator('#home-notices')).toContainText(`Aviso ${tag}`);
  await page.waitForLoadState('networkidle');
  // Daqui em diante, o banco leva 4 segundos para responder.
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  const fast = { timeout: 1000 };
  await page.locator('#tabbar').getByRole('link', { name: 'Agenda' }).click();
  await page.getByRole('navigation', { name: 'Vista da agenda' }).getByRole('link', { name: 'Lista' }).click(); // a aba abre o calendário
  await expect(page.locator('.event-card', { hasText: `Culto ${tag}` }).first()).toBeVisible(fast);
  await page.locator('#tabbar').getByRole('link', { name: 'Avisos' }).click();
  await expect(page.locator('.announcement', { hasText: `Aviso ${tag}` })).toBeVisible(fast);
  await page.locator('#tabbar').getByRole('link', { name: 'Agenda' }).click();
  await page.getByRole('navigation', { name: 'Vista da agenda' }).getByRole('link', { name: 'Lista' }).click(); // a aba abre o calendário
  await page.locator('.event-card', { hasText: `Culto ${tag}` }).first().click();
  await expect(page.getByRole('heading', { name: `Culto ${tag}` })).toBeVisible(fast);

  // As outras telas do Menu e o sininho também já vêm prontas.
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Aniversariantes do mês' }).click();
  await expect(page.getByRole('heading', { name: /^Aniversariantes de / }).first()).toBeVisible(fast);
  await page.getByRole('link', { name: 'Notificações' }).first().click();
  await expect(page.locator('#notif-items')).not.toContainText('Carregando', fast);
});

test('Meu cadastro, a ficha do membro e editar evento e aviso também abrem na hora', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/');
  await expect(page.locator('#home-notices')).toContainText(`Aviso ${tag}`);
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  const fast = { timeout: 1000 };
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Meu cadastro' }).click();
  await expect(page.getByLabel('Nome')).toHaveValue('Líder da A', fast);

  // Membros fica no Menu (no menu de baixo está o Chat).
  await page.locator('#tabbar').getByRole('link', { name: 'Menu' }).click();
  await page.getByRole('link', { name: 'Membros' }).click();
  await page.locator('.member-row', { hasText: 'Fulano da A' }).click();
  await expect(page.getByLabel('Nome')).toHaveValue('Fulano da A', fast);

  await page.locator('#tabbar').getByRole('link', { name: 'Agenda' }).click();
  await page.getByRole('navigation', { name: 'Vista da agenda' }).getByRole('link', { name: 'Lista' }).click(); // a aba abre o calendário
  await page.locator('.event-card', { hasText: `Culto ${tag}` }).first().click();
  await page.getByRole('link', { name: 'Editar' }).click();
  await expect(page.getByLabel('Título')).toHaveValue(`Culto ${tag}`, fast);

  await page.locator('#tabbar').getByRole('link', { name: 'Avisos' }).click();
  await page.locator('.announcement', { hasText: `Aviso ${tag}` }).getByRole('link', { name: 'Editar' }).click();
  await expect(page.getByLabel('Título')).toHaveValue(`Aviso ${tag}`, fast);
});

test('o botão + de novo evento e de novo aviso aparece só para a liderança', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/agenda');
  await page.getByRole('link', { name: 'Novo evento' }).click();
  await expect(page.getByRole('heading', { name: 'Novo evento' })).toBeVisible();
  await page.evaluate(() => (location.hash = '/avisos'));
  await page.getByRole('link', { name: 'Novo aviso' }).click();
  await expect(page.getByRole('heading', { name: 'Novo aviso' })).toBeVisible();

  const member = await page.context().newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/agenda');
  await expect(member.getByRole('heading', { name: 'Agenda' })).toBeVisible();
  await expect(member.locator('.fab')).toHaveCount(0);
  await member.evaluate(() => (location.hash = '/avisos'));
  await expect(member.getByRole('heading', { name: 'Avisos' })).toBeVisible();
  await expect(member.locator('.fab')).toHaveCount(0);
});
