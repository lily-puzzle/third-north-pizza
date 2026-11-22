-- NORTHSIDE PIZZA / V49 Online Leaderboard
-- Supabase Dashboard > SQL Editor > New query で、すべてを一度だけ実行。
-- 投稿は匿名ユーザーの認証トークン必須。クライアントから表を書き換えられない設計。
-- 同じプレイヤーは全体部門とレベル別部門の各1件まで。

create table if not exists public.northside_records (
  player_id uuid not null references auth.users(id) on delete cascade,
  board text not null check (board in ('all','lv1_30','lv31_60','lv61_90','lv91_100')),
  nickname text not null check (char_length(btrim(nickname)) between 1 and 16),
  sales bigint not null check (sales between 1 and 9999999),
  level integer not null check (level between 1 and 100),
  day integer not null check (day between 1 and 99999),
  updated_at timestamptz not null default now(),
  primary key(player_id,board)
);

create index if not exists northside_records_ranking_idx
  on public.northside_records (board,sales desc,updated_at asc);

alter table public.northside_records enable row level security;
revoke all on table public.northside_records from public, anon, authenticated;
grant select on table public.northside_records to anon, authenticated;

drop policy if exists "Read public high scores" on public.northside_records;
create policy "Read public high scores"
  on public.northside_records for select to anon, authenticated using (true);

-- RLSで直接INSERT/UPDATE/DELETEを禁止し、このRPCだけで記録を書き込む。
create or replace function public.northside_submit_score(
  p_nickname text, p_sales bigint, p_level integer, p_day integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid;
  v_name text;
  v_board text;
  v_one text;
begin
  v_uid := auth.uid();
  if v_uid is null then
    raise exception 'ログインしてから投稿してください';
  end if;
  v_name := pg_catalog.btrim(p_nickname);
  if v_name is null or pg_catalog.char_length(v_name) not between 1 and 16
     or v_name ~ '[[:cntrl:]]' then
    raise exception '名前は1〜16文字で入力してください';
  end if;
  if p_sales is null or p_sales not between 1 and 9999999
     or p_level is null or p_level not between 1 and 100
     or p_day is null or p_day not between 1 and 99999 then
    raise exception 'スコアの形式が不正です';
  end if;
  v_board := case when p_level <= 30 then 'lv1_30'
                  when p_level <= 60 then 'lv31_60'
                  when p_level <= 90 then 'lv61_90'
                  else 'lv91_100' end;
  foreach v_one in array array['all',v_board] loop
    insert into public.northside_records (player_id,board,nickname,sales,level,day)
    values (v_uid,v_one,v_name,p_sales,p_level,p_day)
    on conflict (player_id,board) do update set
      nickname = excluded.nickname,
      sales = greatest(public.northside_records.sales,excluded.sales),
      level = case when excluded.sales > public.northside_records.sales
                   then excluded.level else public.northside_records.level end,
      day = case when excluded.sales > public.northside_records.sales
                 then excluded.day else public.northside_records.day end,
      updated_at = case when excluded.sales > public.northside_records.sales
                        then now() else public.northside_records.updated_at end;
  end loop;
  return pg_catalog.jsonb_build_object('ok',true,'board',v_board);
end;
$$;
revoke all on function public.northside_submit_score(text,bigint,integer,integer) from public, anon;
grant execute on function public.northside_submit_score(text,bigint,integer,integer) to authenticated;

-- 50位以下になっても正確な「自分の順位」を返す。
create or replace function public.northside_my_rank(p_board text)
returns integer language sql stable security invoker set search_path = '' as $$
  select (select 1 + count(*)::integer from public.northside_records other
          where other.board=mine.board and
          (other.sales>mine.sales or (other.sales=mine.sales and other.updated_at<mine.updated_at)))
  from public.northside_records mine
  where mine.player_id=auth.uid() and mine.board=p_board
$$;
revoke all on function public.northside_my_rank(text) from public, anon;
grant execute on function public.northside_my_rank(text) to authenticated;

-- 不審な記録を管理者が削除する際の例（値は実際のIDに置換してください）:
-- delete from public.northside_records where player_id='ユーザーのUUID';
