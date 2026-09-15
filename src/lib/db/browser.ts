"use client";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { publicConfig } from "@/lib/config";

let cached: SupabaseClient | null = null;

export function getBrowserClient(): SupabaseClient {
  if (!cached) {
    cached = createBrowserClient(publicConfig.supabaseUrl, publicConfig.supabasePublishableKey);
  }
  return cached;
}
