create table if not exists public.receipt_splitter_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  groups jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.receipt_splitter_states enable row level security;

drop policy if exists "Users can read their receipt splitter state"
  on public.receipt_splitter_states;
drop policy if exists "Users can insert their receipt splitter state"
  on public.receipt_splitter_states;
drop policy if exists "Users can update their receipt splitter state"
  on public.receipt_splitter_states;
drop policy if exists "Users can delete their receipt splitter state"
  on public.receipt_splitter_states;

create policy "Users can read their receipt splitter state"
  on public.receipt_splitter_states
  for select
  using (auth.uid() = user_id);

create policy "Users can insert their receipt splitter state"
  on public.receipt_splitter_states
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update their receipt splitter state"
  on public.receipt_splitter_states
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their receipt splitter state"
  on public.receipt_splitter_states
  for delete
  using (auth.uid() = user_id);
