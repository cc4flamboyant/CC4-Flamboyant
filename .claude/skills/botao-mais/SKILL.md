---
name: botao-mais
description: Regras do botão redondo com "+" (canto inferior direito) para criar algo numa tela do CC4 — nova conversa, novo evento, novo aviso etc. Use sempre que uma tela de lista tiver uma ação principal de "criar/novo", ou quando o usuário pedir o "botão +", "botão redondo" ou "botão flutuante".
---

# Botão redondo com "+"

Pedido do usuário: a ação de **criar** de uma tela de lista fica num **botão redondo com "+"** no
canto inferior direito, como em apps de celular (já usado em Conversas, Agenda, Avisos, Devocional, Plano de leitura, Galeria, Células, Ministérios, Membros, Pedidos de oração, Meus filhos, Check-in infantil e Presença nos cultos). Ele não
ocupa espaço no topo da tela e fica sempre ao alcance do polegar.

## Como usar

Em `js/app.js` já existe a função `fab(href, label)`. Coloque-a **no fim do HTML da página**, dentro
do `<div class="page">`, e tire o botão antigo do topo (`<div class="actions-row"><a class="btn
primary" ...>${icon.plus} Novo ...</a></div>`):

```js
$view.innerHTML = `
  <div class="page">
    <h1>Coisas</h1>
    ...lista...
    ${podeCriar ? fab('#/coisas/novo', 'Nova coisa') : ''}
  </div>`;
```

- `href`: a tela de criar (o mesmo destino do botão antigo).
- `label`: o que o botão faz, por extenso ("Novo evento", "Nova conversa"). Vira o `aria-label` e o
  `title`: é o que o leitor de tela fala e o que os testes procuram (`getByRole('link', { name })`).
- **Só para quem pode criar** (ex.: `isLeaderRole(myRole())`, `galleryTeam()`; em Pedidos de oração todo membro pode, então o botão aparece para todos). A regra de verdade
  continua no banco; o botão escondido só evita oferecer o que vai dar erro.
- **Um botão por tela**, só para a ação principal. Ações de um item (editar, apagar) continuam no item.
- **Mais de uma forma de criar** (ex.: Membros: Novo membro e Importar planilha): use
  `fabMenu(label, [[href, texto], ...])` (ex. também: Check-in infantil, com Cadastrar criança e Salas; a Retirada por código, a ação mais usada, fica no topo). O "+" abre um menu acima dele com as opções e vira "×";
  tocar fora fecha. Sem script na página (é um `<details>`). No teste, abra pelo `getByLabel(label)`
  antes de clicar na opção.
- Não use o botão em formulários nem em telas de detalhe com várias ações: lá vale o botão normal.
- **Ação principal que não é criar** (ex.: Aniversariantes: Imprimir; Visitantes: QR Code para o culto, com `icon.qr`): o mesmo botão redondo, mas
  com o ícone da ação, nunca o "+" (o "+" quer dizer criar). Ex.: `<button class="fab no-print"
  id="print" aria-label="Imprimir" title="Imprimir">${icon.print}</button>`; `no-print` o esconde
  na folha impressa.

## O que já vem pronto (não repita)

- Estilo `.fab` em `css/style.css`: 56 px, cor da igreja (`--brand` / `--brand-ink`), sombra, acima
  da barra de abas (`--tabbar-h`) e da área segura do iPhone; sem barra de abas, fica a 16 px do fundo.
- `.page:has(.fab)` dá espaço no fim da página para o botão não cobrir o último item.
- Funciona nos temas claro e escuro e passa pela regra de segurança da página (sem script embutido).

## Textos

- Troque na Ajuda (`helpTopics()`) "toque em *Novo …*" por "toque no botão **+**, embaixo à direita".
- O texto da tela vazia também: "Toque no **+** para …".

## Teste

No spec da tela: quem pode criar vê o botão e ele abre o formulário; quem não pode não vê
(`expect(page.locator('.fab')).toHaveCount(0)`). Exemplo: o teste "o botão + de novo evento e de
novo aviso aparece só para a liderança" em tests/agenda.spec.mjs.

Confira também com uma foto de tela num celular pequeno (360 px) que o botão não cobre nada
importante.

## Telas que ainda usam o botão antigo (candidatas)

Nenhuma. Dentro do ministério, Nova escala fica como
está (tela com várias ações, como dentro do álbum da galeria).
Só troque quando o usuário pedir.
