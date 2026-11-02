---
name: teste-vulnerabilidade
description: Teste de vulnerabilidade (auditoria de segurança) de toda a aplicação CC4 — segredos no código, no histórico do Git e no site publicado, o que um visitante anônimo e um membro de outra igreja conseguem ver ou fazer no banco (RLS, funções security definer, Storage), XSS no app, regras da página (CSP), Edge Functions e GitHub Actions. Use sempre que o usuário pedir teste de vulnerabilidade, pentest, auditoria, revisão ou varredura de segurança, "ver se está seguro", "ver se vazou alguma chave", ou antes de abrir o app para uma igreja nova, mesmo que não diga "skill".
---

# Teste de vulnerabilidade do CC4

## A premissa (não negociável)

O repositório do CC4 é **público** e o app roda inteiro no navegador. Então:

- **No frontend e no Git só podem estar:** a URL do Supabase, a chave pública (`sb_publishable_…`,
  pública por design) e a chave VAPID **pública**. Mais nada que comprometa a segurança.
- **Toda regra de acesso fica no banco** (RLS, funções `security definer` com checagem própria).
  Esconder um botão na tela não protege nada: quem tem a chave pública chama a API direto.
- **Segredos só em:** segredos do GitHub, Vault/variáveis do Supabase, `tests/*.local` e
  `supabase/*.local.sql` (fora do Git, pelo `.gitignore`).
- **Textos vindos do banco sempre passam por `esc()`** antes de ir para o HTML.

Um achado que quebra essa premissa é sempre **CRÍTICO** ou **ALTO**.

## Regras do teste

- **Só olhar, não estragar.** Nada de teste destrutivo, de carga ou de negação de serviço: o banco é
  o de produção, grátis, compartilhado pelas igrejas reais.
- **Só contas de teste** (Teste A e Teste B, `tests/*.local`). Nunca ler nem mexer em dados de
  igrejas reais (como a Vineyard, onde o usuário experimenta).
- **Nunca mostrar um segredo encontrado:** só os primeiros caracteres + "…", e onde está.
- **Não corrigir sem perguntar.** O teste termina num relatório; cada correção vira PR pelo fluxo de
  sempre (branch → PR → SQL rodado pelo usuário → testes → merge só com "pode fazer o merge").
- **Não rodar testes locais enquanto o CI do GitHub estiver rodando** (os dois juntos derrubam o banco
  grátis). Conferir antes com `gh run list --status in_progress`.
- Se aparecer uma chave vazada: avisar na hora e passar ao usuário como **trocar a chave**
  (apagar do histórico não basta: o repositório é público e pode ter sido copiado).

## Passo 1 — Varredura automática

Na raiz do projeto (o Node fica fora do PATH: `export PATH="/c/Program Files/nodejs:$PATH"`):

```bash
node .claude/skills/teste-vulnerabilidade/varredura.mjs
```

Ela só lê (não grava no banco nem no site) e confere:

- **Segredos** nos arquivos do Git, em **todo o histórico** do Git e nos arquivos do **site
  publicado**: chave secreta do Supabase, JWT com papel diferente de `anon` (service_role), chave
  privada, token do GitHub, senha escrita no código, chave privada VAPID, arquivos `.local`
  versionados ou publicados.
- **No código do app:** menção a `service_role`, `eval`, e-mails (dado pessoal) no código.
- **Visitante anônimo:** lê cada tabela e visão (os nomes vêm de `supabase/0*.sql`), lista os
  buckets de arquivos privados e tenta listar a estrutura do banco.
- **Página:** CSP em `index.html`/`404.html` (sem `unsafe-inline`/`unsafe-eval` em script-src) e
  scripts de fora com versão fixa.

Opções: `--sem-historico`, `--sem-site`, `--sem-banco`. Termina com código 1 se houver CRÍTICO ou ALTO.

Leitura pública **de propósito**: a tabela `churches` (perfil da igreja: nome, cores, Pix, contato de
privacidade). A varredura lista as colunas dela: conferir se alguma nova não deveria ser pública.

## Passo 2 — Consultas no banco (o usuário roda)

A chave pública não enxerga a estrutura do banco, de propósito. Passe estas consultas (só leem) para
o usuário rodar no **SQL Editor do Supabase** e colar o resultado. Cada uma deve voltar vazia, ou só
com o que está explicado ao lado.

```sql
-- a) Tabelas sem RLS (deve voltar vazio)
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;

-- b) Permissões do visitante anônimo nas tabelas. O Supabase dá permissão a anon em toda tabela
--    nova; quem barra é o RLS. Então: tabela daqui que aparece em (a) = CRÍTICO; que tem regra para
--    anon/public em (e) = conferir a regra. Tabelas de dado sensível devem ter "revoke all ... from anon".
select table_name, string_agg(privilege_type, ', ') from information_schema.role_table_grants
where grantee = 'anon' and table_schema = 'public' group by table_name order by 1;

-- c) Funções que o visitante anônimo pode chamar (conferir uma a uma: devem ser só as públicas de
--    propósito, como a verificação da carteirinha, e nenhuma que grave ou leia dado pessoal)
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'execute') order by 1;

-- d) Funções security definer sem search_path fixo (deve voltar vazio)
select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');

-- e) Regras (policies) que valem para todos ou para anon (conferir o "qual" de cada uma)
select tablename, policyname, roles, cmd, qual, with_check from pg_policies
where schemaname = 'public' and (roles @> '{public}' or roles @> '{anon}') order by 1, 2;

-- f) Buckets de arquivos (só "igrejas" pode ser público) e regras do Storage
select id, public, file_size_limit, allowed_mime_types from storage.buckets order by 1;
select policyname, roles, cmd, qual from pg_policies where schemaname = 'storage' order by 1;

-- g) Visões que ignoram o RLS (sem security_invoker) — deve voltar vazio
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v'
  and not coalesce('security_invoker=true' = any (c.reloptions), false);
```

Peça também ao usuário para abrir **Supabase > Advisors > Security Advisor** e colar os avisos, e
conferir em **Authentication > Settings**: confirmação de e-mail ligada, proteção contra senha
vazada ligada, tempo de expiração do link razoável.

## Passo 3 — Testes que já existem

`tests/security.spec.mjs` (visitante anônimo) e `tests/isolation.spec.mjs` (cada papel e a outra
igreja) cobrem cada SQL. Rodar os dois (sem o CI rodando ao mesmo tempo):

```bash
npx playwright test tests/security.spec.mjs tests/isolation.spec.mjs --reporter=line
```

Conferir se **cada tabela e função nova** desde a última auditoria tem teste nos dois arquivos
(compare os `create table`/`create function` dos SQL novos com os `describe` dos testes). Falta de
teste é achado **MÉDIO**.

## Passo 4 — Revisão manual (o que a máquina não pega)

Leia o código com a pergunta "e se a pessoa chamar a API direto, com outros valores?":

1. **Funções `security definer`** (`supabase/*.sql`): toda função confere **quem chama** (papel e
   igreja) antes de ler ou gravar? Usa `my_member_id`, `my_church_ids`, `can_…`? Recebe um `id` e
   confere que ele é da igreja de quem chama? **Lição já aprendida:** `if not (...)` com valor que
   pode ser nulo deixa passar: tem que ser `if not coalesce(..., false)`. Tem `set search_path = ''`?
   Revoga `execute` de `public, anon` quando não é pública?
2. **RLS de cada tabela nova:** `select` só da própria igreja e do papel certo; `insert/update/delete`
   com `with check` (senão a pessoa grava com `church_id` de outra igreja).
3. **Dados sensíveis** (biometria `face_templates`/`face_angles`/`face_consents`, financeiro,
   pedidos de oração privados, crianças, conversas): tabela fechada, acesso só por função.
4. **XSS no app** (`js/app.js`): todo texto do banco dentro de `innerHTML` passa por `esc()`?
   Procure `${` sem `esc(` nas telas novas. Links montados com dado do banco (`href`, WhatsApp, mapa)
   não podem aceitar `javascript:`; cores e URLs de imagem vindas do banco são validadas.
5. **O que fica no aparelho:** telas privadas só na memória (`PRIVATE_SCREENS` em `js/app.js`), nada
   sensível no `localStorage`; o aviso push não leva o conteúdo (só "Fulano escreveu").
6. **Edge Function** (`supabase/functions/`): confere quem chama antes de enviar; segredos só por
   variável de ambiente; não devolve erro com dado interno.
7. **GitHub Actions** (`.github/workflows/`): segredos só via `secrets.*`, nunca impressos no log;
   sem `pull_request_target` com código do PR; `permissions` mínimas; ações com versão fixa.
8. **Abuso:** funções que gravam ou enviam e-mail/push têm limite (por dia, por pessoa)? Um membro
   consegue mandar aviso para a igreja toda ou encher o banco?
9. **Privacidade (LGPD):** dado novo aparece em "Meus dados" (`export_my_data`) e é apagado ao sair da
   igreja/apagar a conta? A política (`privacidade.html`) cita o dado novo?

## Passo 5 — Relatório

Entregue em português simples (o usuário não é programador), do mais grave para o menos grave:

| Nível | O que é |
|---|---|
| **CRÍTICO** | segredo exposto, ou qualquer pessoa lê/grava dado de outra igreja ou dado sensível |
| **ALTO** | quebra da premissa (regra só na tela), dado pessoal exposto, XSS |
| **MÉDIO** | falta de teste, falta de limite contra abuso, defesa que depende de um detalhe frágil |
| **BAIXO** | endurecimento recomendado (CSP mais rígida, cabeçalhos etc.) |

Para cada achado: **onde** (`arquivo:linha` ou nome da função/tabela), **o que alguém mal-intencionado
conseguiria** (em uma frase, sem receita de ataque) e **a correção sugerida** (com o número do próximo
SQL, se precisar). Diga também o que foi conferido e **está certo**, e o que **não deu para conferir**
(por exemplo, as consultas do Passo 2 que o usuário ainda não rodou). Depois pergunte quais
correções fazer.
