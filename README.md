# CC4

App (PWA) whitelabel para igrejas: agenda e calendário, avisos, aniversários, Meus filhos e salas das crianças, carteirinha, galeria de fotos, Pix e notificações. Uma única instalação atende várias igrejas, cada uma com nome, logo, cores e funcionalidades próprias, e o banco garante que uma igreja nunca vê os dados de outra.

Nasceu do Igreja Conecta, com a mesma arquitetura: HTML + CSS + JavaScript sem build, Supabase (Postgres com RLS, Auth, Storage) e GitHub Pages. O nome "CC4" é provisório: para trocar, mude `APP_NAME` em `js/config.js` e o título em `index.html`, `404.html` e `manifest.webmanifest`.

## O que tem

| Módulo | O que faz |
|---|---|
| Agenda e calendário | Eventos da igreja (podem repetir toda semana) em três vistas: Lista, Mês e Dia. A liderança cria o evento tocando no dia. Lembrete por notificação; aniversariantes 🎂 no calendário |
| Avisos | Mural de avisos, fixados no topo, com notificação opcional |
| Aniversários | Aniversariantes do mês (cada um autoriza), mensagem de aniversário da igreja às 7h (push e e-mail), resumo para a liderança |
| Meus filhos | O responsável cadastra os filhos; vê a sala, o tutor, os avisos e as aulas (anotações e presença) |
| Salas das crianças | A liderança cria as salas, escolhe o tutor (um membro) e coloca as crianças. O tutor marca a presença, escreve as anotações da aula e avisa os pais |
| Carteirinha | Carteirinha digital com QR Code de conferência |
| Galeria | Álbuns só para os membros; publicam a liderança e quem o administrador marcar |
| Pix | QR Code e chave Pix da igreja |
| Notificações | Central do app (sininho) e push no celular |
| Configurar a igreja | Aparência (whitelabel: nome, logo, cores, tema escuro), textos, Pix, funcionalidades, privacidade e a mensagem de aniversário |

## Endereços

| Endereço | O que é |
|---|---|
| `.../` | Início: entrar e escolher a igreja; administração da plataforma |
| `.../i/<igreja>/` | O app da igreja (é este endereço que cada membro instala na tela inicial) |

A publicação (`scripts/build-site.mjs`) gera uma pasta `i/<igreja>/` por igreja ativa, com manifest, ícones e título próprios. Uma igreja recém-criada já abre antes disso pelo `404.html`, só que ainda com o ícone padrão.

## Configuração (uma vez)

Os lugares marcados com `SEU-PROJETO`, `DONO` e `REPOSITORIO` precisam dos dados do projeto novo:

| Marca | Troque por | Onde |
|---|---|---|
| `SEU-PROJETO` | o código do projeto Supabase (o começo do endereço `https://xxxx.supabase.co`) | `js/config.js`, `index.html`, `404.html`, `.github/workflows/funcoes.yml` |
| `COLE-AQUI-A-CHAVE-PUBLICA` | a chave *publishable* (Project Settings > API Keys) | `js/config.js` |
| `DONO` / `REPOSITORIO` | o dono e o nome do repositório no GitHub | workflows, `scripts/`, `supabase/007_relogio.sql`, `supabase/functions/enviar-push/index.ts` |

1. **Banco**: no Supabase, abra o **SQL Editor** e rode os arquivos de `supabase/` na ordem (tabela abaixo). O `007_relogio.sql` precisa antes do segredo `github_token` no Vault (veja "Relógio do Supabase").
2. **Você como administrador da plataforma**: entre uma vez no app (para a sua conta existir) e rode no SQL Editor, trocando o e-mail:
   ```sql
   insert into public.platform_admins (user_id)
   select id from auth.users where email = 'seu-email@exemplo.com';
   ```
3. **Login**: em **Authentication > URL Configuration**, coloque o endereço do site em *Site URL* e acrescente em *Redirect URLs*:
   - `https://<dono>.github.io/<repositorio>/**`
   - `http://localhost:4173/**` (testes no computador)
4. **Google** (opcional): em **Authentication > Providers > Google**, siga o passo a passo do Supabase.
5. **GitHub Pages**: em **Settings > Pages**, escolha *GitHub Actions* como origem.
6. **Segredos do GitHub** (Settings > Secrets and variables > Actions), com os valores gerados no seu computador (os arquivos `.local` ficam fora do Git):

| Nome | Valor |
|---|---|
| `ENVIO_SECRET` | conteúdo de `tests/envio-segredo.local` (o banco guarda só o hash dele, em `004_aniversarios.sql`) |
| `VAPID_PRIVATE_KEY` | conteúdo de `tests/vapid-privada.local` (a pública já está em `js/config.js`) |
| `TEST_USERS_PASSWORD` | conteúdo de `tests/senha-testes.local` (veja "Contas de teste") |
| `SUPABASE_ACCESS_TOKEN` | Supabase > Account > Access Tokens (publica a função do aviso de teste) |
| `GMAIL_USER` (variável) e `GMAIL_APP_PASSWORD` | opcionais: e-mail de aniversário pelo Gmail |

## Arquivos SQL

Rode na ordem, no SQL Editor.

| Arquivo | O que faz |
|---|---|
| `001_base.sql` | Igrejas, membros, papéis, regras de acesso (RLS), pastas de arquivos e a Igreja Exemplo |
| `002_igrejas_de_teste.sql` | Igrejas Teste A e Teste B, usadas pelos testes de separação (não ganham página pública) |
| `003_membros.sql` | Foto do membro, e-mail de quem já entrou só muda após desligar a conta, admin desliga contas |
| `004_aniversarios.sql` | Mensagem de aniversário por igreja, aparelhos com notificação, registro de envios, limite de 100 e-mails/dia, resumo da liderança |
| `005_agenda_avisos.sql` | Agenda (eventos que podem repetir toda semana), mural de avisos, central de notificações, lembretes |
| `006_privacidade.sql` | Exportar os próprios dados, sair de uma igreja e excluir a conta |
| `007_relogio.sql` | Relógio do Supabase: manda o GitHub rodar os lembretes e os aniversários na hora certa e publicar o site quando uma igreja muda |
| `008_datas_especiais.sql` | Datas no cadastro e funções das datas comemoradas (o app usa o aniversário) |
| `009_notificacoes.sql` | Notificações da central que também vão por push |
| `010_mapa.sql` | Local exato no mapa no endereço da igreja e nos eventos |
| `011_seguranca.sql` | Links e imagens só com https://, notificações só para serviços de push conhecidos |
| `012_salas.sql` | Meus filhos e salas das crianças: tutor, presença, anotações, avisos para os pais, limpeza em 12 meses |
| `013_carteirinha.sql` | Carteirinha digital: "membro desde", código secreto do QR e conferência pública |
| `014_galeria.sql` | Galeria de fotos: álbuns privados, limite de 300 fotos, "pedir para tirar esta foto"; quem publica além da liderança |
| `015_tema_escuro.sql` | Fundo do tema escuro: preto ou a cor principal da igreja |
| `016_meus_dados_e_seguranca.sql` | "Baixar meus dados" completo e funções fechadas para quem não está logado |

## Contas de teste

Os testes de `tests/isolation.spec.mjs` entram com cinco contas (admin, líder e membro da Teste A, admin da Teste B e uma pessoa sem igreja) e conferem que nenhuma lê ou altera o que não pode.

1. `node scripts/criar-usuarios-de-teste.mjs` gera uma senha aleatória em `tests/senha-testes.local` e o arquivo `supabase/usuarios-de-teste.local.sql`. Os dois ficam fora do Git.
2. Rode `supabase/usuarios-de-teste.local.sql` no SQL Editor.
3. Grave o segredo `TEST_USERS_PASSWORD` no GitHub com o conteúdo de `tests/senha-testes.local`.

As igrejas de teste são só dos testes: **não entre nelas com a sua conta** (para experimentar, use a Igreja Exemplo). Se alguém entrar, os testes param e pedem para rodar `supabase/limpar-igrejas-de-teste.sql`.

## Envios automáticos

- **Aniversários** (`.github/workflows/aniversarios.yml`, 7h de Brasília): push e e-mail de aniversário, resumo da liderança e limpeza (notificações antigas, aulas e avisos das salas com mais de 12 meses).
- **Lembretes** (`.github/workflows/lembretes.yml`, a cada 10 minutos): lembrete dos eventos, avisos com notificação e as notificações da central que vão por push (avisos das salas, pedidos para tirar fotos).
- **Aviso de teste** (Menu > Notificações): a Edge Function `supabase/functions/enviar-push`, publicada por `.github/workflows/funcoes.yml`.

### Relógio do Supabase

O agendamento grátis do GitHub atrasa ou pula rodadas. Por isso o Supabase (`supabase/007_relogio.sql`, com pg_cron) chama o GitHub na hora certa.

1. No GitHub, crie um token em **Settings > Developer settings > Personal access tokens > Fine-grained tokens**: só o repositório do CC4, permissão **Actions: Read and write**.
2. No Supabase, em **Integrations > Vault**, clique em **Add new secret**, com o nome `github_token` e o token como valor.
3. Rode `supabase/007_relogio.sql` no SQL Editor.

## Testes

```sh
npm install
npx playwright install
npm test
```

Rodam também no GitHub Actions a cada mudança, e a publicação só acontece se passarem. `tests/security.spec.mjs` tenta ler e gravar sem permissão e precisa falhar.

## Segurança

O repositório pode ser público: no frontend e no Git ficam só a URL do Supabase, a chave pública (publishable) e a chave VAPID pública. Toda regra de acesso fica no banco (RLS e funções `security definer`). Segredos só nos segredos do GitHub, no Vault do Supabase ou em arquivos `*.local` (fora do Git). A skill `.claude/skills/teste-vulnerabilidade` faz a auditoria.

## Limites do plano gratuito

| Serviço | Limite | Observação |
|---|---|---|
| Supabase banco | 500 MB | Fotos ficam no Storage |
| Supabase Storage | 1 GB | Logo em até 512 px; fotos reduzidas no celular |
| Supabase sem uso | Pausa após 7 dias | O envio diário dos aniversários mantém acordado |
| E-mail (Gmail) | ~500/dia | O app manda no máximo 100 |
