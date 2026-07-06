import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        persistSession: true,
      },
    })
  : null;

export async function loadRemoteGroups(userId) {
  if (!supabase || !userId) return null;

  const { data, error } = await supabase
    .from("receipt_splitter_states")
    .select("groups")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data?.groups || null;
}

export async function saveRemoteGroups(userId, groups) {
  if (!supabase || !userId) return;

  const { error } = await supabase.from("receipt_splitter_states").upsert({
    user_id: userId,
    groups,
    updated_at: new Date().toISOString(),
  });

  if (error) throw error;
}
