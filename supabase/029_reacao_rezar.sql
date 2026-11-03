-- =====================================================================
-- CC4 — reação 🙏 (mãos juntas) nos avisos e no chat
-- =====================================================================
-- Rode uma vez no SQL Editor (depois do 028). Pode rodar de novo.
--
-- - Os emojis aceitos passam a ser: 👍 ❤️ 🙏 🎉 😂 😮 😢 (avisos e mensagens do chat)

alter table public.announcement_reactions drop constraint if exists announcement_reactions_emoji_check;
alter table public.announcement_reactions add constraint announcement_reactions_emoji_check
  check (emoji in ('👍', '❤️', '🙏', '🎉', '😂', '😮', '😢'));

alter table public.chat_reactions drop constraint if exists chat_reactions_emoji_check;
alter table public.chat_reactions add constraint chat_reactions_emoji_check
  check (emoji in ('👍', '❤️', '🙏', '🎉', '😂', '😮', '😢'));
