// Funções puras do app, testadas sem navegador.
import { test, expect } from '@playwright/test';
import { slugify, isValidSlug, churchSlugFromPath, churchRestUrl, inkOn, readableOnWhite, darkPalette, contrastRatio, normalizeHex, normalizePhone, fmtPhone, esc, cardTokenFrom, linkify, fmtBytes } from '../js/util.js';
import { pixPayload, normalizePixKey, guessPixType, crc16, parseAmount } from '../js/pix.js';
import { cardSize, cardOptions, cardColor, cardFont, CARD_FONTS } from '../js/cartao.js';
import { existsSync } from 'node:fs';

test('cartão de aniversário: tamanho fixo, limites, cor e letras', () => {
  expect(cardSize(400, 200)).toEqual({ width: 1080, height: 540 });
  expect(cardSize(100, 1000).height).toBe(1620); // muito comprida: corta em 1,5
  expect(cardSize(1000, 100).height).toBe(540); // muito achatada: corta em 0,5
  expect(cardOptions({ x: 150, width: 5, size: 999 })).toEqual({ x: 100, y: 50, width: 30, size: 250 });
  expect(cardColor('escuro')).toBe('#1b1e27');
  expect(cardColor('nada')).toBe('#ffffff');
  expect(cardFont('desconhecida').title).toBe(700);
  // Toda letra da lista tem o arquivo em fonts/cartao/ (o envio das 7h e o app usam os mesmos).
  for (const f of Object.values(CARD_FONTS)) {
    for (const file of Object.values(f.files || {})) expect(existsSync(new URL(`../fonts/cartao/${file}`, import.meta.url)), file).toBe(true);
  }
});

test('endereço da igreja a partir do nome', () => {
  expect(slugify('Igreja Batista Central')).toBe('igreja-batista-central');
  expect(slugify('  Comunidade Cristã São João!  ')).toBe('comunidade-crista-sao-joao');
  expect(slugify('A'.repeat(60))).toHaveLength(40);
  expect(isValidSlug('exemplo')).toBe(true);
  for (const bad of ['ab', 'Exemplo', 'com espaço', '-inicio', 'fim-', 'dois--hifens', 'a'.repeat(41)]) {
    expect(isValidSlug(bad), bad).toBe(false);
  }
});

test('igreja da página pelo caminho', () => {
  expect(churchSlugFromPath('/i/exemplo/')).toBe('exemplo');
  expect(churchSlugFromPath('/repositorio/i/batista-central/')).toBe('batista-central');
  expect(churchSlugFromPath('/repositorio/i/exemplo/index.html')).toBe('exemplo');
  expect(churchSlugFromPath('/repositorio/')).toBe(null);
  expect(churchSlugFromPath('/i/')).toBe(null);
});

// O preload da página da igreja (scripts/build-site.mjs) e o app (loadChurch) usam este endereço:
// sem cabeçalhos, com a chave pública nele, para o navegador aproveitar a mesma resposta.
test('endereço da igreja no banco, igual no preload e no app', () => {
  expect(churchRestUrl('https://x.supabase.co', 'sb_publishable_abc', 'batista-central')).toBe(
    'https://x.supabase.co/rest/v1/churches?select=*&slug=eq.batista-central&apikey=sb_publishable_abc',
  );
});

test('texto legível sobre a cor da igreja', () => {
  expect(inkOn('#3b5bdb')).toBe('#ffffff');
  expect(inkOn('#ffd43b')).toBe('#111111');
  expect(readableOnWhite('#3b5bdb')).toBe(true);
  expect(readableOnWhite('#ffe066')).toBe(false);
  // Escuro com a cor principal: a cor da Reformada fica como está; amarelo escurece para o texto claro ler.
  expect(normalizeHex('2C3666')).toBe('#2c3666');
  expect(normalizeHex(' #abc ')).toBe('#aabbcc');
  expect(normalizeHex('#12')).toBeNull();
  expect(normalizeHex('azul')).toBeNull();
  expect(darkPalette('#2c3666').bg).toBe('#2c3666');
  expect(contrastRatio(darkPalette('#ffd43b').bg, '#eceef4')).toBeGreaterThanOrEqual(7);
  expect(contrastRatio(darkPalette('#2b8a3e').accent, darkPalette('#2b8a3e').bg)).toBeGreaterThanOrEqual(4.5);
});

test('telefone no formato do banco', () => {
  expect(normalizePhone('(61) 99999-8888')).toBe('5561999998888');
  expect(normalizePhone('61 3333-4444')).toBe('556133334444');
  expect(normalizePhone('+55 61 99999-8888')).toBe('5561999998888');
  expect(normalizePhone('9999')).toBe(null);
  expect(fmtPhone('5561999998888')).toBe('(61) 99999-8888');
});

test('textos escapados antes de ir para a tela', () => {
  expect(esc('<img src=x onerror="alert(1)">')).toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('datas de nascimento digitadas de vários jeitos', async () => {
  const { parseBirthDate, fmtDate } = await import('../js/util.js');
  const today = new Date('2026-10-25T12:00:00Z');
  expect(parseBirthDate('15/03/1980', today)).toBe('1980-03-15');
  expect(parseBirthDate('5/3/80', today)).toBe('1980-03-05');
  expect(parseBirthDate('01-02-05', today)).toBe('2005-02-01');
  expect(parseBirthDate('1980-03-15', today)).toBe('1980-03-15');
  expect(parseBirthDate('29/02/2000', today)).toBe('2000-02-29');
  for (const bad of ['29/02/2001', '32/01/1990', '15/13/1990', '01/01/1899', '01/01/2030', 'ontem', '']) {
    expect(parseBirthDate(bad, today), bad).toBe(null);
  }
  expect(fmtDate('1980-03-15')).toBe('15/03/1980');
});

test('planilha CSV do Excel e do Google Planilhas', async () => {
  const { parseCsv } = await import('../js/util.js');
  expect(parseCsv('﻿nome;email\r\nAna;ana@x.com\r\n\r\n')).toEqual([['nome', 'email'], ['Ana', 'ana@x.com']]);
  expect(parseCsv('nome,obs\n"Silva, João","disse ""oi""\nem duas linhas"')).toEqual([
    ['nome', 'obs'],
    ['Silva, João', 'disse "oi"\nem duas linhas'],
  ]);
  expect(parseCsv('nome\tidade\nAna\t30')).toEqual([['nome', 'idade'], ['Ana', '30']]);
});

test('importação de membros: colunas, erros e repetidos', async () => {
  const { parseMembersCsv } = await import('../js/util.js');
  const csv = [
    'Nome Completo;E-mail;Celular;Data de Nascimento',
    'Maria  da Silva;MARIA@x.com;(61) 99999-0000;15/03/1980',
    'J;joao@;123;31/02/1990',
    'Pedro;maria@x.com;;',
    'Ana;ana@igreja.com;;',
  ].join('\n');
  const { rows, error } = parseMembersCsv(csv, new Set(['ana@igreja.com']), new Date('2026-10-25'));
  expect(error).toBeUndefined();
  expect(rows[0]).toEqual({ line: 2, name: 'Maria da Silva', email: 'maria@x.com', phone: '5561999990000', birth_date: '1980-03-15', wedding_date: null, baptism_date: null, errors: [], skip: null });
  expect(rows[1].errors).toEqual(['nome inválido', 'e-mail inválido', 'telefone inválido', 'data de nascimento inválida']);
  expect(rows[2].skip).toBe('e-mail repetido na planilha');
  expect(rows[3].skip).toBe('já cadastrado');
  expect(parseMembersCsv('email;telefone\na@b.com;1').error).toMatch(/coluna "nome"/);
});

test('mensagem de aniversário com os campos da igreja', async () => {
  const { renderMessage, joinNames } = await import('../js/util.js');
  const data = { name: 'Maria  da Silva', church: 'Igreja Exemplo', age: 40 };
  expect(renderMessage('Feliz aniversário, {primeiro_nome}!', data)).toBe('Feliz aniversário, Maria!');
  expect(renderMessage('{nome} faz {idade} anos na {igreja}. {outro}', data)).toBe('Maria da Silva faz 40 anos na Igreja Exemplo. {outro}');
  expect(renderMessage('Parabéns da {instituicao}!', data)).toBe('Parabéns da Igreja Exemplo!'); // o campo novo; {igreja} continua valendo
  expect(renderMessage('Parabéns {primeiro_nome} {idade}', { name: 'Ana', church: 'X' })).toBe('Parabéns Ana');
  expect(renderMessage('Hoje você completa {anos} de casamento!', { ...data, age: 10 })).toBe('Hoje você completa 10 anos de casamento!');
  expect(renderMessage('{anos} de batismo', { ...data, age: 1 })).toBe('1 ano de batismo');
  expect(joinNames(['Ana Souza'])).toBe('Ana');
  expect(joinNames(['Ana Souza', 'João', 'Maria Clara'])).toBe('Ana, João e Maria');
});

test('adicionar à agenda: arquivo .ics e link do Google Agenda', async () => {
  const { icsForEvent, googleCalendarUrl } = await import('../js/util.js');
  const ev = {
    event_id: 'abc',
    title: 'Culto de domingo, com Santa Ceia',
    description: 'Traga a família',
    location: 'Templo; salão principal',
    starts_at: '2027-03-14T22:00:00Z',
    ends_at: null,
    repeat_weekly: true,
    repeat_until: '2027-12-31',
    remind_minutes: 120,
  };
  const opts = { church: 'Igreja Exemplo', url: 'https://x/i/exemplo/', now: new Date('2027-01-01T00:00:00Z') };
  const ics = icsForEvent(ev, opts);
  expect(ics).toContain('DTSTART:20270314T220000Z\r\n');
  expect(ics).toContain('DTEND:20270315T000000Z\r\n');
  expect(ics).toContain('RRULE:FREQ=WEEKLY;UNTIL=20271231T235959Z\r\n');
  expect(ics).toContain('SUMMARY:Culto de domingo\\, com Santa Ceia\r\n');
  expect(ics).toContain('LOCATION:Templo\\; salão principal\r\n');
  expect(ics).toContain('TRIGGER:-PT120M');
  expect(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);

  const g = new URL(googleCalendarUrl(ev, opts));
  expect(g.searchParams.get('dates')).toBe('20270314T220000Z/20270315T000000Z');
  expect(g.searchParams.get('recur')).toBe('RRULE:FREQ=WEEKLY;UNTIL=20271231T235959Z');
  const once = icsForEvent({ ...ev, repeat_weekly: false, repeat_until: null, remind_minutes: 0, location: null }, opts);
  expect(once).not.toContain('RRULE');
  expect(once).not.toContain('VALARM');
  expect(once).not.toContain('LOCATION');
});

test.describe('Pix (BR Code)', () => {
  test('gera exatamente o exemplo do manual do Banco Central', () => {
    expect(pixPayload({ key: '123e4567-e12b-12d1-a456-426655440000', name: 'Fulano de Tal', city: 'BRASILIA' })).toBe(
      '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D',
    );
  });

  test('inclui o valor e remove acentos do nome e da cidade', () => {
    const p = pixPayload({ key: '+5561999998888', name: 'Comunidade Cristã São João', city: 'Brasília', amount: 150.5 });
    expect(p).toContain('5406150.50');
    expect(p).toContain('5925Comunidade Crista Sao Joa');
    expect(p).toContain('6008Brasilia');
    expect(p.slice(-4)).toBe(crc16(p.slice(0, -4)));
  });

  test('sem valor, quem oferta digita no banco', () => {
    expect(pixPayload({ key: 'a@b.com', name: 'X', amount: 0 })).not.toContain('5406');
  });

  test('normaliza e valida chaves', () => {
    expect(normalizePixKey('celular', '(61) 99999-8888')).toBe('+5561999998888');
    expect(normalizePixKey('celular', '+55 61 99999-8888')).toBe('+5561999998888');
    expect(normalizePixKey('cpf', '12.345.678/0001-90')).toBe('12345678000190');
    expect(normalizePixKey('email', ' Igreja@Mail.com ')).toBe('igreja@mail.com');
    expect(normalizePixKey('aleatoria', '123E4567-E12B-12D1-A456-426655440000')).toBe('123e4567-e12b-12d1-a456-426655440000');
    expect(normalizePixKey('cpf', '123')).toBeNull();
    expect(normalizePixKey('email', 'sem-arroba')).toBeNull();
    expect(guessPixType('+5561999998888')).toBe('celular');
    expect(guessPixType('12345678000190')).toBe('cpf');
  });

  test('valor digitado em reais', () => {
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('50')).toBe(50);
    expect(parseAmount('50,5')).toBe(50.5);
    expect(parseAmount('R$ 1.234,56')).toBe(1234.56);
    expect(parseAmount('10.5')).toBe(10.5);
    expect(parseAmount('1.234')).toBe(1234);
    for (const bad of ['abc', '-5', '0', '1,234', '12,345', '1.23.4']) expect(parseAmount(bad), bad).toBeNull();
  });
});

test('rota até o local: pelo alfinete ou pelo endereço; on-line não tem rota', async () => {
  const { routeLinks, placeBlock } = await import('../js/map.js');
  expect(routeLinks({ lat: -15.7942, lng: -47.8822, address: 'Templo' })).toEqual({
    google: 'https://www.google.com/maps/dir/?api=1&destination=-15.7942,-47.8822',
    waze: 'https://waze.com/ul?ll=-15.7942,-47.8822&navigate=yes',
  });
  expect(routeLinks({ lat: null, lng: null, address: 'Rua das Flores, 10' })).toEqual({
    google: 'https://www.google.com/maps/dir/?api=1&destination=Rua%20das%20Flores%2C%2010',
    waze: 'https://waze.com/ul?q=Rua%20das%20Flores%2C%2010&navigate=yes',
  });
  expect(placeBlock({ lat: null, lng: null, address: 'On-line' })).toBe('');
  expect(placeBlock({ lat: null, lng: null, address: '' })).toBe('');
  expect(placeBlock({ lat: null, lng: null, address: 'Templo' })).not.toContain('place-map');
  expect(placeBlock({ lat: 1, lng: 2, address: '' })).toContain('data-lat="1"');
});

test('regras de segurança das páginas (CSP): os scripts do 404.html batem com a impressão digital', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const page = readFileSync(new URL('../404.html', import.meta.url), 'utf8');
  const csp = page.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  for (const [, code] of page.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    expect(csp).toContain(`'sha256-${createHash('sha256').update(code).digest('base64')}'`);
  }
  const index = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  expect(index).toMatch(/http-equiv="Content-Security-Policy"[^>]*object-src 'none'/);
  expect(index).not.toMatch(/<script>(?!\s*<\/script>)/); // nenhum script escrito dentro da página
  // Nem comandos no HTML das telas (onclick="..."): a CSP bloquearia.
  for (const file of ['app.js', 'map.js', 'install.js', 'push.js', 'pix.js']) {
    const code = readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
    expect(code, file).not.toMatch(/\son[a-z]+="/);
  }
});

// Telas que abrem na hora (.claude/skills/tela-instantanea): cada tela do app da igreja que busca
// dados no banco desenha primeiro com o que está guardado. As que não usam o guardado ficam
// nesta lista, com o motivo, e não podem esperar o banco antes de aparecer.
const SEM_GUARDADO = {
  viewChurchHome: 'os cartões do Início usam homeCard, cada um com o seu guardado',
  viewLogin: 'só o formulário de entrar',
  viewMenu: 'só links',
  viewChurchPrivacy: 'textos da igreja já carregados',
  viewMyData: 'o banco só é chamado ao tocar nos botões',
  viewHelp: 'só textos',
  viewOffer: 'chave Pix da igreja já carregada',
  viewCardVerify: 'conferência pública da carteirinha: sempre pergunta ao banco (mostra "Conferindo…" antes)',
};
const CACHE = /\b(screenShow|screenShowWithPhotos|showWithGalleryLinks|editItem|formFresh|screenCached)\(|membersCache\.get\(/;

test('toda tela nova abre na hora: usa o guardado ou está na lista das que não buscam nada antes de aparecer', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  const start = app.indexOf('const churchRoutes = [');
  const routes = app.slice(start, app.indexOf('];', start));
  const views = [...new Set([...routes.matchAll(/, (view\w+)\]/g)].map((m) => m[1]))];
  expect(views.length).toBeGreaterThan(30);
  const bodyOf = (name) => {
    const from = app.search(new RegExp(`\\n(async )?function ${name}\\(`));
    expect(from, name).toBeGreaterThan(0);
    const rest = app.slice(from + 1);
    const end = rest.search(/\n(async )?function |\nconst |\nlet /);
    return rest.slice(0, end);
  };
  for (const name of views) {
    const body = bodyOf(name);
    if (CACHE.test(body)) {
      expect(SEM_GUARDADO[name], `${name} usa o guardado: tire da lista SEM_GUARDADO`).toBeUndefined();
      continue;
    }
    expect(SEM_GUARDADO[name], `${name} não usa o guardado (screenShow, editItem…): veja .claude/skills/tela-instantanea`).toBeTruthy();
    // Nada de esperar o banco antes de desenhar.
    const firstDraw = body.indexOf('$view.innerHTML');
    const beforeDraw = firstDraw < 0 ? body : body.slice(0, firstDraw);
    expect(beforeDraw, `${name} espera o banco antes de aparecer`).not.toMatch(/await (sb\.|load|fetch|screenFetch)/);
  }
  for (const name of Object.keys(SEM_GUARDADO)) expect(views, `${name} não é mais uma tela`).toContain(name);
});

test('horários usam as listas de hora e minutos, não a janela de horas do celular', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
  // No Android, a janela do <input type="time"> corta o botão "Definir" com letra grande.
  expect(app).not.toMatch(/type="(time|datetime-local)"/);
});

test('perguntas usam a janela do app (ask), não a do navegador, que mostra o endereço do site', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  for (const file of readdirSync(new URL('../js/', import.meta.url)).filter((f) => f.endsWith('.js'))) {
    const code = readFileSync(new URL(`../js/${file}`, import.meta.url), 'utf8');
    expect(code.match(/(?<![.\w])(confirm|prompt|alert)\(/g), file).toBeNull();
  }
});


test('links do chat: só http e https viram link; o resto é texto escapado', () => {
  expect(linkify('Veja https://exemplo.com/a?b=1.')).toBe('Veja <a href="https://exemplo.com/a?b=1" target="_blank" rel="noopener noreferrer nofollow">https://exemplo.com/a?b=1</a>.');
  expect(linkify('www.escola.com.br')).toContain('href="https://www.escola.com.br"');
  expect(linkify('javascript:alert(1) <b>oi</b>')).toBe('javascript:alert(1) &lt;b&gt;oi&lt;/b&gt;');
  expect(linkify('https://x.com/"><script>')).not.toContain('<script>');
  expect(linkify('(https://a.com)')).toContain('>https://a.com</a>)');
  expect(fmtBytes(5000)).toBe('5 KB');
  expect(fmtBytes(3355443)).toBe('3,2 MB');
});
