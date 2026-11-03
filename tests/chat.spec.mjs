// Chat em grupos nas telas, com contas da Teste A (Android).
// O grupo do teste leva uma marca no nome e é apagado no fim (com os arquivos).
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, rest, configured, testPassword, loginAs, openLoggedIn, watchCsp, cspViolations, answer } from './helpers.mjs';

// Nada pode ser bloqueado pela regra de segurança das páginas (CSP).
test.beforeEach(async ({ page }) => watchCsp(page));
test.afterEach(async ({ page }) => expect(await cspViolations(page).catch(() => [])).toEqual([]));

test.describe.configure({ mode: 'serial' });

let api;
const as = {};
const name = `Grupo UI ${Date.now().toString(36)}`;
const group = async () => (await (await api.get(rest(`chat_groups?select=id&name=eq.${encodeURIComponent(name)}`), { headers: as['lider-a'].headers })).json())[0];

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
  const g = await group().catch(() => null);
  if (g) {
    const files = await (await api.get(rest(`chat_messages?select=file_path&group_id=eq.${g.id}&file_path=not.is.null`), { headers: as['lider-a'].headers })).json();
    if (files.length) await api.delete(`${SUPABASE_URL}/storage/v1/object/chat`, { headers: as['lider-a'].headers, data: { prefixes: files.map((f) => f.file_path) } });
    await api.delete(rest(`chat_groups?id=eq.${g.id}`), { headers: as['lider-a'].headers });
  }
  await api.dispose();
});

test('a liderança cria o grupo, escolhe quem participa e escreve com emoji, link e anexo', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/menu');
  await page.locator('#tabbar').getByRole('link', { name: 'Chat' }).click();
  await expect(page.getByRole('heading', { name: 'Chat', level: 1 })).toBeVisible();
  await page.getByRole('link', { name: 'Novo grupo' }).click();
  await page.getByLabel('Nome do grupo').fill(name);
  // A busca pelo nome esconde quem não combina; Selecionar todos escolhe todo mundo.
  await page.getByLabel('Buscar pelo nome').fill('zzzz-ninguem');
  await expect(page.locator('.pick-list li:not([hidden])')).toHaveCount(0);
  await page.getByLabel('Buscar pelo nome').fill('');
  await page.getByLabel('Selecionar todos').check();
  await expect(page.locator('#pick-count')).toContainText('escolhid');
  await page.getByRole('button', { name: 'Criar grupo' }).click();

  // A conversa abre: emoji, link e envio.
  await expect(page.locator('#chat-name')).toHaveText(name);
  const box = page.getByRole('textbox', { name: 'Mensagem' });
  await box.fill('Bom dia, turma ');
  await page.getByRole('button', { name: 'Emojis' }).click();
  await page.locator('#chat-emojis [data-emoji="🎓"]').click();
  await box.press('End');
  await box.pressSequentially(' veja www.exemplo.com.br');
  await page.getByRole('button', { name: 'Enviar' }).click();
  const msg = page.locator('.msg.mine').last();
  await expect(msg).toContainText('Bom dia, turma 🎓');
  await expect(msg.getByRole('link', { name: 'www.exemplo.com.br' })).toHaveAttribute('href', 'https://www.exemplo.com.br');
  await expect(box).toHaveValue('');

  // Arrastar a própria mensagem para a esquerda apaga, com Desfazer.
  const drag = async (loc) => {
    const b = await loc.boundingBox();
    await page.mouse.move(b.x + b.width - 10, b.y + b.height / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + b.width - 10 - i * b.width * 0.08, b.y + b.height / 2);
    await page.mouse.up();
  };
  await box.fill('Mensagem para apagar');
  await page.getByRole('button', { name: 'Enviar' }).click();
  const temp = page.locator('.msg-swipe').filter({ hasText: 'Mensagem para apagar' });
  await expect(temp).toBeVisible();
  await drag(temp.locator('.msg'));
  await expect(page.getByText('Mensagem apagada.')).toBeVisible();
  await expect(temp).toBeHidden();
  await page.getByRole('button', { name: 'Desfazer' }).click();
  await expect(temp).toBeVisible();
  await drag(temp.locator('.msg'));
  await expect(temp).toBeHidden();
  // Depois dos 6 segundos do Desfazer, sai do banco (para todos).
  const g0 = await group();
  await expect
    .poll(async () => (await (await api.get(rest(`chat_messages?select=id&group_id=eq.${g0.id}&body=eq.${encodeURIComponent('Mensagem para apagar')}`), { headers: as['lider-a'].headers })).json()).length, { timeout: 15000 })
    .toBe(0);

  // Anexo (documento): aparece como arquivo para abrir.
  await page.locator('#chat-file').setInputFiles({ name: 'lista.txt', mimeType: 'text/plain', buffer: Buffer.from('Material da semana') });
  await expect(page.locator('.msg.mine').last().locator('.msg-doc')).toContainText('lista.txt');
  await expect(page.locator('.msg.mine').last().locator('a.msg-doc')).toBeVisible({ timeout: 15000 });

  // O administrador troca o ícone do grupo: aparece nos dados do grupo, na conversa e na lista.
  const shot = await page.screenshot();
  await page.locator('.chat-title').click();
  await page.locator('#group-icon').setInputFiles({ name: 'icone.png', mimeType: 'image/png', buffer: shot });
  await expect(page.getByText('Ícone do grupo trocado.')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.chat-info-head .avatar img')).toBeVisible();
  await page.getByRole('link', { name: '← Conversa' }).click();
  await expect(page.locator('#chat-icon .avatar img')).toBeVisible();
  await page.locator('.chat-back').click();
  await expect(page.locator('.chat-row').filter({ hasText: name }).locator('.avatar img')).toBeVisible();
});

test('o vídeo abre em tela cheia no app, com Voltar e o campo para escrever sobre o vídeo', async ({ page }) => {
  const g = await group();
  await openLoggedIn(page, as['lider-a'].session, `/i/teste-a/#/chat/${g.id}`);
  await expect(page.locator('#chat-name')).toHaveText(name);
  // Um "vídeo" pequeno (o conteúdo não importa para a tela).
  await page.locator('#chat-file').setInputFiles({ name: 'passeio.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(2048, 1) });
  const open = page.getByRole('button', { name: 'Ver o vídeo em tela cheia' }).last();
  await expect(open).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.msg.mine').last().locator('video.msg-video')).toHaveAttribute('controlslist', 'nofullscreen');

  await open.click();
  const viewer = page.getByRole('dialog', { name: 'Vídeo' });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('video')).toBeVisible();
  // Escreve sobre o vídeo sem sair dele: vai como resposta citando o vídeo.
  await expect(viewer.getByText('Respondendo ao seu vídeo')).toBeVisible();
  await viewer.getByRole('textbox', { name: 'Escreva sobre o vídeo' }).fill('Que passeio lindo! 🎉');
  await viewer.getByRole('button', { name: 'Enviar' }).click();
  await expect(page.getByText('Resposta enviada.')).toBeVisible();
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('textbox', { name: 'Escreva sobre o vídeo' })).toHaveValue('');
  // Voltar (botão flutuante): volta para a conversa, com a mensagem.
  await viewer.getByRole('button', { name: 'Voltar para a conversa' }).click();
  await expect(viewer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/chat/${g.id}$`));
  const reply = page.locator('.msg.mine').last();
  await expect(reply).toContainText('Que passeio lindo! 🎉');
  // A citação mostra quem mandou e que era um vídeo; tocar leva até o vídeo (com destaque).
  const quote = reply.locator('.msg-quote');
  await expect(quote).toContainText('Você');
  await expect(quote).toContainText('🎥 Vídeo');
  await quote.click();
  await expect(page.locator('.msg.flash').locator('video.msg-video')).toHaveCount(1);
  // Recarregando, a citação continua (vem do banco).
  await page.reload();
  await expect(page.locator('.msg.mine').last().locator('.msg-quote')).toContainText('🎥 Vídeo');

  // O voltar do celular também fecha o vídeo e fica na conversa.
  await open.click();
  await expect(viewer).toBeVisible();
  await page.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/chat/${g.id}$`));
  await expect(page.locator('#chat-name')).toHaveText(name);
});

test('o membro vê a mensagem nova; com o grupo bloqueado, só lê', async ({ page }) => {
  const g = await group();
  await openLoggedIn(page, as['membro-a'].session, '/i/teste-a/#/chat');
  const row = page.locator(`a.chat-row[href="#/chat/${g.id}"]`);
  await expect(row).toContainText(name);
  await expect(row.locator('.chat-unread')).toBeVisible();
  await row.click();
  await expect(page.locator('.msg').filter({ hasText: 'Bom dia, turma' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Mensagem' })).toBeVisible();

  // A líder bloqueia o grupo: só os administradores enviam.
  const lock = await api.patch(rest(`chat_groups?id=eq.${g.id}`), { headers: as['lider-a'].headers, data: { locked: true } });
  expect(lock.ok()).toBe(true);
  await page.reload();
  await expect(page.getByText('Só os administradores do grupo enviam mensagens.')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Mensagem' })).toHaveCount(0);

  // Mensagem nova da líder chega na hora (sem recarregar).
  const sent = await api.post(rest('rpc/chat_send'), { headers: as['lider-a'].headers, data: { p_group: g.id, p_body: 'Recado da direção' } });
  expect(sent.ok(), await sent.text()).toBe(true);
  await expect(page.locator('.msg').filter({ hasText: 'Recado da direção' })).toBeVisible({ timeout: 15000 });

  // O membro sai do grupo pelos dados do grupo.
  await page.locator('.chat-title').click();
  await page.getByRole('button', { name: 'Sair do grupo' }).click();
  await answer(page);
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(page.locator(`a.chat-row[href="#/chat/${g.id}"]`)).toHaveCount(0);
});

test('o chat abre na hora, sem esperar o banco', async ({ page }) => {
  await openLoggedIn(page, as['lider-a'].session, '/i/teste-a/#/');
  await page.waitForLoadState('networkidle');
  await page.route('**/rest/v1/**', async (route) => {
    await new Promise((r) => setTimeout(r, 4000));
    await route.continue().catch(() => {});
  });
  await page.getByRole('link', { name: 'Chat' }).first().click();
  await expect(page.locator(`.chat-row`).filter({ hasText: name })).toBeVisible({ timeout: 1000 });
  // A conversa também (buscada em segundo plano), com as mensagens.
  await page.locator('.chat-row').filter({ hasText: name }).click();
  await expect(page.locator('#chat-name')).toHaveText(name, { timeout: 1000 });
  await expect(page.locator('.msg').filter({ hasText: 'Recado da direção' })).toBeVisible({ timeout: 1000 });
  // E o Novo grupo, com a lista de pessoas.
  await page.locator('.chat-back').click();
  await page.getByRole('link', { name: 'Novo grupo' }).click();
  await expect(page.locator('.pick-list li').first()).toBeVisible({ timeout: 1000 });
});
