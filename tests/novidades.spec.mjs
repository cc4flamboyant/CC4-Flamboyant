// Logo do Início, pedidos de oração, salas (semana e ordem) e chat (grupo no Início e ordem),
// com contas da Teste A (Android). O que o teste cria leva uma marca no nome e é apagado no fim.
import { test, expect } from '@playwright/test';
import { rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations } from './helpers.mjs';

test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const ids = {};
const tag = `Nov ${Date.now().toString(36)}`;
const returning = (h) => ({ ...h, Prefer: 'return=representation' });

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['adm-a', 'lider-a', 'membro-a']) as[u] = await loginAs(api, u);
  [{ id: ids.church }] = await (await api.get(rest('churches?select=id&slug=eq.teste-a'), { headers: as['adm-a'].headers })).json();
});

test.afterAll(async () => {
  if (!api) return;
  await api.delete(rest(`prayer_requests?body=like.*${encodeURIComponent(tag)}*`), { headers: as['adm-a'].headers });
  if (ids.kid) await api.delete(rest(`children?id=eq.${ids.kid}`), { headers: as['membro-a'].headers });
  await api.delete(rest(`children?church_id=eq.${ids.church}&name=like.*${encodeURIComponent(tag)}*`), { headers: as['lider-a'].headers });
  for (const r of [ids.r1, ids.r2].filter(Boolean)) await api.delete(rest(`kids_rooms?id=eq.${r}`), { headers: as['adm-a'].headers });
  for (const g of [ids.g1, ids.g2].filter(Boolean)) await api.delete(rest(`chat_groups?id=eq.${g}`), { headers: as['lider-a'].headers });
  await api.patch(rest(`churches?id=eq.${ids.church}`), { headers: as['adm-a'].headers, data: { home_order: null } });
  await api.dispose();
});

// Arrasta o item pela alça até o lugar do outro.
async function dragOnto(page, grip, target) {
  const a = await grip.boundingBox();
  const b = await target.boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, b.y + b.height / 2 + (b.y > a.y ? 10 : -10), { steps: 12 });
  await page.mouse.up();
}

test.describe('com o service worker', () => {
  test.use({ serviceWorkers: 'allow' });
test('notificação de teste aparece mesmo com o app aberto na tela Notificações', async ({ page, context }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/notificacoes');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 15000 }).toBe(true);
  // Entrega uma mensagem ao service worker como o servidor de push faria.
  const cdp = await context.newCDPSession(page);
  const regs = [];
  cdp.on('ServiceWorker.workerRegistrationUpdated', (e) => regs.push(...e.registrations));
  await cdp.send('ServiceWorker.enable');
  await expect.poll(() => regs.length).toBeGreaterThan(0);
  const scope = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
  const reg = regs.find((r) => r.scopeURL === scope && !r.isDeleted);
  const deliver = (data) =>
    cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(page.url()).origin, registrationId: reg.registrationId, data: JSON.stringify(data) });
  // O Chrome de teste (sem tela) não mostra notificações: o teste anota o que o service worker manda mostrar.
  await expect.poll(() => context.serviceWorkers().length).toBeGreaterThan(0);
  const sw = context.serviceWorkers().find((w) => w.url().endsWith('sw.js'));
  await sw.evaluate(() => {
    self.__shown = [];
    self.registration.showNotification = (title) => (self.__shown.push(title), Promise.resolve());
  });
  const shown = () => sw.evaluate(() => self.__shown);
  const here = page.url();
  // Uma mensagem comum para a tela que a pessoa está vendo não aparece (como no chat aberto)…
  await deliver({ title: 'Mensagem comum', url: here });
  // …mas o aviso de teste aparece sempre.
  await deliver({ title: 'Aviso de teste', url: here, tag: 'teste' });
  await expect.poll(shown, { timeout: 10000 }).toContain('Aviso de teste');
  expect(await shown()).not.toContain('Mensagem comum');
});
});

test('Início: a logo grande abre em tela cheia, com Voltar', async ({ page }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  await page.getByRole('button', { name: 'Ver a logo' }).click();
  const viewer = page.getByRole('dialog', { name: 'Igreja Teste A' });
  await expect(viewer.locator('#viewer-img')).toBeVisible();
  // Tema claro: fundo branco.
  const bg = () => viewer.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(bg).toBe('rgb(255, 255, 255)');
  // Tema escuro: a cor da instituição (a mesma do fundo do tema escuro com a cor principal).
  await page.emulateMedia({ colorScheme: 'dark' });
  const church = await page.evaluate(() => {
    const t = Object.assign(document.createElement('i'), { style: 'color: var(--church-dark)' });
    document.body.append(t);
    const c = getComputedStyle(t).color;
    t.remove();
    return c;
  });
  expect(church).not.toBe('rgb(255, 255, 255)');
  await expect.poll(bg).toBe(church);
  await page.emulateMedia({ colorScheme: 'light' });
  await viewer.getByRole('button', { name: 'Voltar' }).click();
  await expect(viewer).toHaveCount(0);
  // O atalho de Oração está no Início.
  await expect(page.locator('#home-shortcuts').getByRole('link', { name: 'Oração' })).toBeVisible();
});

test('Início: o administrador organiza os atalhos arrastando, e vale para todos (034)', async ({ page, browser }) => {
  await api.patch(rest(`churches?id=eq.${ids.church}`), { headers: as['adm-a'].headers, data: { home_order: null } });
  await openLoggedIn(page, as['adm-a'].session, '/i/teste-a/#/');
  const box = page.locator('#home-shortcuts');
  const tile = (name) => box.locator('.shortcut', { hasText: name }).first();
  await expect(tile('Oração')).toBeVisible();
  await expect(box.locator('.shortcut').first()).toContainText('Agenda');
  await page.getByRole('button', { name: 'Organizar atalhos' }).click();
  await expect(page.getByText('Arraste os atalhos para mudar a ordem. Vale para todos.')).toBeVisible();
  // Organizando, tocar no atalho não abre a tela.
  await tile('Avisos').click();
  await expect(page).toHaveURL(/#\/$/);
  // Arrasta "Oração" até o lugar da "Agenda" (o primeiro).
  await expect(async () => {
    const a = await tile('Oração').boundingBox();
    const b = await tile('Agenda').boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 3, b.y + b.height / 2, { steps: 16 });
    await page.waitForTimeout(350);
    await page.mouse.up();
    await expect(box.locator('.shortcut').first()).toContainText('Oração', { timeout: 1000 });
  }).toPass({ timeout: 15000 });
  await page.getByRole('button', { name: 'Pronto' }).click();
  await expect(page.getByRole('button', { name: 'Organizar atalhos' })).toBeVisible();
  // Salvou no banco…
  await expect
    .poll(async () => (await (await api.get(rest(`churches?select=home_order&id=eq.${ids.church}`), { headers: as['adm-a'].headers })).json())[0].home_order?.[0])
    .toBe('oracao');
  // …e o membro vê na mesma ordem (sem o botão de organizar).
  const ctx = await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' });
  const member = await ctx.newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/');
  await expect(member.locator('#home-shortcuts .shortcut').first()).toContainText('Oração');
  await expect(member.getByRole('button', { name: 'Organizar atalhos' })).toHaveCount(0);
  await ctx.close();
});

test('a liderança cadastra a criança ligada ao pai do cadastro; depois troca o responsável (036)', async ({ page, browser }) => {
  const kid = `${tag} Bia`;
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/salas/crianca/nova');
  await page.getByLabel('Nome da criança').fill(kid);
  await page.getByLabel('Data de nascimento').fill('2019-05-10');
  // Padrão: pai ou mãe do cadastro, com busca pelo nome.
  await expect(page.getByRole('radio', { name: 'Pai ou mãe do cadastro' })).toBeChecked();
  await expect(page.getByLabel('Nome do responsável')).toBeHidden();
  await page.getByLabel('Buscar pelo nome').fill('Membro da A');
  await expect(page.getByRole('combobox', { name: 'Pai ou mãe' })).toHaveValue(/[0-9a-f-]{36}/);
  await page.getByLabel(/O responsável autorizou/).check();
  await page.getByRole('button', { name: 'Cadastrar' }).click();
  await expect(page.locator('#toast')).toHaveText('Criança cadastrada.');

  // O pai vê a criança em "Meus filhos".
  const ctx = await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' });
  const member = await ctx.newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/filhos');
  await expect(member.locator('.page')).toContainText(kid);

  // A liderança troca para um responsável sem o app: o pai deixa de ver.
  await page.goto('/i/teste-a/#/salas/criancas');
  await page.getByRole('link', { name: new RegExp(kid) }).click();
  await expect(page.getByRole('combobox', { name: 'Pai ou mãe' })).toHaveValue(/[0-9a-f-]{36}/);
  await page.getByText('Não usa o app').click();
  await page.getByLabel('Nome do responsável').fill('Avó da Bia');
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.locator('#toast')).toHaveText('Salvo.');
  await member.reload();
  await expect(member.getByRole('heading', { name: 'Meus filhos' })).toBeVisible();
  await expect(member.locator('.page')).not.toContainText(kid);
  await ctx.close();
});

test('Início: o aniversário do filho aparece no cartão da semana (033)', async ({ page }) => {
  const [{ id: membro }] = await (await api.get(rest(`members?select=id&church_id=eq.${ids.church}&user_id=eq.${as['membro-a'].id}`), { headers: as['adm-a'].headers })).json();
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const md = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const kidName = `${tag} Lia`;
  const kid = await api.post(rest('children'), {
    headers: returning(as['membro-a'].headers),
    data: { church_id: ids.church, name: kidName, birth_date: `2018-${md === '02-29' ? '02-28' : md}`, guardian_member_id: membro },
  });
  ids.kid = (await kid.json())[0].id;
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/');
  const item = page.locator('#week-birthdays .bday-list li', { hasText: kidName });
  await expect(item).toBeVisible({ timeout: 15000 });
  await expect(item).toContainText('Hoje');
  await expect(item).toContainText(`faz ${now.getFullYear() - 2018} anos`);
});

test('oração: o membro pede para todos; a direção aprova; vai para o mural com "Vou orar"', async ({ page, browser }) => {
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/oracao');
  await expect(page.getByRole('heading', { name: 'Pedidos de oração' })).toBeVisible();
  await page.getByRole('link', { name: 'Fazer um pedido' }).click();
  await page.getByLabel('Seu pedido').fill(`${tag} pela prova de matemática`);
  await page.getByLabel(/Para todos orarem junto/).check();
  await page.getByLabel(/Não mostrar meu nome/).check();
  await page.getByRole('button', { name: 'Enviar pedido' }).click();
  await expect(page.getByText('Pedido enviado. Ele vai para o mural depois da aprovação.')).toBeVisible();
  const mine = page.locator('article.prayer', { hasText: tag });
  await expect(mine).toContainText('Aguardando aprovação');

  // A líder aprova na moderação.
  const leader = await (await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' })).newPage();
  await openLoggedIn(leader, as['lider-a'].session, '/i/teste-a/#/oracao/moderar');
  const card = leader.locator('article.prayer', { hasText: tag });
  await expect(card).toContainText('Anônimo para os membros');
  await card.getByRole('button', { name: 'Aprovar' }).click();
  await expect(leader.getByText('Pedido aprovado: já está no mural.')).toBeVisible();
  await leader.context().close();

  // No mural, com "Vou orar".
  await page.goto('/i/teste-a/#/oracao');
  const onWall = page.locator('article.prayer', { hasText: tag });
  await expect(onWall).toBeVisible();
  await onWall.getByRole('button', { name: /Vou orar/ }).click();
  await expect(onWall.getByRole('button', { name: /Estou orando · 1/ })).toBeVisible();
  // No carrossel do Início também (os mesmos 30 dias do mural). Quem pediu vê o próprio nome.
  await page.goto('/i/teste-a/#/');
  const slide = page.locator('#home-prayers');
  await expect(slide).toContainText(`${tag} pela prova de matemática`);
  await expect(slide).toContainText('Membro da A');
  await expect(slide).toContainText('🙏 1 orando');
  await slide.getByRole('link', { name: 'Ver o mural de oração' }).click({ force: true });
  await expect(page.getByRole('heading', { name: 'Pedidos de oração' })).toBeVisible();
});

test('salas: a semana aparece no cartão; a liderança muda a ordem arrastando', async ({ page }) => {
  const room = async (name) =>
    (await (await api.post(rest('kids_rooms'), { headers: returning(as['adm-a'].headers), data: { church_id: ids.church, name } })).json())[0].id;
  ids.r1 = await room(`${tag} Alfa`.slice(0, 40));
  ids.r2 = await room(`${tag} Beta`.slice(0, 40));
  await openLoggedIn(page, as['lider-a'].session, `/i/teste-a/#/salas/${ids.r1}/editar`);
  await page.getByLabel('Semana').selectOption({ label: 'Semana 7' });
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Sala salva.')).toBeVisible();
  await page.goto('/i/teste-a/#/salas');
  const alfa = page.locator('.sort-row', { hasText: `${tag} Alfa` });
  const beta = page.locator('.sort-row', { hasText: `${tag} Beta` });
  await expect(alfa.locator('.week-tag')).toHaveText('Semana 7');
  // Beta para cima de Alfa.
  const order = () => page.locator('#rooms-list .sort-row').evaluateAll((rows, t) => rows.map((r) => r.textContent).filter((x) => x.includes(t)).map((x) => (x.includes('Alfa') ? 'Alfa' : 'Beta')), tag);
  const before = await order();
  await dragOnto(page, (before[0] === 'Alfa' ? beta : alfa).getByRole('button', { name: /Mudar a ordem/ }), before[0] === 'Alfa' ? alfa : beta);
  const after = await order();
  expect(after).toEqual([...before].reverse());
  // Ficou gravado: recarregando, a mesma ordem.
  await page.waitForResponse((r) => r.url().includes('rpc/rooms_reorder')).catch(() => {});
  await page.reload();
  await expect.poll(order).toEqual(after);
});

test('chat: o grupo vai para o Início pelo Editar grupo; a lista muda de ordem arrastando', async ({ page }) => {
  const [{ id: membro }] = await (await api.get(rest(`members?select=id&church_id=eq.${ids.church}&user_id=eq.${as['membro-a'].id}`), { headers: as['adm-a'].headers })).json();
  const group = async (name) =>
    (await api.post(rest('rpc/chat_create_group'), { headers: as['lider-a'].headers, data: { p_church: ids.church, p_name: name, p_description: null, p_locked: false, p_members: [membro] } })).json();
  ids.g1 = await group(`${tag} Um`);
  ids.g2 = await group(`${tag} Dois`);
  // A líder (administradora do grupo) liga "Mostrar no Início".
  await openLoggedIn(page, as['lider-a'].session, `/i/teste-a/#/chat/${ids.g1}/info`);
  await expect(page.locator('#home-icon-choice')).toBeHidden();
  await page.getByLabel(/Mostrar no Início/).check();
  // Com "Mostrar no Início" marcado, escolhe o ícone do atalho.
  await expect(page.locator('#home-icon-choice')).toBeVisible();
  await page.getByRole('radio', { name: 'Coração' }).check({ force: true });
  await page.getByRole('button', { name: 'Salvar' }).click();
  await expect(page.getByText('Grupo salvo.')).toBeVisible();
  const [saved] = await (await api.get(rest(`chat_groups?select=home_icon&id=eq.${ids.g1}`), { headers: as['lider-a'].headers })).json();
  expect(saved.home_icon).toBe('heart');
  // O membro vê o atalho no Início e muda a ordem da própria lista.
  const ctx = await page.context().browser().newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/' });
  const member = await ctx.newPage();
  await openLoggedIn(member, as['membro-a'].session, '/i/teste-a/#/');
  const tile = member.locator('#home-shortcuts [data-chat-tile]', { hasText: `${tag} Um` });
  await expect(tile).toBeVisible();
  // O atalho tem o ícone escolhido (o mesmo desenho do atalho "Oração").
  const heart = await member.locator('#home-shortcuts .shortcut[data-key="oracao"] svg').innerHTML();
  await expect.poll(() => tile.locator('svg').innerHTML()).toBe(heart);
  await tile.click();
  await expect(member.locator('#chat-name')).toHaveText(`${tag} Um`);
  await member.goto('/i/teste-a/#/chat');
  const names = () => member.locator('#chat-list .sort-row').evaluateAll((rows, t) => rows.map((r) => r.textContent).filter((x) => x.includes(t)).map((x) => (x.includes(`${t} Um`) ? 'Um' : 'Dois')), tag);
  await expect.poll(names).toHaveLength(2);
  const before = await names();
  const first = member.locator('#chat-list .sort-row', { hasText: `${tag} ${before[0]}` });
  const second = member.locator('#chat-list .sort-row', { hasText: `${tag} ${before[1]}` });
  await Promise.all([
    member.waitForResponse((r) => r.url().includes('rpc/chat_reorder')),
    dragOnto(member, second.getByRole('button', { name: /Mudar a ordem/ }), first),
  ]);
  const after = await names();
  expect(after).toEqual([...before].reverse());
  await member.reload();
  await expect.poll(names).toEqual(after);
  await ctx.close();
});
