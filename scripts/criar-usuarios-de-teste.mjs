// Gera as contas de teste usadas por tests/isolation.spec.mjs.
// Cria (ou reaproveita) uma senha aleatória em tests/senha-testes.local e escreve
// supabase/usuarios-de-teste.local.sql para rodar no SQL Editor. Os dois ficam fora do Git.
// A mesma senha vai no segredo TEST_USERS_PASSWORD do GitHub (Settings > Secrets > Actions).
// Uso: node scripts/criar-usuarios-de-teste.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const PASS_FILE = 'tests/senha-testes.local';
const SQL_FILE = 'supabase/usuarios-de-teste.local.sql';
export const TEST_USERS = ['adm-a', 'lider-a', 'membro-a', 'adm-b', 'sem-igreja'];
const email = (u) => `${u}@teste.igrejaconecta.invalid`;

const password = existsSync(PASS_FILE) ? readFileSync(PASS_FILE, 'utf8').trim() : randomBytes(18).toString('base64url');
writeFileSync(PASS_FILE, password + '\n');

const values = TEST_USERS.map((u) => `('${email(u)}')`).join(',\n    ');
writeFileSync(
  SQL_FILE,
  `-- Contas de teste (gerado por scripts/criar-usuarios-de-teste.mjs). NÃO publique este arquivo.
-- Rode no SQL Editor do Supabase depois do 002_igrejas_de_teste.sql. Pode rodar de novo quando quiser.
do $$
declare
  v_email text;
  v_id uuid;
begin
  delete from auth.users where email like '%@teste.igrejaconecta.invalid';
  for v_email in select e from (values
    ${values}
  ) as t(e) loop
    v_id := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new
    ) values (
      '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
      extensions.crypt('${password}', extensions.gen_salt('bf')), now(),
      '{"provider": "email", "providers": ["email"]}', '{}', now(), now(),
      '', '', '', ''
    );
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_id, v_id::text,
            jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
            'email', now(), now(), now());
  end loop;

  -- Liga as contas aos cadastros das igrejas de teste, já com o convite aceito.
  update public.members m set user_id = u.id, consent_at = now()
    from auth.users u
   where lower(m.email) = u.email
     and m.church_id in (select id from public.churches where is_test);
end $$;
`,
);
console.log(`Pronto: ${SQL_FILE} e ${PASS_FILE} (a senha não é mostrada aqui).`);
