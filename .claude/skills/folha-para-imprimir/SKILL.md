---
name: folha-para-imprimir
description: Receita da folha para imprimir ou salvar em PDF do CC4 (como o Livro caixa) — folha A4 sempre clara, logo e nome da igreja no topo, espaço para assinaturas e rodapé só no papel, nome do PDF certo e teste com a impressão emulada. Use sempre que o usuário pedir para imprimir, gerar PDF, "salvar como PDF", mandar um relatório no grupo, ou melhorar o layout de impressão de uma tela (relatórios, aniversariantes, escalas, listas, recibos), mesmo que não diga "skill".
---

# Folha para imprimir ou salvar PDF

Feita no Livro caixa (PR #68, `drawAccountabilityMonth` em `js/app.js` e o bloco `.acc-*` em
`css/style.css`). Testado pelo usuário no celular: na tela fica bonita e, ao imprimir, sai uma folha A4
pronta para assinar ou mandar no grupo. Não precisa de biblioteca de PDF: o próprio navegador gera
(no celular, **Salvar como PDF** na tela de impressão).

**Pedido do usuário: a folha aparece primeiro na tela (prévia), e só depois imprime.** O botão de
imprimir de uma lista não chama `window.print()` direto: é um link para uma rota `…/imprimir` que
mostra a folha num cartão, com "← Voltar" e, embaixo, **Imprimir ou salvar PDF**. Na tela nova, use a
peça pronta `drawSheet({ back, backText, title, accent, sub, body, signs, file })` em `js/app.js`
(Aniversariantes: `viewBirthdaysSheet`; Relatórios: `viewReportSheet`), com o **mesmo nome de
guardado** da lista, para a prévia abrir na hora. As seções 1 a 3 abaixo explicam o que ela já faz.

## 1. HTML da tela

```js
$view.innerHTML = `
  <div class="page xx-page">
    <a href="#/voltar" class="back no-print">← Voltar</a>
    <article class="xx-sheet">
      <header class="xx-head">
        ${logo ? `<img class="xx-logo" src="${esc(logo)}" alt="" width="56" height="56">` : ''}
        <div>
          <p class="xx-church">${esc(state.church.name)}</p>
          <h1>Título <span>${esc(subtitulo)}</span></h1>
          <p class="xx-sub">Uma linha de contexto (quando foi publicado, por quem)</p>
        </div>
      </header>
      ...conteúdo...
      <div class="xx-signs">
        <div><span class="xx-line"></span>Função 1<small>Data: ____/____/________</small></div>
        <div><span class="xx-line"></span>Função 2<small>Data: ____/____/________</small></div>
      </div>
      <footer class="xx-foot">Gerado pelo app da ${esc(state.church.name)} em ${esc(hoje)}.</footer>
    </article>
    <div class="xx-actions no-print">
      <button type="button" class="btn primary big" id="print">${icon.print} Imprimir ou salvar PDF</button>
      <p class="hint">Sai numa folha A4. No celular, escolha <strong>Salvar como PDF</strong> para mandar no grupo.</p>
    </div>
  </div>`;
```

- Logo: `state.church.logo_url` (pode não ter; aí só some). `alt=""` porque o nome da igreja vem logo ao lado.
- Tudo que vem do banco passa por `esc()`, inclusive o nome da igreja e a URL da logo.
- Assinaturas: só a **função** (ex.: "Tesouraria", "Pastor(a) responsável"), sem nome de pessoa.
  Pergunte ao usuário quais funções assinam, se não der para deduzir.
- `no-print` (já existe em `css/style.css`) esconde no papel o que é da tela: voltar, avisos, botões.
  A barra de cima, as abas e o aviso (toast) já somem sozinhos.
- O botão é só para quem pode ver a tela; a regra de quem vê continua no banco (RLS ou função).

## 2. Nome do PDF

O navegador usa o título da página como nome do arquivo salvo. Troque e volte depois:

```js
document.getElementById('print').onclick = () => {
  const title = document.title;
  document.title = `Título - ${state.church.name} - ${subtitulo}`;
  window.addEventListener('afterprint', () => (document.title = title), { once: true });
  window.print();
};
```

## 3. CSS

Na tela, a folha é um cartão (`background: var(--surface)`, borda, `var(--radius)`, sombra), com as
cores do tema e da igreja (`--brand`, `--brand-soft`, `--link`). Assinaturas e rodapé escondidos:
`.xx-signs, .xx-foot { display: none; }`. Teste em 360 px: números longos com `white-space: nowrap` e
`font-variant-numeric: tabular-nums`; se não couber, a peça ocupa a linha toda
(`grid-column: 1 / -1` num `@media (max-width: 560px)`).

Para o papel:

```css
@page xx { size: A4; margin: 14mm 16mm; }
@media print {
  /* Sempre clara no papel, mesmo com o tema escuro no aparelho. */
  html:root:not(#imprimir) {
    --surface: #fff; --bg: #f3f4f8; --ink: #1b1e27; --muted: #555b6b; --line: #d6d9e2; --danger: #c92a2a;
    --link: var(--brand); --brand-soft: color-mix(in srgb, var(--brand) 10%, #fff);
  }
  html:root:not(#imprimir), html:root:not(#imprimir) body { background: #fff; }
  .xx-page { padding: 0; }
  .xx-sheet { page: xx; border: 0; border-radius: 0; box-shadow: none; padding: 0; font-size: 10pt; }
  .xx-sheet * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  /* blocos que não podem quebrar no meio */
  .xx-bloco { break-inside: avoid; }
  .xx-signs { display: grid; grid-template-columns: 1fr 1fr; gap: 14mm; margin-top: 14mm; break-inside: avoid; }
  .xx-signs > div { display: flex; flex-direction: column; align-items: center; font-weight: 600; }
  .xx-line { width: 100%; margin-bottom: 4px; border-top: 1px solid #000; }
  .xx-signs small { margin-top: 8px; color: var(--muted); font-weight: 400; }
  .xx-foot { display: block; margin-top: 6mm; color: var(--muted); font-size: 8pt; text-align: center; }
}
```

Os detalhes que custaram tentativas:

- **Tema escuro saía escuro no papel.** As variáveis do tema escuro têm seletor forte; só `:root`
  dentro do `@media print` perde. `html:root:not(#imprimir)` ganha de todas (nenhum elemento tem esse id).
- **Passava de uma página.** No papel, troque os espaços da tela por `mm` menores (cabeçalho, quadros,
  linhas da lista) e fixe as fontes em `pt`. Assinaturas e rodapé precisam caber na mesma folha.
- **Cores e barras sumiam** em alguns navegadores: `print-color-adjust: exact`.
- **Barras de proporção** (`<i style="--w:40%">`): o atributo `style` é permitido pela regra de
  segurança da página (CSP); script embutido não é. Mostre também o número ou a porcentagem, para ler
  em preto e branco.
- Use `@page` com nome (`page: xx`) para a margem valer só nesta folha e não mudar as outras impressões.
- **Folha de várias páginas** (Relatórios): `break-inside: avoid` numa seção inteira empurra a seção
  para a página seguinte e deixa a primeira só com o cabeçalho. Deixe a seção quebrar
  (`break-inside: auto`) e proteja só as peças de dentro (quadros, gráficos, linhas de tabela), com
  `break-after: avoid` nos títulos. Assinaturas e rodapé num invólucro com `break-inside: avoid`,
  senão o rodapé fica sozinho na última página. Tabelas largas: `white-space: normal` e fonte menor.

## 4. Teste

No spec da tela (veja "a tesouraria fecha e publica o mês" em tests/financeiro.spec.mjs):

```js
await expect(page.locator('.xx-signs')).toBeHidden();
await page.emulateMedia({ media: 'print' });
await expect(page.locator('.xx-signs')).toContainText('Função 1');
await expect(page.locator('.xx-foot')).toBeVisible();
await expect(page.getByRole('button', { name: 'Imprimir ou salvar PDF' })).toBeHidden();
await page.emulateMedia({ media: 'screen' });
```

Antes de abrir o PR, confira com os olhos: um script de Playwright no scratchpad que abre a tela,
tira foto no tema claro e no escuro (360 px) e gera `page.pdf({ format: 'A4', preferCSSPageSize: true })`.
Confira no PDF que saiu clara, com logo, assinaturas e rodapé, e sem página quase vazia (uma página
só, quando o conteúdo cabe). Depois de publicar, peça ao usuário para testar no celular em
**Imprimir ou salvar PDF** (na igreja de testes dele, o Vineyard).

## Peças prontas em js/app.js

Aniversariantes e Relatórios usam `drawSheet`, que junta as peças comuns `sheetHead(título, destaque,
linha)`, `sheetSigns([funções])`, `sheetFoot()` e `printAs(nome do PDF)`: página
`<div class="page sheet-page">`, folha `<article class="sheet">` e o CSS `.sheet-*` (bloco "Folha para
imprimir das outras telas" em css/style.css). Na prévia, assinaturas e rodapé aparecem também na tela.
Numa tela nova, use `drawSheet` em vez de copiar o prefixo `acc-` (o Livro caixa ficou com o
CSS próprio).

## Telas que ainda imprimem com o layout simples (candidatas)

QR Code de visitantes e etiqueta do Infantil usam só `window.print()`, com layout próprio (telão e
etiqueta). Só aplique esta folha quando o usuário pedir.
