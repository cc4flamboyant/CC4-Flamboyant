// Separação entre igrejas, testada com contas de verdade nas igrejas Teste A e Teste B.
// Cada tentativa de ler ou mexer na outra igreja (ou de passar do próprio papel) precisa falhar.
// Contas: supabase/002_igrejas_de_teste.sql + supabase/usuarios-de-teste.local.sql.
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, ANON_KEY, rest, configured, testPassword, loginAs, testEmail, assertCleanTestChurches } from './helpers.mjs';

test.describe.configure({ mode: 'serial' });

let api;
const as = {}; // contas logadas: { id, headers }
const church = {}; // 'a' e 'b': id das igrejas de teste
const returning = (h) => ({ ...h, Prefer: 'return=representation' });

const get = async (who, path) => {
  const res = await api.get(rest(path), { headers: as[who].headers });
  expect(res.ok(), `${who} GET ${path}: ${await res.text()}`).toBe(true);
  return res.json();
};
const rpc = (who, fn, data = {}) => api.post(rest(`rpc/${fn}`), { headers: as[who].headers, data });
// Cada pasta recebe um formato que ela aceita: assim uma recusa só pode ser por falta de permissão.
const FORMAT = { igrejas: 'image/png', membros: 'image/webp' };
const upload = (who, bucket, path) =>
  api.post(`${SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    headers: { ...as[who].headers, 'Content-Type': FORMAT[bucket] },
    data: Buffer.from('89504e470d0a1a0a', 'hex'),
  });
async function expectDenied(res, label) {
  const body = await res.text();
  expect(res.ok(), `${label}: ${body}`).toBe(false);
  expect(body, label).not.toMatch(/mime|too large|payload/i);
}
const removeFile = (who, bucket, path) =>
  api.delete(`${SUPABASE_URL}/storage/v1/object/${bucket}`, { headers: as[who].headers, data: { prefixes: [path] } });

test.beforeAll(async ({ playwright }) => {
  test.skip(!configured, 'Falta a chave pública em js/config.js');
  if (!testPassword()) {
    // No GitHub os testes não podem pular em silêncio.
    if (process.env.CI) throw new Error('Falta o segredo TEST_USERS_PASSWORD no GitHub.');
    test.skip(true, 'Sem senha das contas de teste: rode node scripts/criar-usuarios-de-teste.mjs');
  }
  api = await playwright.request.newContext();
  for (const u of ['adm-a', 'lider-a', 'membro-a', 'adm-b', 'sem-igreja']) as[u] = await loginAs(api, u);
  await assertCleanTestChurches(api, as);
  const rows = await (await api.get(rest('churches?select=id,slug&slug=in.(teste-a,teste-b)'), { headers: as['adm-a'].headers })).json();
  church.a = rows.find((r) => r.slug === 'teste-a').id;
  church.b = rows.find((r) => r.slug === 'teste-b').id;
  // A conta sem-igreja entra na Teste A só durante alguns testes. Se uma rodada parou no meio
  // (banco fora do ar, rodada cancelada), ela ficou lá: tira antes de começar.
  for (const who of ['adm-a', 'adm-b'])
    await api.delete(rest(`members?email=eq.${encodeURIComponent(testEmail('sem-igreja'))}`), { headers: as[who].headers });
});

test.afterAll(async () => {
  await api?.dispose();
});

test.describe('Leitura de membros', () => {
  test('a liderança vê só os membros da própria igreja', async () => {
    for (const who of ['adm-a', 'lider-a']) {
      const rows = await get(who, 'members?select=name,church_id');
      expect(rows.length, who).toBeGreaterThan(0);
      expect(rows.every((r) => r.church_id === church.a), who).toBe(true);
      expect(rows.map((r) => r.name)).toContain('Fulano da A');
      expect(rows.map((r) => r.name)).not.toContain('Fulano da B');
    }
    const b = await get('adm-b', 'members?select=name,church_id');
    expect(b.every((r) => r.church_id === church.b)).toBe(true);
    expect(b.map((r) => r.name)).not.toContain('Fulano da A');
  });

  test('pedir os membros da outra igreja pelo id não traz nada', async () => {
    expect(await get('adm-a', `members?select=*&church_id=eq.${church.b}`)).toEqual([]);
    const embedded = await get('adm-a', `churches?select=slug,members(name)&id=eq.${church.b}`);
    expect(embedded[0].members).toEqual([]);
  });

  test('o membro comum vê só o próprio cadastro (telefones e aniversários dos outros, não)', async () => {
    const rows = await get('membro-a', 'members?select=name,user_id');
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(as['membro-a'].id);
  });

  test('quem não é de nenhuma igreja não vê ninguém', async () => {
    expect(await get('sem-igreja', 'members?select=*')).toEqual([]);
    expect(await (await rpc('sem-igreja', 'my_church_ids')).json()).toEqual([]);
    expect(await (await rpc('sem-igreja', 'link_my_account')).json()).toBe(0);
  });
});

test.describe('Alterações na outra igreja', () => {
  test('o admin da A não altera membros nem a configuração da B', async () => {
    const h = returning(as['adm-a'].headers);
    const members = await api.patch(rest(`members?church_id=eq.${church.b}`), { headers: h, data: { name: 'Invadido' } });
    if (members.ok()) expect(await members.json()).toEqual([]);
    const conf = await api.patch(rest(`churches?id=eq.${church.b}`), { headers: h, data: { welcome_text: 'Invadido' } });
    if (conf.ok()) expect(await conf.json()).toEqual([]);
    const removed = await api.delete(rest(`members?church_id=eq.${church.b}`), { headers: h });
    if (removed.ok()) expect(await removed.json()).toEqual([]);
    const still = await get('adm-b', 'members?select=name&name=eq.Fulano da B');
    expect(still).toHaveLength(1);
  });

  test('o admin da A não cadastra ninguém na B', async () => {
    const res = await api.post(rest('members'), { headers: as['adm-a'].headers, data: { church_id: church.b, name: 'Intruso' } });
    expect(res.ok()).toBe(false);
  });

  test('ninguém leva um membro da sua igreja para a outra', async () => {
    const [fulano] = await get('adm-a', 'members?select=id&name=eq.Fulano da A');
    const res = await api.patch(rest(`members?id=eq.${fulano.id}`), { headers: as['adm-a'].headers, data: { church_id: church.b } });
    expect(res.ok()).toBe(false);
  });

  test('o admin da A edita a própria igreja', async () => {
    const [mine] = await get('adm-a', `churches?select=welcome_text&id=eq.${church.a}`);
    const res = await api.patch(rest(`churches?id=eq.${church.a}`), { headers: returning(as['adm-a'].headers), data: { welcome_text: mine.welcome_text } });
    expect(res.ok()).toBe(true);
    expect(await res.json()).toHaveLength(1);
  });

  test('ninguém troca o endereço, o limite de membros nem a marca de teste da igreja', async () => {
    for (const data of [{ slug: 'outra' }, { max_members: 999999 }, { is_test: false }, { active: false }]) {
      const res = await api.patch(rest(`churches?id=eq.${church.a}`), { headers: as['adm-a'].headers, data });
      expect(res.ok(), JSON.stringify(data)).toBe(false);
    }
  });
});

test.describe('Papéis dentro da igreja', () => {
  test('o membro não muda o próprio papel nem o e-mail, mas edita os próprios dados', async () => {
    const id = as['membro-a'].id;
    const role = await api.patch(rest(`members?user_id=eq.${id}`), { headers: as['membro-a'].headers, data: { role: 'admin' } });
    expect(role.ok()).toBe(false);
    const email = await api.patch(rest(`members?user_id=eq.${id}`), { headers: as['membro-a'].headers, data: { email: 'outro@exemplo.com' } });
    expect(email.ok()).toBe(false);
    const own = await api.patch(rest(`members?user_id=eq.${id}`), { headers: returning(as['membro-a'].headers), data: { show_phone: false } });
    expect(own.ok()).toBe(true);
    expect(await own.json()).toHaveLength(1);
  });

  test('o membro não cadastra ninguém', async () => {
    const res = await api.post(rest('members'), { headers: as['membro-a'].headers, data: { church_id: church.a, name: 'Novo' } });
    expect(res.ok()).toBe(false);
  });

  test('o líder cadastra membros, mas não dá papéis, não liga contas e não apaga', async () => {
    const lider = as['lider-a'].headers;
    const admin = await api.post(rest('members'), { headers: lider, data: { church_id: church.a, name: 'Quer ser admin', role: 'admin' } });
    expect(admin.ok()).toBe(false);
    const linked = await api.post(rest('members'), { headers: lider, data: { church_id: church.a, name: 'Conta alheia', user_id: as['adm-b'].id } });
    expect(linked.ok()).toBe(false);

    const created = await api.post(rest('members'), { headers: returning(lider), data: { church_id: church.a, name: 'Teste temporário' } });
    expect(created.ok(), await created.text()).toBe(true);
    const [row] = await created.json();
    try {
      const del = await api.delete(rest(`members?id=eq.${row.id}`), { headers: returning(lider) });
      if (del.ok()) expect(await del.json()).toEqual([]);
    } finally {
      const cleanup = await api.delete(rest(`members?id=eq.${row.id}`), { headers: returning(as['adm-a'].headers) });
      expect(await cleanup.json()).toHaveLength(1);
    }
  });

  test('o líder não muda o papel de ninguém', async () => {
    const res = await api.patch(rest(`members?user_id=eq.${as['membro-a'].id}`), { headers: as['lider-a'].headers, data: { role: 'lider' } });
    expect(res.ok()).toBe(false);
  });

  test('o último administrador não deixa de ser administrador', async () => {
    const res = await api.patch(rest(`members?user_id=eq.${as['adm-a'].id}`), { headers: as['adm-a'].headers, data: { role: 'membro' } });
    expect(res.ok()).toBe(false);
  });

  test('a liderança não configura a igreja (só o admin)', async () => {
    const res = await api.patch(rest(`churches?id=eq.${church.a}`), { headers: returning(as['lider-a'].headers), data: { welcome_text: 'Líder mudou' } });
    if (res.ok()) expect(await res.json()).toEqual([]);
  });
});

test.describe('Administração da plataforma', () => {
  test('admin de igreja não é admin da plataforma', async () => {
    expect(await (await rpc('adm-a', 'is_platform_admin')).json()).toBe(false);
    expect((await api.get(rest('platform_admins?select=*'), { headers: as['adm-a'].headers })).ok()).toBe(false);
    expect((await rpc('adm-a', 'create_church', { p_slug: 'invasora', p_name: 'Invasora', p_admin_email: 'a@b.com' })).ok()).toBe(false);
    expect((await rpc('adm-a', 'set_church_admin', { p_church: church.b, p_email: 'adm-a@teste.igrejaconecta.invalid' })).ok()).toBe(false);
    expect((await rpc('adm-a', 'set_church_active', { p_church: church.b, p_active: false })).ok()).toBe(false);
  });

  test('responder ao convite de outra igreja não dá acesso a ela', async () => {
    await rpc('adm-a', 'respond_to_church', { p_church: church.b, p_accept: true });
    expect(await (await rpc('adm-a', 'my_church_ids')).json()).toEqual([church.a]);
  });
});

test.describe('Arquivos por igreja', () => {
  test('o admin grava na pasta pública da própria igreja e não na da outra', async () => {
    const mine = `${church.a}/testes/isolamento.png`;
    const ok = await upload('adm-a', 'igrejas', mine);
    expect(ok.ok(), await ok.text()).toBe(true);
    await removeFile('adm-a', 'igrejas', mine);
    await expectDenied(await upload('adm-a', 'igrejas', `${church.b}/testes/isolamento.png`), 'adm-a na pasta da B');
  });

  test('líder e membro não gravam na pasta pública da igreja', async () => {
    for (const who of ['lider-a', 'membro-a']) {
      await expectDenied(await upload(who, 'igrejas', `${church.a}/testes/${who}.png`), who);
    }
  });

  test('fotos dos membros: a liderança grava na própria igreja; o membro e a outra igreja, não', async () => {
    const path = `${church.a}/testes/isolamento.webp`;
    const ok = await upload('lider-a', 'membros', path);
    expect(ok.ok(), await ok.text()).toBe(true);
    try {
      // A outra igreja não baixa a foto, e quem não é da igreja também não.
      for (const who of ['adm-b', 'sem-igreja']) {
        const res = await api.get(`${SUPABASE_URL}/storage/v1/object/authenticated/membros/${path}`, { headers: as[who].headers });
        expect(res.ok(), who).toBe(false);
      }
      const member = await api.get(`${SUPABASE_URL}/storage/v1/object/authenticated/membros/${path}`, { headers: as['membro-a'].headers });
      expect(member.ok()).toBe(true);
    } finally {
      await removeFile('lider-a', 'membros', path);
    }
    await expectDenied(await upload('membro-a', 'membros', `${church.a}/testes/membro.webp`), 'membro-a');
    await expectDenied(await upload('lider-a', 'membros', `${church.b}/testes/isolamento.webp`), 'lider-a na pasta da B');
  });
});

test.describe('Cadastro de membros (003)', () => {
  const memberOf = async (who) => (await get(who, `members?select=id,church_id,email&user_id=eq.${as[who].id}`))[0];

  test('o membro envia a própria foto, mas não na pasta de outro membro', async () => {
    const me = await memberOf('membro-a');
    const mine = `${church.a}/${me.id}/foto.webp`;
    const ok = await upload('membro-a', 'membros', mine);
    expect(ok.ok(), await ok.text()).toBe(true);
    await removeFile('membro-a', 'membros', mine);
    const [fulano] = await get('adm-a', 'members?select=id&name=eq.Fulano da A');
    await expectDenied(await upload('membro-a', 'membros', `${church.a}/${fulano.id}/foto.webp`), 'pasta do Fulano');
    await expectDenied(await upload('membro-a', 'membros', `${church.b}/${me.id}/foto.webp`), 'pasta na B');
  });

  test('a foto do cadastro precisa estar na pasta do próprio membro', async () => {
    const me = await memberOf('membro-a');
    const [fulano] = await get('adm-a', 'members?select=id&name=eq.Fulano da A');
    const res = await api.patch(rest(`members?id=eq.${me.id}`), {
      headers: as['membro-a'].headers,
      data: { photo_path: `${church.a}/${fulano.id}/foto.webp` },
    });
    expect(res.ok()).toBe(false);
  });

  test('o e-mail de quem já entrou no app não muda sem desligar a conta', async () => {
    const me = await memberOf('membro-a');
    const res = await api.patch(rest(`members?id=eq.${me.id}`), { headers: as['adm-a'].headers, data: { email: 'novo@teste.igrejaconecta.invalid' } });
    expect(res.ok()).toBe(false);
  });

  test('só o administrador da própria igreja desliga uma conta, e a pessoa volta ao aceitar de novo', async () => {
    // Usa a conta "sem-igreja" num cadastro temporário: desligar o "membro-a" derrubaria os
    // testes de tela que rodam ao mesmo tempo com ele.
    const created = await api.post(rest('members'), {
      headers: returning(as['lider-a'].headers),
      data: { church_id: church.a, name: 'Temporário do desligar', email: 'sem-igreja@teste.igrejaconecta.invalid' },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const [me] = await created.json();
    try {
      expect(await (await rpc('sem-igreja', 'link_my_account')).json()).toBe(1);
      expect((await rpc('sem-igreja', 'respond_to_church', { p_church: church.a, p_accept: true })).ok()).toBe(true);
      for (const who of ['lider-a', 'adm-b', 'sem-igreja']) {
        expect((await rpc(who, 'unlink_member_account', { p_member: me.id })).ok(), who).toBe(false);
      }
      expect((await rpc('adm-a', 'unlink_member_account', { p_member: me.id })).ok()).toBe(true);
      expect(await (await rpc('sem-igreja', 'my_church_ids')).json()).toEqual([]);
      // Entrar de novo liga a conta; aceitar o convite devolve o acesso.
      expect(await (await rpc('sem-igreja', 'link_my_account')).json()).toBe(1);
      expect((await rpc('sem-igreja', 'respond_to_church', { p_church: church.a, p_accept: true })).ok()).toBe(true);
      expect(await (await rpc('sem-igreja', 'my_church_ids')).json()).toEqual([church.a]);
    } finally {
      await api.delete(rest(`members?id=eq.${me.id}`), { headers: as['adm-a'].headers });
    }
  });

  test('o último administrador não é desligado', async () => {
    const me = await memberOf('adm-a');
    expect((await rpc('adm-a', 'unlink_member_account', { p_member: me.id })).ok()).toBe(false);
  });
});

test.describe('Aniversários (004)', () => {
  const between = async (who, churchKey, from, to) => {
    const res = await rpc(who, 'birthdays_between', { p_church: church[churchKey], p_from: from, p_to: to });
    expect(res.ok(), `${who}: ${await res.text()}`).toBe(true);
    return res.json();
  };

  test('a liderança vê todos os aniversariantes, com a idade', async () => {
    const rows = await between('lider-a', 'a', '2027-03-15', '2027-03-15');
    expect(rows).toEqual([expect.objectContaining({ name: 'Fulano da A', on_date: '2027-03-15', age: 47 })]);
  });

  test('o membro vê só quem autorizou, e sem a idade', async () => {
    expect(await between('membro-a', 'a', '2027-03-15', '2027-03-15')).toEqual([]);
    const rows = await between('membro-a', 'a', '2027-02-01', '2027-02-28');
    expect(rows).toEqual([expect.objectContaining({ name: 'Bissexto da A', on_date: '2027-02-28', age: null })]);
  });

  test('quem nasceu em 29/02 faz aniversário em 28/02 nos anos que não são bissextos', async () => {
    const days = async (from, to) =>
      (await between('lider-a', 'a', from, to)).filter((r) => r.name === 'Bissexto da A').map((r) => r.on_date);
    expect(await days('2027-02-27', '2027-03-01')).toEqual(['2027-02-28']);
    expect(await days('2028-02-27', '2028-03-01')).toEqual(['2028-02-29']);
  });

  test('outra igreja e quem não é de nenhuma não veem os aniversariantes', async () => {
    expect(await between('adm-b', 'a', '2027-03-01', '2027-03-31')).toEqual([]);
    expect(await between('sem-igreja', 'a', '2027-03-01', '2027-03-31')).toEqual([]);
  });

  test('período longo demais é recusado', async () => {
    const res = await rpc('lider-a', 'birthdays_between', { p_church: church.a, p_from: '2027-01-01', p_to: '2027-12-31' });
    expect(res.ok()).toBe(false);
  });

  test('a mensagem de aniversário: só o admin da igreja edita; a outra igreja nem lê', async () => {
    const mine = await get('adm-a', `message_templates?select=kind,title&church_id=eq.${church.a}`);
    expect(mine.map((r) => r.kind).sort()).toEqual(['aniversario', 'batismo', 'casamento', 'resumo_lideres']);
    expect(await get('adm-b', `message_templates?select=kind&church_id=eq.${church.a}`)).toEqual([]);
    expect(await get('membro-a', `message_templates?select=kind&church_id=eq.${church.a}`)).toEqual([]);
    for (const who of ['adm-b', 'lider-a']) {
      const res = await api.patch(rest(`message_templates?church_id=eq.${church.a}`), { headers: returning(as[who].headers), data: { title: 'Invadido' } });
      if (res.ok()) expect(await res.json(), who).toEqual([]);
    }
    const title = mine.find((r) => r.kind === 'aniversario').title;
    const own = await api.patch(rest(`message_templates?church_id=eq.${church.a}&kind=eq.aniversario`), {
      headers: returning(as['adm-a'].headers),
      data: { title },
    });
    expect(await own.json()).toHaveLength(1);
  });

  test('cada pessoa vê só os próprios aparelhos; o registro de envios não é aberto aos membros', async () => {
    // Endereço com a cara do serviço de push do Chrome (nunca recebe nada: o envio pula as igrejas de teste).
    const endpoint = `https://fcm.googleapis.com/fcm/send/teste-igreja-conecta-${Date.now()}`;
    const saved = await rpc('membro-a', 'save_push_subscription', { p_endpoint: endpoint, p_p256dh: 'chave', p_auth: 'auth' });
    expect(saved.ok(), await saved.text()).toBe(true);
    // Endereço que não é de um serviço de push: recusado (012).
    const other = await rpc('membro-a', 'save_push_subscription', { p_endpoint: 'https://atacante.invalid/x', p_p256dh: 'a', p_auth: 'b' });
    expect(other.ok()).toBe(false);
    const q = `push_subscriptions?select=endpoint&endpoint=eq.${encodeURIComponent(endpoint)}`;
    try {
      expect(await get('membro-a', q)).toHaveLength(1);
      expect(await get('adm-a', q)).toEqual([]);
    } finally {
      await api.delete(rest(`push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`), { headers: as['membro-a'].headers });
    }
    expect(await get('membro-a', 'message_log?select=id')).toEqual([]);
  });

  test('as funções de envio não respondem sem a senha, nem para quem está logado', async () => {
    for (const fn of ['claim_birthday_push', 'claim_birthday_email', 'claim_leader_summaries', 'platform_push_targets', 'birthday_email_backlog', 'clean_message_log']) {
      expect((await rpc('adm-a', fn, { p_secret: 'errada' })).ok(), fn).toBe(false);
    }
  });
});

test.describe('Agenda, avisos e central de notificações (005)', () => {
  const tag = `teste-${Date.now()}`;

  test('agenda: a liderança cria um culto semanal; os membros veem as repetições; a outra igreja, nada', async () => {
    const start = new Date('2027-03-07T22:00:00Z'); // domingo, 19h em Brasília
    const created = await api.post(rest('events'), {
      headers: returning(as['lider-a'].headers),
      data: {
        church_id: church.a,
        title: `Culto ${tag}`,
        starts_at: start.toISOString(),
        ends_at: new Date(start.getTime() + 2 * 3600e3).toISOString(),
        repeat_weekly: true,
        repeat_until: '2027-03-28',
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const [ev] = await created.json();
    try {
      const range = { p_church: church.a, p_from: '2027-03-01T00:00:00Z', p_to: '2027-04-30T00:00:00Z' };
      const occ = (await (await rpc('membro-a', 'events_between', range)).json()).filter((o) => o.event_id === ev.id);
      expect(occ.map((o) => o.starts_at.slice(0, 10))).toEqual(['2027-03-07', '2027-03-14', '2027-03-21', '2027-03-28']);

      expect(await (await rpc('adm-b', 'events_between', range)).json()).toEqual([]);
      expect(await get('adm-b', `events?select=id&id=eq.${ev.id}`)).toEqual([]);
      const h = returning(as['adm-b'].headers);
      const changed = await api.patch(rest(`events?id=eq.${ev.id}`), { headers: h, data: { title: 'Invadido' } });
      if (changed.ok()) expect(await changed.json()).toEqual([]);
      const removed = await api.delete(rest(`events?id=eq.${ev.id}`), { headers: h });
      if (removed.ok()) expect(await removed.json()).toEqual([]);

      // O líder da A não leva o evento para a B; o membro não cria eventos.
      const moved = await api.patch(rest(`events?id=eq.${ev.id}`), { headers: as['lider-a'].headers, data: { church_id: church.b } });
      expect(moved.ok()).toBe(false);
      const byMember = await api.post(rest('events'), {
        headers: as['membro-a'].headers,
        data: { church_id: church.a, title: 'Do membro', starts_at: start.toISOString() },
      });
      expect(byMember.ok()).toBe(false);
    } finally {
      const del = await api.delete(rest(`events?id=eq.${ev.id}`), { headers: returning(as['lider-a'].headers) });
      expect(await del.json()).toHaveLength(1);
    }
  });

  test('avisos: vencido some para os membros (a liderança vê); a notificação não é ligada depois', async () => {
    const created = await api.post(rest('announcements'), {
      headers: returning(as['lider-a'].headers),
      data: { church_id: church.a, title: `Aviso ${tag}`, body: 'Texto', visible_until: '2020-01-01', pushed_at: '2020-01-01T00:00:00Z' },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const [a] = await created.json();
    try {
      expect(a.pushed_at).toBe(null);
      expect(await get('membro-a', `announcements?select=id&id=eq.${a.id}`)).toEqual([]);
      expect(await get('lider-a', `announcements?select=id&id=eq.${a.id}`)).toHaveLength(1);
      expect(await get('adm-b', `announcements?select=id&id=eq.${a.id}`)).toEqual([]);
      const push = await api.patch(rest(`announcements?id=eq.${a.id}`), { headers: as['lider-a'].headers, data: { push: true } });
      expect(push.ok()).toBe(false);
      const byMember = await api.post(rest('announcements'), { headers: as['membro-a'].headers, data: { church_id: church.a, title: 'Do membro', body: 'x' } });
      expect(byMember.ok()).toBe(false);
    } finally {
      const del = await api.delete(rest(`announcements?id=eq.${a.id}`), { headers: returning(as['lider-a'].headers) });
      expect(await del.json()).toHaveLength(1);
    }
  });

  test('notificações: ninguém cria pelo app, e cada um só lê as próprias', async () => {
    const res = await api.post(rest('notifications'), {
      headers: as['adm-a'].headers,
      data: { user_id: as['membro-a'].id, church_id: church.a, kind: 'sistema', title: 'Falsa', dedupe_key: tag },
    });
    expect(res.ok()).toBe(false);
    const rows = await get('membro-a', 'notifications?select=user_id');
    expect(rows.every((r) => r.user_id === as['membro-a'].id)).toBe(true);
  });

  test('as funções de envio dos lembretes e avisos não respondem sem a senha', async () => {
    for (const fn of ['claim_event_reminders', 'claim_announcement_push', 'deliver_birthday_notifications', 'clean_notifications']) {
      expect((await rpc('adm-a', fn, { p_secret: 'errada' })).ok(), fn).toBe(false);
    }
  });

  test('aniversário dos filhos (025): o envio só com a senha; a lista e o registro ficam fechados', async () => {
    // Recusa pela senha (não por não existir: 404 seria o 025 faltando no banco).
    for (const [fn, extra] of [['deliver_child_birthday_notifications', {}], ['claim_child_birthday_push', {}], ['mark_child_birthday_failed', { p_log_id: 1 }]]) {
      const res = await rpc('adm-a', fn, { p_secret: 'errada', ...extra });
      expect(res.ok(), fn).toBe(false);
      expect(res.status(), fn).not.toBe(404);
    }
    expect((await rpc('adm-a', 'child_birthday_candidates', { p_day: '2026-01-01' })).ok()).toBe(false);
    expect((await api.get(rest('child_birthday_log?select=id'), { headers: as['adm-a'].headers })).ok()).toBe(false);
  });
});

test.describe('Os próprios dados: exportar, sair e excluir (006)', () => {
  test('o arquivo exportado traz só os dados da própria pessoa', async () => {
    const res = await rpc('membro-a', 'export_my_data');
    expect(res.ok(), await res.text()).toBe(true);
    const data = await res.json();
    expect(data.conta.email).toBe('membro-a@teste.igrejaconecta.invalid');
    expect(data.igrejas).toHaveLength(1);
    expect(data.igrejas[0]).toMatchObject({ igreja: 'Igreja Teste A', papel: 'membro', cadastro: { nome: 'Membro da A' } });
    // Nada dos outros (as conversas do chat, se um dia existirem, trazem só quem conversou com a pessoa).
    const { conversas_do_chat: chats = [], ...rest } = data; // o CC4 não tem chat
    const text = JSON.stringify(rest);
    for (const other of ['Fulano', 'Bissexto', 'Casada', 'Batizado', 'Admin da A', 'Teste B', '5561999990001']) expect(text, other).not.toContain(other);
    for (const c of chats) expect(c.mensagens.every((m) => ['você', c.com].includes(m.de))).toBe(true);
    expect(data.igrejas[0].cadastro).toHaveProperty('casamento');
    expect(data.igrejas[0].cadastro).toHaveProperty('mostra_batismo_aos_membros');
  });

  test('o único administrador não sai da igreja nem exclui a conta', async () => {
    expect((await rpc('adm-a', 'leave_church', { p_church: church.a })).ok()).toBe(false);
    const del = await rpc('adm-a', 'delete_my_account');
    expect(del.ok()).toBe(false);
    expect(await del.text()).toContain('único administrador');
    expect(await (await rpc('adm-a', 'my_church_ids')).json()).toEqual([church.a]);
  });

  test('quem sai de uma igreja perde o acesso e o cadastro dela é apagado', async () => {
    const email = 'sem-igreja@teste.igrejaconecta.invalid';
    const created = await api.post(rest('members'), {
      headers: returning(as['lider-a'].headers),
      data: { church_id: church.a, name: 'Temporário da saída', email },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const [row] = await created.json();
    try {
      expect(await (await rpc('sem-igreja', 'link_my_account')).json()).toBe(1);
      expect((await rpc('sem-igreja', 'respond_to_church', { p_church: church.a, p_accept: true })).ok()).toBe(true);
      expect(await (await rpc('sem-igreja', 'my_church_ids')).json()).toEqual([church.a]);
      // Sair de outra igreja não mexe em nada; sair da A apaga o cadastro.
      expect((await rpc('sem-igreja', 'leave_church', { p_church: church.b })).ok()).toBe(true);
      expect(await get('lider-a', `members?select=id&id=eq.${row.id}`)).toHaveLength(1);
      expect((await rpc('sem-igreja', 'leave_church', { p_church: church.a })).ok()).toBe(true);
      expect(await (await rpc('sem-igreja', 'my_church_ids')).json()).toEqual([]);
      expect(await get('lider-a', `members?select=id&id=eq.${row.id}`)).toEqual([]);
    } finally {
      await api.delete(rest(`members?id=eq.${row.id}`), { headers: as['adm-a'].headers });
    }
  });
});

test.describe('Reforços de segurança (012)', () => {
  test('o admin não grava link "javascript:" nas redes sociais nem logo fora do https, nem pela API', async () => {
    const [before] = await get('adm-a', `churches?select=social,logo_url&id=eq.${church.a}`);
    const patch = (data) => api.patch(rest(`churches?id=eq.${church.a}`), { headers: returning(as['adm-a'].headers), data });
    try {
      for (const bad of ['javascript:alert(document.cookie)', 'JaVaScRiPt:alert(1)', 'http://site.com', 'https://x.com/"><img src=x>', 'data:text/html,oi']) {
        expect((await patch({ social: { site: bad } })).ok(), bad).toBe(false);
      }
      expect((await patch({ logo_url: 'javascript:alert(1)' })).ok()).toBe(false);
      const ok = await patch({ social: { instagram: 'https://instagram.com/igreja_teste' } });
      expect(ok.ok(), await ok.text()).toBe(true);
    } finally {
      await patch({ social: before.social, logo_url: before.logo_url });
    }
  });
});

test.describe('Carteirinha digital (018)', () => {
  const anon = { apikey: ANON_KEY, 'Content-Type': 'application/json' };
  const verify = async (token) => {
    const res = await api.post(rest('rpc/verify_member_card'), { headers: anon, data: { p_token: token } });
    expect(res.ok(), await res.text()).toBe(true);
    return res.json();
  };
  const own = async (who) => (await get(who, `members?select=id,card_token,member_since&user_id=eq.${as[who].id}`))[0];

  test.afterAll(async () => {
    if (!api) return;
    const adm = await own('adm-a');
    await api.patch(rest(`members?id=eq.${adm.id}`), { headers: as['lider-a'].headers, data: { member_since: null } });
  });

  test('cada um lê só o próprio código; "membro desde" é da liderança; o código só muda pela função', async () => {
    const me = await own('membro-a');
    expect(me.card_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await get('membro-a', 'members?select=card_token')).toHaveLength(1); // só o próprio cadastro
    expect(await get('adm-b', `members?select=card_token&id=eq.${me.id}`)).toEqual([]);

    const patch = (who, data) => api.patch(rest(`members?id=eq.${me.id}`), { headers: returning(as[who].headers), data });
    expect((await patch('membro-a', { member_since: '2000-01-01' })).ok()).toBe(false);
    expect((await patch('membro-a', { card_token: '00000000-0000-4000-8000-000000000000' })).ok()).toBe(false);
    const adm = await own('adm-a');
    const ok = await api.patch(rest(`members?id=eq.${adm.id}`), { headers: returning(as['lider-a'].headers), data: { member_since: '2015-04-12' } });
    expect(ok.ok(), await ok.text()).toBe(true);
    expect((await own('adm-a')).member_since).toBe('2015-04-12');
    const data = await (await rpc('adm-a', 'export_my_data')).json();
    const here = data.igrejas.find((c) => c.endereco_no_app === '/i/teste-a/');
    expect(here.cadastro.membro_desde).toBe('2015-04-12');
  });

  test('a conferência pública só responde pelo código exato e mostra só o que está na carteirinha', async () => {
    const me = await own('adm-a');
    const [r] = await verify(me.card_token);
    // Só o que está na carteirinha: nada de e-mail, telefone, aniversário ou foto.
    expect(Object.keys(r).sort()).toEqual(['active', 'church_name', 'church_slug', 'logo_url', 'member_since', 'name', 'primary_color', 'role']);
    expect(r).toMatchObject({ church_slug: 'teste-a', name: 'Admin da A', role: 'admin', member_since: '2015-04-12', active: true });
    expect(await verify('00000000-0000-4000-8000-000000000000')).toEqual([]);
    // Quem não aceitou participar (sem conta no app) não aparece como ativo.
    const [fulano] = await get('lider-a', 'members?select=card_token&name=eq.Fulano%20da%20A');
    expect((await verify(fulano.card_token))[0].active).toBe(false);
  });

  test('gerar um QR novo invalida o anterior; a outra igreja não troca o código de ninguém', async () => {
    const before = (await own('adm-a')).card_token;
    expect((await rpc('adm-b', 'rotate_card_token', { p_church: church.a })).ok()).toBe(false);
    const res = await rpc('adm-a', 'rotate_card_token', { p_church: church.a });
    expect(res.ok(), await res.text()).toBe(true);
    const after = await res.json();
    expect(after).not.toBe(before);
    expect(await verify(before)).toEqual([]);
    expect((await verify(after))[0].active).toBe(true);
  });

  test('com a carteirinha desligada, nenhuma da igreja é reconhecida', async () => {
    const me = await own('adm-b');
    expect((await verify(me.card_token)).length).toBe(1);
    const [b] = await get('adm-b', `churches?select=features&id=eq.${church.b}`);
    const setFeatures = (features) => api.patch(rest(`churches?id=eq.${church.b}`), { headers: as['adm-b'].headers, data: { features } });
    expect((await setFeatures({ ...b.features, carteirinha: false })).ok()).toBe(true);
    try {
      expect(await verify(me.card_token)).toEqual([]);
      expect((await rpc('adm-b', 'rotate_card_token', { p_church: church.b })).ok()).toBe(false);
    } finally {
      await setFeatures(b.features);
    }
  });
});

test.describe('Galeria de fotos (020)', () => {
  const tag = `Galeria ${Date.now().toString(36)}`;
  const ids = {};
  const webp = (bytes) =>
    Buffer.concat([Buffer.from('52494646', 'hex'), Buffer.alloc(4), Buffer.from('57454250', 'hex'), Buffer.alloc(Math.max(0, bytes - 12))]);
  const put = (who, path, bytes = 2000) =>
    api.post(`${SUPABASE_URL}/storage/v1/object/galeria/${path}`, { headers: { ...as[who].headers, 'Content-Type': 'image/webp' }, data: webp(bytes) });
  const sign = (who, path) => api.post(`${SUPABASE_URL}/storage/v1/object/sign/galeria/${path}`, { headers: as[who].headers, data: { expiresIn: 60 } });
  const album = (who, church_id, title) => api.post(rest('gallery_albums'), { headers: returning(as[who].headers), data: { church_id, title } });

  test.afterAll(async () => {
    if (!api) return;
    for (const [who, c] of [['lider-a', church.a], ['adm-b', church.b]]) {
      const rows = await get(who, `gallery_photos?select=path,mini_path&church_id=eq.${c}&album_id=in.(${[ids.album, ids.other, ids.full].filter(Boolean).join(',') || '00000000-0000-0000-0000-000000000000'})`);
      const prefixes = rows.flatMap((p) => [p.path, p.mini_path]);
      for (let i = 0; i < prefixes.length; i += 100)
        await api.delete(`${SUPABASE_URL}/storage/v1/object/galeria`, { headers: as[who].headers, data: { prefixes: prefixes.slice(i, i + 100) } });
      await api.delete(rest(`gallery_albums?title=like.${encodeURIComponent(tag)}*`), { headers: as[who].headers });
    }
  });

  test('só quem publica cria álbuns e registra fotos; a outra igreja não', async () => {
    expect((await album('membro-a', church.a, `${tag} membro`)).ok()).toBe(false);
    expect((await album('adm-b', church.a, `${tag} outra`)).ok()).toBe(false);
    const made = await album('lider-a', church.a, tag);
    expect(made.ok(), await made.text()).toBe(true);
    ids.album = (await made.json())[0].id;
    ids.other = (await (await album('lider-a', church.a, `${tag} outro`)).json())[0].id;

    for (const who of ['membro-a', 'adm-b']) expect((await rpc(who, 'gallery_add_photo', { p_album: ids.album, p_ext: 'webp' })).ok(), who).toBe(false);
    const res = await rpc('lider-a', 'gallery_add_photo', { p_album: ids.album, p_ext: 'webp' });
    expect(res.ok(), await res.text()).toBe(true);
    const [p] = await res.json();
    Object.assign(ids, { photo: p.photo_id, path: p.path, mini: p.mini_path });
    expect(p.path).toBe(`${church.a}/${ids.album}/${p.photo_id}.webp`);
    expect(p.mini_path).toBe(`${church.a}/${ids.album}/${p.photo_id}-mini.webp`);
    const direct = await api.post(rest('gallery_photos'), { headers: as['lider-a'].headers, data: { church_id: church.a, album_id: ids.album, path: 'x', mini_path: 'y' } });
    expect(direct.ok()).toBe(false);
  });

  test('arquivos: só o caminho registrado, só por quem publica, até 400 KB; só a igreja vê', async () => {
    await expectDenied(await put('membro-a', ids.path), 'membro-a');
    await expectDenied(await put('lider-a', `${church.a}/${ids.album}/qualquer.webp`), 'caminho não registrado');
    expect((await put('lider-a', ids.mini, 500 * 1024)).ok()).toBe(false); // grande demais
    for (const path of [ids.path, ids.mini]) {
      const ok = await put('lider-a', path);
      expect(ok.ok(), await ok.text()).toBe(true);
    }
    expect((await sign('membro-a', ids.path)).ok()).toBe(true);
    for (const who of ['adm-b', 'sem-igreja']) expect((await sign(who, ids.path)).ok(), who).toBe(false);
    expect(await get('adm-b', `gallery_photos?select=id&id=eq.${ids.photo}`)).toEqual([]);
    const listed = async (who) => (await (await rpc(who, 'gallery_album_list', { p_church: church.a })).json()).map((a) => a.id);
    expect(await listed('membro-a')).toContain(ids.album);
    expect(await listed('adm-b')).toEqual([]);
    // A capa precisa ser uma foto do próprio álbum.
    const cover = (album_id) => api.patch(rest(`gallery_albums?id=eq.${album_id}`), { headers: returning(as['lider-a'].headers), data: { cover_photo_id: ids.photo } });
    expect((await cover(ids.other)).ok()).toBe(false);
    expect((await cover(ids.album)).ok()).toBe(true);
    // O membro não apaga fotos.
    const del = await api.delete(rest(`gallery_photos?id=eq.${ids.photo}`), { headers: returning(as['membro-a'].headers) });
    expect(await del.text()).not.toContain(ids.photo);
  });

  test('pedir para tirar a foto avisa quem publica, uma vez por pessoa', async () => {
    const ask = (who) => rpc(who, 'gallery_request_removal', { p_photo: ids.photo, p_reason: 'Apareço nela' });
    expect(await (await ask('membro-a')).json()).toBe(true);
    expect(await (await ask('membro-a')).json()).toBe(false);
    expect((await ask('adm-b')).ok()).toBe(false);
    const n = await get('lider-a', `notifications?select=url&dedupe_key=eq.galeria-retirada:${ids.photo}:${as['membro-a'].id}`);
    expect(n).toEqual([{ url: `#/galeria/${ids.album}/foto/${ids.photo}` }]);
    expect(await get('membro-a', `notifications?select=id&dedupe_key=like.galeria-retirada:${ids.photo}*`)).toEqual([]);
    const data = await (await rpc('lider-a', 'export_my_data')).json();
    expect(data.publicado_por_voce.albuns_da_galeria.map((a) => a.album)).toContain(tag);
    const mine = await (await rpc('membro-a', 'export_my_data')).json();
    expect(mine.pedidos_para_tirar_fotos_da_galeria.map((r) => r.motivo)).toContain('Apareço nela');
  });

  // Pesado (cerca de 300 pedidos ao banco): só roda quando pedido, com TESTES_PESADOS=1.
  test('o limite de 300 fotos por igreja é conferido no banco', async () => {
    test.skip(!process.env.TESTES_PESADOS, 'Teste pesado: rode com TESTES_PESADOS=1');
    test.setTimeout(180_000);
    const made = await album('adm-b', church.b, `${tag} limite`);
    expect(made.ok(), await made.text()).toBe(true);
    ids.full = (await made.json())[0].id;
    const [{ count }] = await get('adm-b', `gallery_photos?select=count&church_id=eq.${church.b}`);
    const add = () => rpc('adm-b', 'gallery_add_photo', { p_album: ids.full, p_ext: 'webp' });
    for (let left = 300 - count; left > 0; left -= 10) {
      const batch = await Promise.all(Array.from({ length: Math.min(10, left) }, add));
      for (const r of batch) expect(r.ok(), await r.text()).toBe(true);
    }
    const over = await add();
    expect(over.ok()).toBe(false);
    expect(await over.text()).toContain('limite de 300 fotos');
    // Apagar o álbum libera o espaço (as fotos registradas saem junto).
    await api.delete(rest(`gallery_albums?id=eq.${ids.full}`), { headers: as['adm-b'].headers });
    ids.full = null;
    expect(await get('adm-b', `gallery_photos?select=count&church_id=eq.${church.b}`)).toEqual([{ count }]);
  });
});


test.describe('Galeria: quem publica além da liderança (014)', () => {
  const tag = `Pub ${Date.now().toString(36)}`;
  let memberA;
  test.beforeAll(async () => {
    if (!api) return;
    [{ id: memberA }] = await get('adm-a', `members?select=id&church_id=eq.${church.a}&user_id=eq.${as['membro-a'].id}`);
  });
  test.afterAll(async () => {
    if (!api) return;
    await rpc('adm-a', 'gallery_set_publisher', { p_member: memberA, p_on: false });
    await api.delete(rest(`gallery_albums?title=like.${encodeURIComponent(tag)}*`), { headers: as['adm-a'].headers });
  });

  test('só o administrador marca quem publica; o membro marcado cria álbuns', async () => {
    const album = (who) => api.post(rest('gallery_albums'), { headers: returning(as[who].headers), data: { church_id: church.a, title: `${tag} ${who}` } });
    expect((await album('membro-a')).ok()).toBe(false);
    for (const who of ['lider-a', 'membro-a', 'adm-b'])
      expect((await rpc(who, 'gallery_set_publisher', { p_member: memberA, p_on: true })).ok(), who).toBe(false);
    const on = await rpc('adm-a', 'gallery_set_publisher', { p_member: memberA, p_on: true });
    expect(on.ok(), await on.text()).toBe(true);
    const made = await album('membro-a');
    expect(made.ok(), await made.text()).toBe(true);
    // O membro não muda a marca direto na tabela.
    const self = await api.patch(rest(`members?id=eq.${memberA}`), { headers: returning(as['membro-a'].headers), data: { gallery_publisher: false } });
    expect(self.ok()).toBe(false);
  });
});

test.describe('Salas das crianças (012)', () => {
  const tag = `Sala ${Date.now().toString(36)}`;
  const ids = {};
  let memberA;
  let fulanoB;
  const room = (who, church_id, name, extra = {}) =>
    api.post(rest('kids_rooms'), { headers: returning(as[who].headers), data: { church_id, name, ...extra } });
  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); // dia de Brasília

  test.beforeAll(async () => {
    if (!api) return;
    [{ id: memberA }] = await get('adm-a', `members?select=id&church_id=eq.${church.a}&user_id=eq.${as['membro-a'].id}`);
    [{ id: fulanoB }] = await get('adm-b', `members?select=id&church_id=eq.${church.b}&name=eq.${encodeURIComponent('Fulano da B')}`);
  });
  test.afterAll(async () => {
    if (!api) return;
    await api.delete(rest(`kids_rooms?name=like.${encodeURIComponent(tag)}*`), { headers: as['adm-a'].headers });
    await api.delete(rest(`children?name=like.${encodeURIComponent(tag)}*`), { headers: as['adm-a'].headers });
    await api.delete(rest(`kids_rooms?name=like.${encodeURIComponent(tag)}*`), { headers: as['adm-b'].headers });
  });

  test('o responsável cadastra o filho; só ele e a liderança veem', async () => {
    const res = await api.post(rest('children'), {
      headers: returning(as['membro-a'].headers),
      data: { church_id: church.a, name: `${tag} Filho`, birth_date: '2020-05-10', guardian_member_id: memberA },
    });
    expect(res.ok(), await res.text()).toBe(true);
    ids.kid = (await res.json())[0].id;
    // Ninguém cadastra criança na outra igreja.
    const fake = await api.post(rest('children'), { headers: as['adm-b'].headers, data: { church_id: church.a, name: `${tag} X`, guardian_name: 'Fulano' } });
    expect(fake.ok()).toBe(false);
    expect(await get('lider-a', `children?select=id&id=eq.${ids.kid}`)).toHaveLength(1);
    for (const who of ['adm-b', 'sem-igreja']) expect(await get(who, `children?select=id&id=eq.${ids.kid}`), who).toEqual([]);
    // A liderança cadastra a criança de quem não usa o app.
    const desk = await api.post(rest('children'), {
      headers: returning(as['lider-a'].headers),
      data: { church_id: church.a, name: `${tag} Recepção`, guardian_name: 'Mãe Sem App', guardian_phone: '5561999990003' },
    });
    expect(desk.ok(), await desk.text()).toBe(true);
    ids.desk = (await desk.json())[0].id;
    expect(await get('membro-a', `children?select=id&id=eq.${ids.desk}`)).toEqual([]);
  });

  test('só a liderança cria a sala; o tutor precisa ser da mesma igreja', async () => {
    expect((await room('membro-a', church.a, `${tag} membro`)).ok()).toBe(false);
    expect((await room('adm-b', church.a, `${tag} outra`)).ok()).toBe(false);
    expect((await room('adm-a', church.a, `${tag} errada`, { tutor_member_id: fulanoB })).ok()).toBe(false);
    const made = await room('adm-a', church.a, `${tag} Kids`);
    expect(made.ok(), await made.text()).toBe(true);
    ids.room = (await made.json())[0].id;
    const second = await room('lider-a', church.a, `${tag} Juniores`);
    expect(second.ok(), await second.text()).toBe(true);
    ids.room2 = (await second.json())[0].id;
    expect(await get('adm-b', `kids_rooms?select=id&id=eq.${ids.room}`)).toEqual([]);
  });

  test('só a liderança coloca as crianças nas salas', async () => {
    for (const who of ['membro-a', 'adm-b'])
      expect((await rpc(who, 'room_assign', { p_child: ids.kid, p_room: ids.room })).ok(), who).toBe(false);
    const ok = await rpc('lider-a', 'room_assign', { p_child: ids.kid, p_room: ids.room });
    expect(ok.ok(), await ok.text()).toBe(true);
    expect((await rpc('lider-a', 'room_assign', { p_child: ids.desk, p_room: ids.room2 })).ok()).toBe(true);
    // Sala de outra igreja não serve.
    const otherRoom = await room('adm-b', church.b, `${tag} B`);
    expect(otherRoom.ok(), await otherRoom.text()).toBe(true);
    const roomB = (await otherRoom.json())[0].id;
    expect((await rpc('lider-a', 'room_assign', { p_child: ids.kid, p_room: roomB })).ok()).toBe(false);
    // Direto na tabela, ninguém grava.
    const direct = await api.post(rest('room_children'), { headers: as['adm-a'].headers, data: { child_id: ids.desk, room_id: ids.room, church_id: church.a } });
    expect(direct.ok()).toBe(false);
  });

  test('sem ser tutor, o responsável não vê a lista nem marca; vê a sala do filho', async () => {
    expect(await (await rpc('membro-a', 'room_roster', { p_room: ids.room })).json()).toEqual([]);
    expect((await rpc('membro-a', 'room_mark', { p_room: ids.room, p_day: today, p_child: ids.kid, p_present: true })).ok()).toBe(false);
    expect((await rpc('membro-a', 'room_notify', { p_room: ids.room, p_title: 'Oi', p_body: '' })).ok()).toBe(false);
    const list = await (await rpc('membro-a', 'rooms_list', { p_church: church.a })).json();
    expect(list.find((r) => r.id === ids.room)?.my_children).toEqual([ids.kid]);
    expect(list.some((r) => r.id === ids.room2)).toBe(false);
    expect(await (await rpc('adm-b', 'rooms_list', { p_church: church.a })).json()).toEqual([]);
  });

  test('a liderança marca a presença, escreve as anotações e avisa os pais', async () => {
    const mark = await rpc('lider-a', 'room_mark', { p_room: ids.room, p_day: today, p_child: ids.kid, p_present: true });
    expect(mark.ok(), await mark.text()).toBe(true);
    // Criança de outra sala não é marcada aqui.
    expect((await rpc('lider-a', 'room_mark', { p_room: ids.room, p_day: today, p_child: ids.desk, p_present: true })).ok()).toBe(false);
    expect((await rpc('lider-a', 'room_session_save', { p_room: ids.room, p_day: today, p_notes: 'Aprendemos sobre Davi' })).ok()).toBe(true);
    const sent = await rpc('lider-a', 'room_notify', { p_room: ids.room, p_title: `${tag} passeio`, p_body: 'Domingo tem passeio' });
    expect(sent.ok(), await sent.text()).toBe(true);
    expect(await sent.json()).toBe(1);
    // O responsável recebe na central (sem o texto do aviso) e lê na sala.
    const n = await get('membro-a', `notifications?select=kind,body,url&kind=eq.sala&url=eq.${encodeURIComponent(`#/filhos/sala/${ids.room}`)}`);
    expect(n).toEqual([{ kind: 'sala', body: 'Toque para ler o aviso.', url: `#/filhos/sala/${ids.room}` }]);
    const [s] = await get('membro-a', `room_sessions?select=id,notes&room_id=eq.${ids.room}&session_date=eq.${today}`);
    expect(s.notes).toBe('Aprendemos sobre Davi');
    expect(await get('membro-a', `room_attendance?select=child_id&session_id=eq.${s.id}`)).toEqual([{ child_id: ids.kid }]);
    expect(await get('membro-a', `room_messages?select=body&room_id=eq.${ids.room}`)).toEqual([{ body: 'Domingo tem passeio' }]);
    for (const t of ['room_sessions', 'room_attendance', 'room_messages']) expect(await get('adm-b', `${t}?select=*`), t).toEqual([]);
  });

  test('o tutor cuida só da sala dele', async () => {
    const set = await api.patch(rest(`kids_rooms?id=eq.${ids.room}`), { headers: returning(as['adm-a'].headers), data: { tutor_member_id: memberA } });
    expect(set.ok(), await set.text()).toBe(true);
    const roster = await (await rpc('membro-a', 'room_roster', { p_room: ids.room, p_day: today })).json();
    expect(roster.map((k) => [k.id, k.present])).toEqual([[ids.kid, true]]);
    expect((await rpc('membro-a', 'room_mark', { p_room: ids.room, p_day: today, p_child: ids.kid, p_present: false })).ok()).toBe(true);
    // A outra sala continua fechada para ele.
    expect(await (await rpc('membro-a', 'room_roster', { p_room: ids.room2 })).json()).toEqual([]);
    expect(await get('membro-a', `children?select=id&id=eq.${ids.desk}`)).toEqual([]);
    // O tutor não troca o tutor nem muda criança de sala.
    const swap = await api.patch(rest(`kids_rooms?id=eq.${ids.room}`), { headers: returning(as['membro-a'].headers), data: { tutor_member_id: null } });
    expect(await swap.text()).not.toContain(ids.room);
    expect((await rpc('membro-a', 'room_assign', { p_child: ids.desk, p_room: ids.room })).ok()).toBe(false);
    const mine = await (await rpc('membro-a', 'export_my_data')).json();
    expect(mine.filhos.find((f) => f.nome === `${tag} Filho`).sala).toBe(`${tag} Kids`);
  });
});

test.describe('Reações nos avisos (019)', () => {
  const tag = `reação-${Date.now()}`;
  test('o membro reage aos avisos que vê; quem é de fora não reage, e ninguém vê quem reagiu', async () => {
    const mk = async (extra) => {
      const res = await api.post(rest('announcements'), {
        headers: returning(as['lider-a'].headers),
        data: { church_id: church.a, title: `Aviso ${tag} reação`, body: 'Texto', ...extra },
      });
      expect(res.ok(), await res.text()).toBe(true);
      return (await res.json())[0];
    };
    const react = (who, id, emoji) => rpc(who, 'set_announcement_reaction', { p_announcement: id, p_emoji: emoji });
    const counts = async (who, id) => {
      const res = await rpc(who, 'announcement_reaction_counts', { p_church: church.a });
      expect(res.ok(), await res.text()).toBe(true);
      return (await res.json()).filter((r) => r.announcement_id === id).sort((x, y) => x.emoji.localeCompare(y.emoji));
    };
    const a = await mk({});
    const old = await mk({ visible_until: '2020-01-01' });
    try {
      expect((await react('membro-a', a.id, '🎉')).ok()).toBe(true);
      expect((await react('lider-a', a.id, '🎉')).ok()).toBe(true);
      expect(await counts('membro-a', a.id)).toEqual([{ announcement_id: a.id, emoji: '🎉', total: 2, mine: true }]);
      // Trocar de emoji: continua uma reação por pessoa.
      expect((await react('membro-a', a.id, '👍')).ok()).toBe(true);
      expect(await counts('lider-a', a.id)).toEqual([
        { announcement_id: a.id, emoji: '🎉', total: 1, mine: true },
        { announcement_id: a.id, emoji: '👍', total: 1, mine: false },
      ].sort((x, y) => x.emoji.localeCompare(y.emoji)));
      // Só os emojis da lista.
      expect((await react('membro-a', a.id, '💩')).ok()).toBe(false);
      // Outra instituição e quem não está em nenhuma: não reagem nem veem as contagens.
      for (const who of ['adm-b', 'sem-igreja']) {
        expect((await react(who, a.id, '👍')).ok(), who).toBe(false);
        expect(await counts(who, a.id), who).toEqual([]);
      }
      // Visitante sem conta: nada.
      const anon = await api.post(rest('rpc/set_announcement_reaction'), { headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, data: { p_announcement: a.id, p_emoji: '👍' } });
      expect(anon.ok()).toBe(false);
      // Aviso vencido: o membro não vê, então não reage; a liderança reage.
      expect((await react('membro-a', old.id, '👍')).ok()).toBe(false);
      expect((await react('lider-a', old.id, '👍')).ok()).toBe(true);
      // A tabela é fechada: quem reagiu não aparece para ninguém.
      for (const who of ['membro-a', 'adm-a']) {
        const res = await api.get(rest('announcement_reactions?select=*'), { headers: as[who].headers });
        expect(res.ok() ? await res.json() : [], who).toEqual([]);
      }
      // "Baixar meus dados" traz a reação da pessoa.
      const mine = await (await rpc('membro-a', 'export_my_data')).json();
      expect(mine.reacoes_aos_avisos).toEqual(expect.arrayContaining([expect.objectContaining({ aviso: `Aviso ${tag} reação`, reacao: '👍' })]));
      // Tirar a reação.
      expect((await react('membro-a', a.id, null)).ok()).toBe(true);
      expect(await counts('membro-a', a.id)).toEqual([{ announcement_id: a.id, emoji: '🎉', total: 1, mine: false }]);
    } finally {
      for (const x of [a, old]) await api.delete(rest(`announcements?id=eq.${x.id}`), { headers: as['lider-a'].headers });
    }
  });
});

test.describe('Chat em grupos (020)', () => {
  const tag = `chat-${Date.now()}`;
  const ids = {};
  const send = (who, body, file = {}) => rpc(who, 'chat_send', { p_group: ids.group, p_body: body, ...file });
  const groupsOf = async (who) => {
    const res = await rpc(who, 'chat_group_list', { p_church: church.a });
    return res.ok() ? res.json() : [];
  };
  const putFile = (who, path, type = 'text/plain') =>
    api.post(`${SUPABASE_URL}/storage/v1/object/chat/${path}`, { headers: { ...as[who].headers, 'Content-Type': type }, data: Buffer.from('Olá, turma!') });
  const sign = (who, path) => api.post(`${SUPABASE_URL}/storage/v1/object/sign/chat/${path}`, { headers: as[who].headers, data: { expiresIn: 60 } });

  test.beforeAll(async () => {
    if (!api) return;
    [{ id: ids.membro }] = await get('adm-a', `members?select=id&church_id=eq.${church.a}&user_id=eq.${as['membro-a'].id}`);
    [{ id: ids.lider }] = await get('adm-a', `members?select=id&church_id=eq.${church.a}&user_id=eq.${as['lider-a'].id}`);
    [{ id: ids.fulanoB }] = await get('adm-b', 'members?select=id&name=eq.Fulano da B');
  });

  test.afterAll(async () => {
    if (!api || !ids.group) return;
    const files = await get('lider-a', `chat_messages?select=file_path&group_id=eq.${ids.group}&file_path=not.is.null`);
    if (files.length) await api.delete(`${SUPABASE_URL}/storage/v1/object/chat`, { headers: as['lider-a'].headers, data: { prefixes: files.map((f) => f.file_path) } });
    await api.delete(rest(`chat_groups?id=eq.${ids.group}`), { headers: as['lider-a'].headers });
  });

  test('só a liderança cria grupos, e só com gente da própria instituição', async () => {
    const create = (who, members) =>
      rpc(who, 'chat_create_group', { p_church: church.a, p_name: `${tag} Turma`, p_description: null, p_locked: false, p_members: members });
    for (const who of ['membro-a', 'adm-b', 'sem-igreja']) expect((await create(who, [])).ok(), who).toBe(false);
    const res = await create('lider-a', [ids.membro, ids.fulanoB]);
    expect(res.ok(), await res.text()).toBe(true);
    ids.group = await res.json();
    const people = await (await rpc('lider-a', 'chat_group_members', { p_group: ids.group })).json();
    // Quem é de outra instituição não entra; quem criou é administrador.
    expect(people.map((p) => p.member_id).sort()).toEqual([ids.lider, ids.membro].sort());
    expect(people.find((p) => p.member_id === ids.lider).is_admin).toBe(true);
    expect(people.find((p) => p.member_id === ids.membro).is_admin).toBe(false);
    // Escolher pessoas: só a liderança (para criar) ou o administrador do grupo.
    expect(await (await rpc('membro-a', 'chat_candidates', { p_church: church.a })).json()).toEqual([]);
    expect(await (await rpc('membro-a', 'chat_candidates', { p_church: church.a, p_group: ids.group })).json()).toEqual([]);
    expect(await (await rpc('adm-b', 'chat_candidates', { p_church: church.a })).json()).toEqual([]);
    const cands = await (await rpc('lider-a', 'chat_candidates', { p_church: church.a, p_group: ids.group })).json();
    expect(cands.map((c) => c.member_id)).not.toContain(ids.membro);
  });

  test('só quem está no grupo lê e escreve; ninguém grava direto na tabela', async () => {
    const sent = await send('membro-a', `Olá ${tag} https://exemplo.com`);
    expect(sent.ok(), await sent.text()).toBe(true);
    ids.msg = (await sent.json())[0].id;
    expect(await get('lider-a', `chat_messages?select=id,body&group_id=eq.${ids.group}`)).toEqual([{ id: ids.msg, body: `Olá ${tag} https://exemplo.com` }]);
    // O administrador da instituição fora do grupo, a outra instituição e quem não está em nenhuma: nada.
    for (const who of ['adm-a', 'adm-b', 'sem-igreja']) {
      expect(await get(who, `chat_messages?select=id&group_id=eq.${ids.group}`), who).toEqual([]);
      expect(await get(who, `chat_groups?select=id&id=eq.${ids.group}`), who).toEqual([]);
      expect(await get(who, `chat_members?select=member_id&group_id=eq.${ids.group}`), who).toEqual([]);
      expect(await (await rpc(who, 'chat_group_members', { p_group: ids.group })).json(), who).toEqual([]);
      expect((await send(who, 'Intruso')).ok(), who).toBe(false);
    }
    expect((await groupsOf('adm-b')).map((g) => g.id)).not.toContain(ids.group);
    const direct = await api.post(rest('chat_messages'), {
      headers: as['membro-a'].headers,
      data: { group_id: ids.group, church_id: church.a, author_id: ids.lider, body: 'Falsificada' },
    });
    expect(direct.ok()).toBe(false);
    const join = await api.post(rest('chat_members'), { headers: as['adm-b'].headers, data: { group_id: ids.group, member_id: ids.fulanoB } });
    expect(join.ok()).toBe(false);
    // Visitante sem conta.
    const anon = await api.post(rest('rpc/chat_send'), { headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' }, data: { p_group: ids.group, p_body: 'x' } });
    expect(anon.ok()).toBe(false);
    // Não lidas: a líder tem 1; depois de ler, 0.
    expect((await groupsOf('lider-a')).find((g) => g.id === ids.group).unread).toBe(1);
    expect((await rpc('lider-a', 'chat_mark_read', { p_group: ids.group })).ok()).toBe(true);
    expect((await groupsOf('lider-a')).find((g) => g.id === ids.group).unread).toBe(0);
    // O participante não apaga a mensagem dos outros, só a própria.
    const mine = await send('lider-a', 'Da líder');
    const liderMsg = (await mine.json())[0].id;
    const del = await api.delete(rest(`chat_messages?id=eq.${liderMsg}`), { headers: returning(as['membro-a'].headers) });
    expect(await del.text()).not.toContain(liderMsg);
    const own = await api.delete(rest(`chat_messages?id=eq.${ids.msg}`), { headers: returning(as['membro-a'].headers) });
    expect(await own.text()).toContain(ids.msg);
  });

  test('grupo bloqueado: só os administradores enviam; o participante não muda o grupo', async () => {
    const lock = (who, locked) => api.patch(rest(`chat_groups?id=eq.${ids.group}`), { headers: returning(as[who].headers), data: { locked } });
    expect(await (await lock('membro-a', true)).text()).not.toContain(ids.group);
    expect(await (await lock('lider-a', true)).json()).toEqual([expect.objectContaining({ id: ids.group, locked: true })]);
    expect((await send('membro-a', 'Posso?')).ok()).toBe(false);
    expect((await send('lider-a', 'Recado da direção')).ok()).toBe(true);
    // O participante não coloca gente, não vira administrador e não tira ninguém.
    expect((await rpc('membro-a', 'chat_add_members', { p_group: ids.group, p_members: [ids.membro] })).ok()).toBe(false);
    expect((await rpc('membro-a', 'chat_set_admin', { p_group: ids.group, p_member: ids.membro, p_on: true })).ok()).toBe(false);
    expect((await rpc('membro-a', 'chat_remove_member', { p_group: ids.group, p_member: ids.lider })).ok()).toBe(false);
    // O administrador torna o participante administrador: aí ele envia.
    expect((await rpc('lider-a', 'chat_set_admin', { p_group: ids.group, p_member: ids.membro, p_on: true })).ok()).toBe(true);
    expect((await send('membro-a', 'Agora posso')).ok()).toBe(true);
    expect((await rpc('lider-a', 'chat_set_admin', { p_group: ids.group, p_member: ids.membro, p_on: false })).ok()).toBe(true);
    expect((await send('membro-a', 'E agora?')).ok()).toBe(false);
    expect(await (await lock('lider-a', false)).json()).toEqual([expect.objectContaining({ locked: false })]);
  });

  test('anexos: só o autor envia o arquivo registrado; só o grupo abre; limite de tamanho', async () => {
    const file = { p_file_name: 'lista.txt', p_file_type: 'text/plain', p_file_size: 11, p_ext: 'txt' };
    expect((await send('membro-a', null, { ...file, p_file_size: 30 * 1024 * 1024 })).ok()).toBe(false); // passa de 25 MB
    const res = await send('membro-a', 'Segue a lista', file);
    expect(res.ok(), await res.text()).toBe(true);
    const [{ id, file_path: path }] = await res.json();
    expect(path.startsWith(`${church.a}/${ids.group}/`)).toBe(true);
    // Antes de o arquivo chegar, só o autor vê a mensagem.
    expect(await get('lider-a', `chat_messages?select=id&id=eq.${id}`)).toEqual([]);
    for (const who of ['lider-a', 'adm-b']) await expectDenied(await putFile(who, path), who);
    await expectDenied(await putFile('membro-a', `${church.a}/${ids.group}/qualquer.txt`), 'caminho não registrado');
    expect((await rpc('membro-a', 'chat_file_ready', { p_message: id })).ok()).toBe(false); // ainda não chegou
    const up = await putFile('membro-a', path);
    expect(up.ok(), await up.text()).toBe(true);
    expect((await rpc('lider-a', 'chat_file_ready', { p_message: id })).ok()).toBe(false); // não é o autor
    expect((await rpc('membro-a', 'chat_file_ready', { p_message: id })).ok()).toBe(true);
    expect(await get('lider-a', `chat_messages?select=id,file_size&id=eq.${id}`)).toEqual([{ id, file_size: 12 }]);
    expect((await sign('lider-a', path)).ok()).toBe(true);
    for (const who of ['adm-a', 'adm-b', 'sem-igreja']) expect((await sign(who, path)).ok(), who).toBe(false);
    // O participante não apaga o arquivo dos outros.
    const other = await send('lider-a', null, file);
    const [{ file_path: liderPath }] = await other.json();
    expect((await putFile('lider-a', liderPath)).ok()).toBe(true);
    await api.delete(`${SUPABASE_URL}/storage/v1/object/chat`, { headers: as['membro-a'].headers, data: { prefixes: [liderPath] } });
    expect((await sign('lider-a', liderPath)).ok()).toBe(true);
    // O administrador do grupo apaga o arquivo de outra pessoa (022).
    await api.delete(`${SUPABASE_URL}/storage/v1/object/chat`, { headers: as['lider-a'].headers, data: { prefixes: [path] } });
    expect((await sign('lider-a', path)).ok()).toBe(false);
  });

  test('"Baixar meus dados" traz os grupos e as mensagens; sair do grupo tira o acesso', async () => {
    const mine = await (await rpc('membro-a', 'export_my_data')).json();
    expect(mine.grupos_de_conversa).toEqual(expect.arrayContaining([expect.objectContaining({ grupo: `${tag} Turma` })]));
    expect(mine.mensagens_enviadas_no_chat).toEqual(expect.arrayContaining([expect.objectContaining({ grupo: `${tag} Turma`, texto: 'Agora posso' })]));
    expect((await rpc('membro-a', 'chat_remove_member', { p_group: ids.group, p_member: ids.membro })).ok()).toBe(true);
    expect((await groupsOf('membro-a')).map((g) => g.id)).not.toContain(ids.group);
    expect(await get('membro-a', `chat_messages?select=id&group_id=eq.${ids.group}`)).toEqual([]);
    // A líder coloca de novo (e a conta da outra instituição continua sem entrar).
    expect(await (await rpc('lider-a', 'chat_add_members', { p_group: ids.group, p_members: [ids.membro, ids.fulanoB] })).json()).toBe(1);
    expect((await groupsOf('membro-a')).map((g) => g.id)).toContain(ids.group);
  });
});

test.describe('Ícone do grupo do chat (021)', () => {
  const ids = {};
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const put = (who, path) =>
    api.post(`${SUPABASE_URL}/storage/v1/object/chat/${path}`, { headers: { ...as[who].headers, 'Content-Type': 'image/png' }, data: png });
  test.afterAll(async () => {
    if (!api || !ids.group) return;
    if (ids.icon) await api.delete(`${SUPABASE_URL}/storage/v1/object/chat`, { headers: as['lider-a'].headers, data: { prefixes: [ids.icon] } });
    await api.delete(rest(`chat_groups?id=eq.${ids.group}`), { headers: as['lider-a'].headers });
  });
  test('só o administrador do grupo troca o ícone, na pasta do grupo; só o grupo vê', async () => {
    const [{ id: membro }] = await get('adm-a', `members?select=id&church_id=eq.${church.a}&user_id=eq.${as['membro-a'].id}`);
    const res = await rpc('lider-a', 'chat_create_group', { p_church: church.a, p_name: `Ícone ${Date.now()}`, p_description: null, p_locked: false, p_members: [membro] });
    ids.group = await res.json();
    ids.icon = `${church.a}/${ids.group}/icone-teste1.webp`;
    await expectDenied(await put('membro-a', ids.icon), 'participante');
    await expectDenied(await put('adm-b', ids.icon), 'outra instituição');
    await expectDenied(await put('lider-a', `${church.a}/${ids.group}/outro-nome.webp`), 'nome fora do padrão');
    const up = await put('lider-a', ids.icon);
    expect(up.ok(), await up.text()).toBe(true);
    const set = (who, icon_path) => api.patch(rest(`chat_groups?id=eq.${ids.group}`), { headers: returning(as[who].headers), data: { icon_path } });
    expect((await set('lider-a', `${church.b}/${ids.group}/icone-x.webp`)).ok()).toBe(false); // fora da pasta do grupo
    expect(await (await set('membro-a', ids.icon)).text()).not.toContain(ids.group);
    expect(await (await set('lider-a', ids.icon)).json()).toEqual([expect.objectContaining({ icon_path: ids.icon })]);
    const sign = (who) => api.post(`${SUPABASE_URL}/storage/v1/object/sign/chat/${ids.icon}`, { headers: as[who].headers, data: { expiresIn: 60 } });
    expect((await sign('membro-a')).ok()).toBe(true);
    for (const who of ['adm-a', 'adm-b', 'sem-igreja']) expect((await sign(who)).ok(), who).toBe(false);
    const list = await (await rpc('membro-a', 'chat_group_list', { p_church: church.a })).json();
    expect(list.find((g) => g.id === ids.group).icon_path).toBe(ids.icon);
  });
});

test.describe('Chat: responder citando (026)', () => {
  const ids = {};
  test.afterAll(async () => {
    for (const g of [ids.g1, ids.g2].filter(Boolean)) await api.delete(rest(`chat_groups?id=eq.${g}`), { headers: as['lider-a'].headers });
  });
  test('responde só a mensagem do mesmo grupo; a citação some se a original for apagada', async () => {
    const make = async (name) => {
      const res = await rpc('lider-a', 'chat_create_group', { p_church: church.a, p_name: name, p_description: null, p_locked: false, p_members: [] });
      expect(res.ok(), await res.text()).toBe(true);
      return await res.json();
    };
    ids.g1 = await make(`resp-${Date.now()} 1`);
    ids.g2 = await make(`resp-${Date.now()} 2`);
    const send = async (group, body, reply) =>
      rpc('lider-a', 'chat_send', { p_group: group, p_body: body, ...(reply ? { p_reply_to: reply } : {}) });
    const [orig] = await (await send(ids.g1, 'Original')).json();
    // De outro grupo: recusa.
    expect((await send(ids.g2, 'Resposta de fora', orig.id)).ok()).toBe(false);
    const res = await send(ids.g1, 'Resposta', orig.id);
    expect(res.ok(), await res.text()).toBe(true);
    const [answer] = await res.json();
    const read = async () => (await get('lider-a', `chat_messages?select=reply_to,reply:reply_to(body)&id=eq.${answer.id}`))[0];
    expect(await read()).toEqual({ reply_to: orig.id, reply: { body: 'Original' } });
    // Outra instituição não lê nada.
    expect(await get('adm-b', `chat_messages?select=id&id=in.(${orig.id},${answer.id})`)).toEqual([]);
    // A original apagada: a resposta fica, sem a citação.
    expect((await api.delete(rest(`chat_messages?id=eq.${orig.id}`), { headers: as['lider-a'].headers })).ok()).toBe(true);
    expect(await read()).toEqual({ reply_to: null, reply: null });
  });
});

test.describe('Projetos das salas (021)', () => {
  const tag = `proj-${Date.now()}`;
  const ids = {};
  const project = (who, room_id, title, extra = {}) =>
    api.post(rest('room_projects'), { headers: returning(as[who].headers), data: { room_id, church_id: church.a, title, ...extra } });
  const seen = async (who) => {
    const res = await rpc(who, 'projects_list', { p_church: church.a });
    return res.ok() ? (await res.json()).map((p) => p.id) : [];
  };
  const putFile = (who, path) =>
    api.post(`${SUPABASE_URL}/storage/v1/object/projetos/${path}`, { headers: { ...as[who].headers, 'Content-Type': 'text/plain' }, data: Buffer.from('Roteiro do projeto') });
  const sign = (who, path) => api.post(`${SUPABASE_URL}/storage/v1/object/sign/projetos/${path}`, { headers: as[who].headers, data: { expiresIn: 60 } });

  test.beforeAll(async () => {
    if (!api) return;
    [{ id: ids.membro }] = await get('adm-a', `members?select=id&church_id=eq.${church.a}&user_id=eq.${as['membro-a'].id}`);
    const room = async (name) => (await (await api.post(rest('kids_rooms'), { headers: returning(as['adm-a'].headers), data: { church_id: church.a, name } })).json())[0].id;
    ids.room = await room(`${tag} A`.slice(0, 40));
    ids.other = await room(`${tag} B`.slice(0, 40));
    const kid = await api.post(rest('children'), {
      headers: returning(as['membro-a'].headers),
      data: { church_id: church.a, name: `${tag} Filho`, birth_date: '2019-04-02', guardian_member_id: ids.membro },
    });
    expect(kid.ok(), await kid.text()).toBe(true);
    ids.kid = (await kid.json())[0].id;
    expect((await rpc('adm-a', 'room_assign', { p_child: ids.kid, p_room: ids.room })).ok()).toBe(true);
  });

  test.afterAll(async () => {
    if (!api) return;
    const files = await get('adm-a', `project_files?select=path&church_id=eq.${church.a}&project_id=in.(${[ids.p1, ids.p2, ids.p3].filter(Boolean).join(',') || '00000000-0000-0000-0000-000000000000'})`);
    if (files.length) await api.delete(`${SUPABASE_URL}/storage/v1/object/projetos`, { headers: as['adm-a'].headers, data: { prefixes: files.map((f) => f.path) } });
    for (const r of [ids.room, ids.other].filter(Boolean)) await api.delete(rest(`kids_rooms?id=eq.${r}`), { headers: as['adm-a'].headers });
    if (ids.kid) await api.delete(rest(`children?id=eq.${ids.kid}`), { headers: as['membro-a'].headers });
  });

  test('o tutor e a liderança criam; só os pais da sala veem; avisa os pais', async () => {
    expect((await project('membro-a', ids.room, `${tag} do membro`)).ok()).toBe(false);
    expect((await project('adm-b', ids.room, `${tag} de fora`)).ok()).toBe(false);
    const p1 = await project('lider-a', ids.room, `${tag} Feira`, { starts_on: '2026-11-01', due_on: '2026-11-30' });
    expect(p1.ok(), await p1.text()).toBe(true);
    ids.p1 = (await p1.json())[0].id;
    expect((await project('lider-a', ids.room, `${tag} Datas`, { starts_on: '2026-11-30', due_on: '2026-11-01' })).ok()).toBe(false);
    ids.p2 = (await (await project('lider-a', ids.other, `${tag} Outra sala`)).json())[0].id;
    // O responsável da criança da sala vê; o da outra sala, não; outra instituição e sem igreja, nada.
    expect(await seen('membro-a')).toContain(ids.p1);
    expect(await seen('membro-a')).not.toContain(ids.p2);
    for (const who of ['adm-b', 'sem-igreja']) {
      expect(await seen(who), who).toEqual([]);
      expect(await get(who, `room_projects?select=id&id=in.(${ids.p1},${ids.p2})`), who).toEqual([]);
    }
    expect(await get('membro-a', `room_projects?select=id&id=eq.${ids.p2}`)).toEqual([]);
    // Projeto novo avisa os pais da sala.
    const notes = await get('membro-a', `notifications?select=url&url=eq.${encodeURIComponent(`#/projetos/${ids.p1}`)}`);
    expect(notes).toHaveLength(1);
    // O pai não edita, não troca de sala nem apaga.
    const edit = await api.patch(rest(`room_projects?id=eq.${ids.p1}`), { headers: returning(as['membro-a'].headers), data: { title: 'Invadido' } });
    expect(await edit.text()).not.toContain(ids.p1);
    const move = await api.patch(rest(`room_projects?id=eq.${ids.p1}`), { headers: returning(as['membro-a'].headers), data: { room_id: ids.other } });
    expect(await move.text()).not.toContain(ids.p1);
    const del = await api.delete(rest(`room_projects?id=eq.${ids.p1}`), { headers: returning(as['membro-a'].headers) });
    expect(await del.text()).not.toContain(ids.p1);
    // Tutor da outra sala: passa a criar nela.
    expect((await api.patch(rest(`kids_rooms?id=eq.${ids.other}`), { headers: as['adm-a'].headers, data: { tutor_member_id: ids.membro } })).ok()).toBe(true);
    const p3 = await project('membro-a', ids.other, `${tag} Do tutor`);
    expect(p3.ok(), await p3.text()).toBe(true);
    ids.p3 = (await p3.json())[0].id;
    expect((await api.patch(rest(`kids_rooms?id=eq.${ids.other}`), { headers: as['adm-a'].headers, data: { tutor_member_id: null } })).ok()).toBe(true);
    expect((await project('membro-a', ids.other, `${tag} Não é mais tutor`)).ok()).toBe(false);
  });

  test('etapas: quem cuida da sala cria e marca; os pais só leem', async () => {
    const step = await api.post(rest('project_steps'), { headers: returning(as['lider-a'].headers), data: { project_id: ids.p1, title: 'Pesquisa', due_on: '2026-11-10' } });
    expect(step.ok(), await step.text()).toBe(true);
    const [{ id: stepId }] = await step.json();
    expect((await api.post(rest('project_steps'), { headers: as['membro-a'].headers, data: { project_id: ids.p1, title: 'Do pai' } })).ok()).toBe(false);
    const tick = (who) => api.patch(rest(`project_steps?id=eq.${stepId}`), { headers: returning(as[who].headers), data: { done_at: '2000-01-01T00:00:00Z' } });
    expect(await (await tick('membro-a')).text()).not.toContain(stepId);
    const [done] = await (await tick('lider-a')).json();
    // Quem marcou e quando: o banco decide.
    expect(done.done_by).toBe(as['lider-a'].id);
    expect(new Date(done.done_at).getFullYear()).toBeGreaterThan(2000);
    expect(await get('membro-a', `project_steps?select=id,done_at&project_id=eq.${ids.p1}`)).toEqual([{ id: stepId, done_at: done.done_at }]);
    expect(await get('adm-b', `project_steps?select=id&project_id=eq.${ids.p1}`)).toEqual([]);
  });

  test('arquivos: só quem cuida da sala envia o arquivo registrado; os pais da sala abrem', async () => {
    const add = (who) => rpc(who, 'project_add_file', { p_project: ids.p1, p_name: 'roteiro.txt', p_type: 'text/plain', p_size: 18, p_ext: 'txt' });
    expect((await add('membro-a')).ok()).toBe(false);
    expect((await rpc('lider-a', 'project_add_file', { p_project: ids.p1, p_name: 'grande.mp4', p_type: 'video/mp4', p_size: 30 * 1024 * 1024, p_ext: 'mp4' })).ok()).toBe(false);
    const res = await add('lider-a');
    expect(res.ok(), await res.text()).toBe(true);
    const [{ file_id: fileId, path }] = await res.json();
    expect(await get('membro-a', `project_files?select=id&id=eq.${fileId}`)).toEqual([]); // ainda não chegou
    for (const who of ['membro-a', 'adm-b']) await expectDenied(await putFile(who, path), who);
    await expectDenied(await putFile('lider-a', `${church.a}/${ids.p1}/qualquer.txt`), 'caminho não registrado');
    expect((await putFile('lider-a', path)).ok()).toBe(true);
    expect((await rpc('membro-a', 'project_file_ready', { p_file: fileId })).ok()).toBe(false);
    expect((await rpc('lider-a', 'project_file_ready', { p_file: fileId })).ok()).toBe(true);
    expect(await get('membro-a', `project_files?select=id,file_size&id=eq.${fileId}`)).toEqual([{ id: fileId, file_size: 18 }]);
    expect((await sign('membro-a', path)).ok()).toBe(true);
    for (const who of ['adm-b', 'sem-igreja']) expect((await sign(who, path)).ok(), who).toBe(false);
    // O pai não apaga o arquivo.
    await api.delete(`${SUPABASE_URL}/storage/v1/object/projetos`, { headers: as['membro-a'].headers, data: { prefixes: [path] } });
    expect((await sign('lider-a', path)).ok()).toBe(true);
  });

  test('comentários: quem vê o projeto comenta; cada um apaga o seu, quem cuida da sala apaga todos', async () => {
    const say = (who, project, body) => rpc(who, 'project_comment', { p_project: project, p_body: body });
    const mine = await say('membro-a', ids.p1, 'Que legal! Precisa de material?');
    expect(mine.ok(), await mine.text()).toBe(true);
    const myId = await mine.json();
    expect((await say('membro-a', ids.p2, 'Outra sala')).ok()).toBe(false);
    expect((await say('adm-b', ids.p1, 'De fora')).ok()).toBe(false);
    expect((await api.post(rest('project_comments'), { headers: as['membro-a'].headers, data: { project_id: ids.p1, church_id: church.a, body: 'Direto' } })).ok()).toBe(false);
    const leaderSays = await (await say('lider-a', ids.p1, 'Só uma caixa de papelão.')).json();
    const list = await (await rpc('membro-a', 'project_comment_list', { p_project: ids.p1 })).json();
    expect(list.map((c) => [c.body, c.mine, c.can_delete])).toEqual([
      ['Que legal! Precisa de material?', true, true],
      ['Só uma caixa de papelão.', false, false],
    ]);
    expect(await (await rpc('adm-b', 'project_comment_list', { p_project: ids.p1 })).json()).toEqual([]);
    const theirs = await api.delete(rest(`project_comments?id=eq.${leaderSays}`), { headers: returning(as['membro-a'].headers) });
    expect(await theirs.text()).not.toContain(leaderSays);
    const exported = await (await rpc('membro-a', 'export_my_data')).json();
    expect(exported.comentarios_em_projetos).toEqual(expect.arrayContaining([expect.objectContaining({ projeto: `${tag} Feira`, comentario: 'Que legal! Precisa de material?' })]));
    const mod = await api.delete(rest(`project_comments?id=eq.${myId}`), { headers: returning(as['lider-a'].headers) });
    expect(await mod.text()).toContain(myId);
  });

  test('trocar de sala (024): quem cuida das duas salas troca; a sala nova passa a ver e é avisada', async () => {
    const move = (who, id, room_id) => api.patch(rest(`room_projects?id=eq.${id}`), { headers: returning(as[who].headers), data: { room_id } });
    // A liderança traz o projeto da outra sala para a sala do filho do membro: ele passa a ver e é avisado.
    expect(await seen('membro-a')).not.toContain(ids.p2);
    const res = await move('lider-a', ids.p2, ids.room);
    expect(res.ok(), await res.text()).toBe(true);
    expect(await seen('membro-a')).toContain(ids.p2);
    expect(await get('membro-a', `notifications?select=url&url=eq.${encodeURIComponent(`#/projetos/${ids.p2}`)}`)).toHaveLength(1);
    // As etapas, os arquivos e os comentários vão junto (seguem a sala do projeto).
    expect(await get('membro-a', `room_projects?select=id&id=eq.${ids.p2}`)).toHaveLength(1);
    // Volta para a outra sala: deixa de ver.
    expect((await move('lider-a', ids.p2, ids.other)).ok()).toBe(true);
    expect(await seen('membro-a')).not.toContain(ids.p2);
    // O tutor da outra sala não leva o projeto para uma sala que ele não cuida.
    expect((await api.patch(rest(`kids_rooms?id=eq.${ids.other}`), { headers: as['adm-a'].headers, data: { tutor_member_id: ids.membro } })).ok()).toBe(true);
    try {
      expect(await (await move('membro-a', ids.p3, ids.room)).text()).not.toContain(ids.p3);
      expect(await get('lider-a', `room_projects?select=room_id&id=eq.${ids.p3}`)).toEqual([{ room_id: ids.other }]);
    } finally {
      await api.patch(rest(`kids_rooms?id=eq.${ids.other}`), { headers: as['adm-a'].headers, data: { tutor_member_id: null } });
    }
    // Nem para a sala de outra instituição.
    const [roomB] = await (await api.post(rest('kids_rooms'), { headers: returning(as['adm-b'].headers), data: { church_id: church.b, name: `${tag} B`.slice(0, 40) } })).json();
    try {
      expect((await move('lider-a', ids.p2, roomB.id)).ok()).toBe(false);
      expect(await get('lider-a', `room_projects?select=room_id,church_id&id=eq.${ids.p2}`)).toEqual([{ room_id: ids.other, church_id: church.a }]);
    } finally {
      await api.delete(rest(`kids_rooms?id=eq.${roomB.id}`), { headers: as['adm-b'].headers });
    }
  });
});

test.describe('Calendário do ano (023)', () => {
  const ids = {};
  const put = (who, path, type = 'application/pdf') =>
    api.post(`${SUPABASE_URL}/storage/v1/object/calendarios/${path}`, { headers: { ...as[who].headers, 'Content-Type': type }, data: Buffer.from('%PDF-1.4 calendario') });
  const sign = (who, path) => api.post(`${SUPABASE_URL}/storage/v1/object/sign/calendarios/${path}`, { headers: as[who].headers, data: { expiresIn: 60 } });
  const add = (who, extra = {}) =>
    rpc(who, 'agenda_calendar_add', { p_church: church.a, p_year: 2026, p_title: 'Calendário teste', p_type: 'application/pdf', p_size: 19, p_ext: 'pdf', ...extra });
  test.afterAll(async () => {
    if (!api || !ids.path) return;
    await api.delete(`${SUPABASE_URL}/storage/v1/object/calendarios`, { headers: as['lider-a'].headers, data: { prefixes: [ids.path] } });
    await api.delete(rest(`agenda_calendars?id=eq.${ids.id}`), { headers: as['lider-a'].headers });
  });
  test('só a liderança envia; os membros da instituição veem; a outra instituição, não', async () => {
    for (const who of ['membro-a', 'adm-b', 'sem-igreja']) expect((await add(who)).ok(), who).toBe(false);
    expect((await add('lider-a', { p_type: 'text/html' })).ok()).toBe(false);
    expect((await add('lider-a', { p_size: 20 * 1024 * 1024 })).ok()).toBe(false);
    const res = await add('lider-a');
    expect(res.ok(), await res.text()).toBe(true);
    [{ calendar_id: ids.id, path: ids.path }] = await res.json();
    // Antes de o arquivo chegar, os membros não veem.
    expect(await get('membro-a', `agenda_calendars?select=id&id=eq.${ids.id}`)).toEqual([]);
    for (const who of ['membro-a', 'adm-b']) await expectDenied(await put(who, ids.path), who);
    await expectDenied(await put('lider-a', `${church.a}/qualquer.pdf`), 'caminho não registrado');
    expect((await put('lider-a', ids.path)).ok()).toBe(true);
    expect((await rpc('membro-a', 'agenda_calendar_ready', { p_calendar: ids.id })).ok()).toBe(false);
    expect((await rpc('lider-a', 'agenda_calendar_ready', { p_calendar: ids.id })).ok()).toBe(true);
    expect(await get('membro-a', `agenda_calendars?select=id,file_size&id=eq.${ids.id}`)).toEqual([{ id: ids.id, file_size: 19 }]);
    expect((await sign('membro-a', ids.path)).ok()).toBe(true);
    for (const who of ['adm-b', 'sem-igreja']) {
      expect((await sign(who, ids.path)).ok(), who).toBe(false);
      expect(await get(who, `agenda_calendars?select=id&id=eq.${ids.id}`), who).toEqual([]);
    }
    // O membro não renomeia nem apaga (nem o arquivo).
    const ren = await api.patch(rest(`agenda_calendars?id=eq.${ids.id}`), { headers: returning(as['membro-a'].headers), data: { title: 'Invadido' } });
    expect(await ren.text()).not.toContain(ids.id);
    const del = await api.delete(rest(`agenda_calendars?id=eq.${ids.id}`), { headers: returning(as['membro-a'].headers) });
    expect(await del.text()).not.toContain(ids.id);
    await api.delete(`${SUPABASE_URL}/storage/v1/object/calendarios`, { headers: as['membro-a'].headers, data: { prefixes: [ids.path] } });
    expect((await sign('lider-a', ids.path)).ok()).toBe(true);
  });
});
