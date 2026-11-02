---
name: tela-instantanea
description: Regras para toda tela nova (ou mudada) do CC4 abrir na hora, sem esperar o banco. Use sempre que criar ou alterar uma tela, rota, lista, detalhe ou formulário em js/app.js, ou um cartão do Início.
---

# Tela instantânea

Premissa do usuário: **ao tocar num ícone ou link, a tela abre na hora**. Toda tela que busca dados no
banco desenha primeiro com o que ficou guardado da última vez e só redesenha se o banco trouxer algo
diferente. O teste `toda tela nova abre na hora` (tests/units.spec.mjs) reprova a tela que esquecer isso.

## Como fazer, por tipo de tela

**Lista ou detalhe** — `screenShow` (ou `screenShowWithPhotos`, se tiver fotos de membros):

```js
async function loadCoisas() {
  const { data, error } = await sb.from('coisas').select('id, titulo').eq('church_id', state.church.id);
  if (error) throw error;
  return data;
}

async function viewCoisas(ctx) {
  if (!requireMemberFeature('/coisas', 'coisas')) return;
  await screenShow(ctx, 'coisas', loadCoisas, drawCoisas);
}

function drawCoisas(rows) {
  $view.innerHTML = `...`; // só desenha; pode ser chamada duas vezes (guardado e banco)
}
```

- O nome do guardado (`'coisas'`) é por tela; para um item, use `'coisa:<id>'`.
- O `draw` recebe só os dados e não busca nada. Ligue os botões dentro dele.
- O guardado pode ser de ontem: filtre no `draw` o que depende da data de hoje (avisos vencidos,
  devocional agendado etc.).
- Detalhe que vem de uma lista: se o item já está no guardado da lista e o detalhe ainda não tem
  guardado próprio, semeie com `screenUpdate('coisa:<id>', item)` antes do `screenShow` (veja
  `viewDevotional`).

**Formulário de edição** — `editItem`, com o item que já veio na lista:

```js
const item = await editItem(ctx, screenCached('coisas')?.find((x) => x.id === id), () => loadCoisa(id), () => screenForget('coisas'));
```

Formulário de configuração que já tem os dados em `state` (ex.: a igreja): `formFresh`.

**Cartão do Início** — `homeCard(el, nome, fetcher, html, changed)`, usando o mesmo nome de guardado
da tela completa (assim as duas abrem na hora).

**Tela muito usada** — acrescente a busca em `prefetchScreens()` (roda em segundo plano no Início),
dentro do `featureOn(...)` da funcionalidade.

## Depois de mudar dados

- A própria tela mudou algo e já sabe o resultado (ex.: "Li", "Amém", "Estou orando"): atualize o
  objeto e chame `screenUpdate(nome, dados)`. Não redesenhe esperando o banco.
- Criou, editou ou apagou por um formulário: `screenForget(nome)` de cada guardado afetado (lista e
  item), e navegue. A próxima abertura espera o banco só dessa vez.

## Segurança (repositório público)

- O guardado fica no aparelho (localStorage), separado por conta e igreja, e é apagado ao sair.
  As permissões continuam no banco: o guardado nunca libera nada.
- **Dados sensíveis de outras pessoas** (pedidos privados, cadastros de visitantes, moderação) ficam
  só na memória: inclua o nome do guardado em `PRIVATE_SCREENS`.
- Todo texto vindo do banco passa por `esc()` no `draw`.

## Telas que não buscam nada

Se a tela não busca nada no banco antes de aparecer (formulário em branco, menu, textos), coloque-a
em `SEM_GUARDADO` no tests/units.spec.mjs, com o motivo. O teste confere que ela não espera o banco
antes do primeiro `$view.innerHTML`.

## Teste da tela

No spec de tela da funcionalidade: abra o Início (que já busca as telas em segundo plano), espere
`networkidle`, faça o banco demorar 4 segundos com `page.route('**/rest/v1/**', ...)` e confira que a
tela aparece em até 1 segundo (`{ timeout: 1000 }`). Exemplos: os testes "abrem na hora" em
tests/agenda.spec.mjs e tests/devocional.spec.mjs.
