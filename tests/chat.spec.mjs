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
  // Faz muita coisa (grupo, mensagens, apagar, anexo, ícone): mais tempo que o normal.
  test.slow();
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
  // A conversa se redesenha quando o banco confirma o envio: se o arrasto pegar a versão
  // antiga da mensagem, tenta de novo até ela sumir.
  const drag = async (loc) => {
    await expect(async () => {
      await expect(loc).toBeVisible({ timeout: 2000 });
      const b = await loc.boundingBox();
      if (!b) throw new Error('mensagem ainda sem lugar na tela');
      await page.mouse.move(b.x + b.width - 10, b.y + b.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + b.width - 10 - i * b.width * 0.08, b.y + b.height / 2);
      await page.mouse.up();
      await expect(loc).toBeHidden({ timeout: 2000 });
    }).toPass({ timeout: 15000 });
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

  // Manter o dedo pressionado na própria mensagem: menu com Copiar texto e Apagar (com Desfazer).
  await expect(page.getByText('Arraste uma mensagem para a direita para responder; mantenha o dedo pressionado para reagir, copiar ou apagar.')).toBeVisible();
  await box.fill('Apagar pressionando');
  await page.getByRole('button', { name: 'Enviar' }).click();
  const pressed = page.locator('.msg-swipe').filter({ hasText: 'Apagar pressionando' });
  await expect(pressed).toBeVisible();
  await pressed.locator('.msg-text').click({ delay: 700 });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Copiar texto' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Apagar' }).click();
  await expect(page.getByText('Mensagem apagada.')).toBeVisible();
  await expect(pressed).toBeHidden();
  // Toque rápido não abre o menu.
  await page.locator('.msg.mine .msg-text').filter({ hasText: 'Bom dia, turma' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);

  // Reagir pelo menu (linha de emojis no alto); tocar na reação mostra quem reagiu e dali tira.
  const hello = page.locator('.msg').filter({ hasText: 'Bom dia, turma' });
  await hello.locator('.msg-text').click({ delay: 700, position: { x: 4, y: 6 } }); // no começo (o meio tem um link)
  await Promise.all([
    page.waitForResponse((r) => r.url().includes('rpc/chat_set_reaction') && r.ok()),
    page.getByRole('button', { name: 'Reagir com 🎉' }).click(),
  ]);
  const chip = hello.locator('.msg-reactions .reaction.mine');
  await expect(chip).toHaveText('🎉1');
  // Ficou gravado: recarregando, continua.
  await page.reload();
  await expect(chip).toHaveText('🎉1');
  await chip.click();
  const who = page.getByRole('dialog');
  await expect(who.getByRole('heading', { name: 'Reações · 1 pessoa' })).toBeVisible();
  await expect(who.locator('.who-list li')).toContainText('Você');
  await who.getByRole('button', { name: 'Tirar minha reação 🎉' }).click();
  await expect(hello.locator('.msg-reactions')).toHaveCount(0);

  // Arrastar para a direita: responde (faixa "Respondendo a…" com ✕ para cancelar).
  const dragRight = async (loc) => {
    await expect(async () => {
      const b = await loc.boundingBox();
      if (!b) throw new Error('mensagem ainda sem lugar na tela');
      const y = b.y + 10; // na primeira linha (a segunda é um link, que não arrasta)
      await page.mouse.move(b.x + 12, y);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + 12 + i * 9, y);
      await page.mouse.up();
      await expect(page.locator('#chat-reply')).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 15000 });
  };
  await dragRight(hello.locator('.msg-text'));
  const replyBar = page.locator('#chat-reply');
  await expect(replyBar).toContainText('Respondendo a você');
  await expect(replyBar).toContainText('Bom dia, turma');
  await page.getByRole('button', { name: 'Cancelar a resposta' }).click();
  await expect(replyBar).toBeHidden();
  await dragRight(hello.locator('.msg-text'));
  await box.fill('Respondendo pelo arrasto');
  await page.getByRole('button', { name: 'Enviar' }).click();
  await expect(replyBar).toBeHidden();
  const answered = page.locator('.msg').filter({ hasText: 'Respondendo pelo arrasto' });
  await expect(answered.locator('.msg-quote')).toContainText('Bom dia, turma');
  // Também pelo menu: Responder.
  await answered.locator('.msg-text').click({ delay: 700 });
  await page.getByRole('menuitem', { name: 'Responder' }).click();
  await expect(replyBar).toContainText('Respondendo pelo arrasto');
  await page.getByRole('button', { name: 'Cancelar a resposta' }).click();

  // Anexo (documento): aparece como arquivo para abrir.
  await page.locator('#chat-file').setInputFiles({ name: 'lista.txt', mimeType: 'text/plain', buffer: Buffer.from('Material da semana') });
  await expect(page.locator('.msg.mine').last().locator('.msg-doc')).toContainText('lista.txt');
  await expect(page.locator('.msg.mine').last().locator('a.msg-doc')).toBeVisible({ timeout: 15000 });

  // O administrador troca o ícone do grupo: aparece nos dados do grupo, na conversa e na lista.
  const shot = await page.screenshot();
  await page.locator('.chat-title').click();
  // Tocar na própria foto escolhe o ícone (lápis no canto); não há botão para tirar.
  const pick = page.locator('.chat-info-head label.icon-pick');
  await expect(pick.locator('.icon-pick-badge')).toBeVisible();
  await expect(page.getByRole('button', { name: /Tirar o ícone/ })).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser');
  await pick.click();
  await (await chooser).setFiles({ name: 'icone.png', mimeType: 'image/png', buffer: shot });
  await expect(page.getByText('Ícone do grupo trocado.')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.chat-info-head .avatar img')).toBeVisible();
  await expect(page.getByLabel('Trocar o ícone do grupo')).toHaveCount(1);
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
  // (o destaque dura pouco e a conversa pode se redesenhar: confere que o vídeo ficou à vista)
  await expect(page.locator('.msg', { has: page.locator('video.msg-video') }).last()).toBeInViewport();
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
  await expect(page.locator('.msg-text').filter({ hasText: 'Bom dia, turma' })).toBeVisible();
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

  // O membro sai do grupo pelos dados do grupo (e não troca o ícone).
  await page.locator('.chat-title').click();
  await expect(page.locator('.chat-info-head .avatar')).toBeVisible();
  await expect(page.locator('.icon-pick')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sair do grupo' }).click();
  await answer(page);
  await expect(page).toHaveURL(/#\/chat$/);
  await expect(page.locator(`a.chat-row[href="#/chat/${g.id}"]`)).toHaveCount(0);
});

test('as fotos do chat ficam guardadas no aparelho (aparecem na hora da próxima vez)', async ({ browser }) => {
  const g = await group();
  // Este teste liga o service worker (os outros rodam sem ele).
  const ctx = await browser.newContext({ ...test.info().project.use, baseURL: 'http://localhost:4173/', serviceWorkers: 'allow' });
  const page = await ctx.newPage();
  await openLoggedIn(page, as['lider-a'].session, `/i/teste-a/#/chat/${g.id}`);
  await page.evaluate(() => navigator.serviceWorker.ready);
  if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  // O ícone do grupo (foto da pasta privada do chat) aparece e fica guardado pelo caminho do arquivo.
  const img = page.locator('#chat-icon .avatar img');
  await expect(img).toBeVisible({ timeout: 15000 });
  const saved = () =>
    page.evaluate(async () => (await (await caches.open('cc4-fotos')).keys()).map((r) => r.url));
  await expect.poll(saved, { timeout: 15000 }).toEqual(expect.arrayContaining([expect.stringMatching(/\/storage\/v1\/object\/sign\/chat\/.+\.webp$/)]));
  // Sem o token: o mesmo arquivo com um link novo vem do aparelho.
  expect((await saved()).every((u) => !u.includes('token='))).toBe(true);
  await ctx.close();
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
