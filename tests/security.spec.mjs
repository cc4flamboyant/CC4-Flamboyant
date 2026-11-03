// Regras de segurança do banco, testadas como um visitante sem login.
// Se alguém afrouxar uma regra do Supabase por engano, a publicação para aqui.
// (Os testes com duas igrejas e usuários logados chegam na próxima entrega.)
import { test, expect } from '@playwright/test';
import { SUPABASE_URL, ANON_KEY, headers, rest, configured } from './helpers.mjs';

const UUID = '00000000-0000-0000-0000-000000000000';
const rpc = (request, fn, data = {}) => request.post(rest(`rpc/${fn}`), { headers, data });
const storageHeaders = { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` };
const exemploId = async (request) => (await (await request.get(rest('churches?select=id&slug=eq.exemplo'), { headers })).json())[0].id;

test.beforeEach(() => test.skip(!configured, 'Falta a chave pública em js/config.js'));

test.describe('Banco: visitante sem login', () => {
  test('não lê membros nem administradores da plataforma', async ({ request }) => {
    for (const table of ['members', 'platform_admins']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      expect(res.ok(), table).toBe(false);
    }
  });

  test('vê só as igrejas ativas', async ({ request }) => {
    const res = await request.get(rest('churches?select=slug,active'), { headers });
    expect(res.ok()).toBe(true);
    const rows = await res.json();
    expect(rows.some((r) => r.slug === 'exemplo')).toBe(true);
    expect(rows.every((r) => r.active)).toBe(true);
  });

  test('não cria, não altera e não apaga igrejas', async ({ request }) => {
    // O administrador pode renomear a Igreja Exemplo; o que importa é o visitante não conseguir.
    const nameNow = async () => (await (await request.get(rest('churches?select=name&slug=eq.exemplo'), { headers })).json())[0]?.name;
    const before = await nameNow();
    expect(before).toBeTruthy();
    const created = await request.post(rest('churches'), { headers, data: { slug: 'invasora', name: 'Invasora' } });
    expect(created.ok()).toBe(false);
    const write = { headers: { ...headers, Prefer: 'return=representation' } };
    const changed = await request.patch(rest('churches?slug=eq.exemplo'), { ...write, data: { name: 'Hackeada' } });
    if (changed.ok()) expect(await changed.json()).toEqual([]);
    const removed = await request.delete(rest('churches?slug=eq.exemplo'), write);
    if (removed.ok()) expect(await removed.json()).toEqual([]);
    expect(await nameNow()).toBe(before);
  });

  test('não cadastra membros', async ({ request }) => {
    const res = await request.post(rest('members'), { headers, data: { church_id: await exemploId(request), name: 'Intruso' } });
    expect(res.ok()).toBe(false);
  });

  test('não chama as funções de administração nem de convite', async ({ request }) => {
    expect((await rpc(request, 'create_church', { p_slug: 'invasora', p_name: 'Invasora', p_admin_email: 'a@b.com' })).ok()).toBe(false);
    expect((await rpc(request, 'set_church_admin', { p_church: UUID, p_email: 'a@b.com' })).ok()).toBe(false);
    expect((await rpc(request, 'set_church_active', { p_church: UUID, p_active: false })).ok()).toBe(false);
    expect((await rpc(request, 'link_my_account')).ok()).toBe(false);
    expect((await rpc(request, 'respond_to_church', { p_church: UUID, p_accept: true })).ok()).toBe(false);
  });

  test('não é administrador da plataforma e não pertence a nenhuma igreja', async ({ request }) => {
    expect(await (await rpc(request, 'is_platform_admin')).json()).toBe(false);
    expect(await (await rpc(request, 'my_church_ids')).json()).toEqual([]);
  });

  test('não envia arquivos para as pastas das igrejas', async ({ request }) => {
    const church = await exemploId(request);
    // Formato aceito por cada pasta: a recusa precisa ser por falta de permissão.
    for (const [bucket, type] of [['igrejas', 'image/png'], ['membros', 'image/webp']]) {
      const res = await request.post(`${SUPABASE_URL}/storage/v1/object/${bucket}/${church}/teste`, {
        headers: { ...storageHeaders, 'Content-Type': type },
        data: Buffer.from('89504e470d0a1a0a', 'hex'),
      });
      expect(res.ok(), bucket).toBe(false);
      expect(await res.text(), bucket).not.toMatch(/mime/i);
    }
  });

  test('não lista as fotos dos membros', async ({ request }) => {
    const res = await request.post(`${SUPABASE_URL}/storage/v1/object/list/membros`, {
      headers: { ...storageHeaders, 'Content-Type': 'application/json' },
      data: { prefix: `${await exemploId(request)}/`, limit: 10 },
    });
    if (res.ok()) expect(await res.json()).toEqual([]);
  });
});

test.describe('Banco: visitante sem login (aniversários)', () => {
  test('não dispara envios nem lê aparelhos, modelos e registros', async ({ request }) => {
    for (const fn of ['claim_birthday_push', 'claim_birthday_email', 'claim_leader_summaries', 'platform_push_targets', 'birthday_email_backlog', 'clean_message_log']) {
      expect((await rpc(request, fn, { p_secret: 'errada' })).ok(), fn).toBe(false);
    }
    expect((await rpc(request, 'mark_message_failed', { p_secret: 'errada', p_log_id: 1 })).ok()).toBe(false);
    expect((await rpc(request, 'forget_push_subscription', { p_secret: 'errada', p_endpoint: 'https://x' })).ok()).toBe(false);
    expect((await rpc(request, 'save_push_subscription', { p_endpoint: 'https://x', p_p256dh: 'a', p_auth: 'b' })).ok()).toBe(false);
    expect((await rpc(request, 'birthdays_between', { p_church: UUID, p_from: '2027-01-01', p_to: '2027-01-31' })).ok()).toBe(false);
    for (const fn of ['claim_event_reminders', 'claim_announcement_push', 'deliver_birthday_notifications', 'clean_notifications']) {
      expect((await rpc(request, fn, { p_secret: 'errada' })).ok(), fn).toBe(false);
    }
    for (const fn of ['deliver_child_birthday_notifications', 'claim_child_birthday_push']) {
      expect((await rpc(request, fn, { p_secret: 'errada' })).ok(), fn).toBe(false);
    }
    expect((await rpc(request, 'mark_child_birthday_failed', { p_secret: 'errada', p_log_id: 1 })).ok()).toBe(false);
    expect((await rpc(request, 'child_birthday_candidates', { p_day: '2026-01-01' })).ok()).toBe(false);
    expect((await rpc(request, 'events_between', { p_church: UUID, p_from: '2027-01-01T00:00:00Z', p_to: '2027-01-31T00:00:00Z' })).ok()).toBe(false);
    for (const fn of ['export_my_data', 'delete_my_account']) expect((await rpc(request, fn)).ok(), fn).toBe(false);
    // O relógio (007) usa a chave do GitHub: nada dele pode ser chamado de fora.
    for (const fn of ['github_dispatch', 'churches_publish']) {
      expect((await rpc(request, fn, { p_workflow: 'deploy.yml' })).ok(), fn).toBe(false);
    }
    const privateSchema = await request.post(rest('rpc/github_dispatch'), {
      headers: { ...headers, 'Content-Profile': 'private' },
      data: { p_workflow: 'deploy.yml' },
    });
    expect(privateSchema.ok()).toBe(false);
    expect((await rpc(request, 'leave_church', { p_church: UUID })).ok()).toBe(false);
    for (const table of ['push_subscriptions', 'message_log', 'message_templates', 'events', 'event_reminders_sent', 'announcements', 'notifications']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      if (res.ok()) expect(await res.json(), table).toEqual([]);
    }
  });
});

test.describe('Banco: visitante sem login (carteirinha)', () => {
  test('não troca códigos; a conferência só responde pelo código exato', async ({ request }) => {
    expect((await rpc(request, 'rotate_card_token', { p_church: UUID })).ok()).toBe(false);
    expect((await rpc(request, 'cards_on', { p_church: UUID })).ok()).toBe(false);
    expect((await rpc(request, 'members_since_guard')).ok()).toBe(false);
    const res = await rpc(request, 'verify_member_card', { p_token: UUID });
    expect(res.ok(), await res.text()).toBe(true);
    expect(await res.json()).toEqual([]);
    // Sem login, a tabela de membros (e os códigos) continua fechada.
    expect((await request.get(rest('members?select=card_token'), { headers })).ok()).toBe(false);
  });
});

test.describe('Banco: visitante sem login (galeria)', () => {
  test('não lê álbuns, fotos nem arquivos; não registra nem pede retirada', async ({ request }) => {
    for (const table of ['gallery_albums', 'gallery_photos', 'gallery_removal_requests']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      if (res.ok()) expect(await res.json(), table).toEqual([]);
    }
    expect((await request.post(rest('gallery_albums'), { headers, data: { church_id: UUID, title: 'Intruso' } })).ok()).toBe(false);
    const calls = {
      gallery_album_list: { p_church: UUID },
      gallery_add_photo: { p_album: UUID, p_ext: 'webp' },
      gallery_request_removal: { p_photo: UUID },
      can_gallery: { p_church: UUID },
    };
    for (const [fn, data] of Object.entries(calls)) expect((await rpc(request, fn, data)).ok(), fn).toBe(false);
    expect((await rpc(request, 'gallery_albums_guard')).ok()).toBe(false);
    const list = await request.post(`${SUPABASE_URL}/storage/v1/object/list/galeria`, { headers: storageHeaders, data: { prefix: '', limit: 10 } });
    if (list.ok()) expect(await list.json()).toEqual([]);
    const up = await request.post(`${SUPABASE_URL}/storage/v1/object/galeria/${UUID}/x.webp`, {
      headers: { ...storageHeaders, 'Content-Type': 'image/webp' },
      data: Buffer.from('52494646', 'hex'),
    });
    expect(up.ok()).toBe(false);
  });
});

test.describe('Banco: visitante sem login (chat, 020)', () => {
  test('não lê grupos, participantes, mensagens nem anexos; não envia nada', async ({ request }) => {
    for (const table of ['chat_groups', 'chat_members', 'chat_messages']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      if (res.ok()) expect(await res.json(), table).toEqual([]);
    }
    expect((await request.post(rest('chat_messages'), { headers, data: { group_id: UUID, church_id: UUID, body: 'Intruso' } })).ok()).toBe(false);
    const calls = {
      chat_group_list: { p_church: UUID },
      chat_group_members: { p_group: UUID },
      chat_candidates: { p_church: UUID },
      chat_create_group: { p_church: UUID, p_name: 'Intruso', p_description: null, p_locked: false, p_members: [] },
      chat_add_members: { p_group: UUID, p_members: [] },
      chat_remove_member: { p_group: UUID, p_member: UUID },
      chat_set_admin: { p_group: UUID, p_member: UUID, p_on: true },
      chat_send: { p_group: UUID, p_body: 'Intruso' },
      chat_file_ready: { p_message: UUID },
      chat_mark_read: { p_group: UUID },
      chat_storage_used: { p_church: UUID },
      chat_is_in: { p_group: UUID },
    };
    for (const [fn, data] of Object.entries(calls)) expect((await rpc(request, fn, data)).ok(), fn).toBe(false);
    // O aviso no celular pede a senha do envio.
    expect((await rpc(request, 'claim_chat_push', { p_secret: 'errada', p_message: UUID })).ok()).toBe(false);
    const list = await request.post(`${SUPABASE_URL}/storage/v1/object/list/chat`, { headers: storageHeaders, data: { prefix: '', limit: 10 } });
    if (list.ok()) expect(await list.json()).toEqual([]);
    const up = await request.post(`${SUPABASE_URL}/storage/v1/object/chat/${UUID}/${UUID}/x.txt`, {
      headers: { ...storageHeaders, 'Content-Type': 'text/plain' },
      data: Buffer.from('oi'),
    });
    expect(up.ok()).toBe(false);
  });
});

test.describe('Banco: visitante sem login (projetos das salas, 021)', () => {
  test('não lê projetos, etapas, arquivos nem comentários; não grava nada', async ({ request }) => {
    for (const table of ['room_projects', 'project_steps', 'project_files', 'project_comments']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      if (res.ok()) expect(await res.json(), table).toEqual([]);
    }
    expect((await request.post(rest('room_projects'), { headers, data: { room_id: UUID, church_id: UUID, title: 'Intruso' } })).ok()).toBe(false);
    const calls = {
      projects_list: { p_church: UUID },
      project_comment_list: { p_project: UUID },
      project_comment: { p_project: UUID, p_body: 'Intruso' },
      project_add_file: { p_project: UUID, p_name: 'x.txt', p_type: 'text/plain', p_size: 1, p_ext: 'txt' },
      project_file_ready: { p_file: UUID },
      sees_room_projects: { p_room: UUID },
      chat_icon_ok: { p_group: UUID, p_path: 'x' },
    };
    for (const [fn, data] of Object.entries(calls)) expect((await rpc(request, fn, data)).ok(), fn).toBe(false);
    const list = await request.post(`${SUPABASE_URL}/storage/v1/object/list/projetos`, { headers: storageHeaders, data: { prefix: '', limit: 10 } });
    if (list.ok()) expect(await list.json()).toEqual([]);
  });
});

test.describe('Banco: visitante sem login (calendário do ano, 023)', () => {
  test('não lê nem envia calendários', async ({ request }) => {
    const res = await request.get(rest('agenda_calendars?select=*'), { headers });
    if (res.ok()) expect(await res.json()).toEqual([]);
    const calls = {
      agenda_calendar_add: { p_church: UUID, p_year: 2026, p_title: 'x', p_type: 'application/pdf', p_size: 1, p_ext: 'pdf' },
      agenda_calendar_ready: { p_calendar: UUID },
      agenda_on: { p_church: UUID },
    };
    for (const [fn, data] of Object.entries(calls)) expect((await rpc(request, fn, data)).ok(), fn).toBe(false);
    const list = await request.post(`${SUPABASE_URL}/storage/v1/object/list/calendarios`, { headers: storageHeaders, data: { prefix: '', limit: 10 } });
    if (list.ok()) expect(await list.json()).toEqual([]);
  });
});

// Teste de vulnerabilidade (016): funções de gatilho e de cálculo ficam fora do alcance de quem não
// está logado. As das regras de leitura continuam (respondem "não" para quem não está logado).
test.describe('Banco: visitante sem login (funções que ele não usa, 016)', () => {
  test('não chama funções de gatilho nem de cálculo', async ({ request }) => {
    const calls = {
      announcements_guard: {},
      churches_touch: {},
      members_guard: {},
      email_daily_limit: {},
      gallery_limit: {},
      today_br: {},
      is_birthday: { p_birth: '2000-01-01', p_day: '2026-01-01' },
      years_text: { p_years: 3 },
      render_template: { p_text: 'Olá', p_name: 'x', p_church: 'y', p_age: 1 },
      social_links_ok: { p: {} },
      push_endpoint_ok: { p: 'https://x' },
    };
    for (const [fn, data] of Object.entries(calls)) expect((await rpc(request, fn, data)).ok(), fn).toBe(false);
    // As usadas nas regras de leitura continuam, e respondem "não".
    expect(await (await rpc(request, 'is_platform_admin')).json()).toBe(false);
  });
});

test.describe('Banco: visitante sem login (salas)', () => {
  test('não lê crianças, salas, aulas, presenças nem avisos; não chama as funções', async ({ request }) => {
    for (const table of ['children', 'kids_rooms', 'room_children', 'room_sessions', 'room_attendance', 'room_messages']) {
      const res = await request.get(rest(`${table}?select=*`), { headers });
      if (res.ok()) expect(await res.json(), table).toEqual([]);
    }
    expect((await request.post(rest('children'), { headers, data: { church_id: UUID, name: 'Intruso', guardian_name: 'X' } })).ok()).toBe(false);
    const calls = {
      rooms_list: { p_church: UUID },
      room_roster: { p_room: UUID },
      room_assign: { p_child: UUID, p_room: UUID },
      room_session_save: { p_room: UUID, p_day: '2026-01-01' },
      room_mark: { p_room: UUID, p_day: '2026-01-01', p_child: UUID, p_present: true },
      room_notify: { p_room: UUID, p_title: 'Oi', p_body: '' },
      clean_kids: { p_secret: 'errada' },
      gallery_set_publisher: { p_member: UUID, p_on: true },
    };
    for (const [fn, data] of Object.entries(calls)) expect((await rpc(request, fn, data)).ok(), fn).toBe(false);
  });
});
