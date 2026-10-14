// Public browser configuration. Never put a service_role/secret key here.
// Local development only. GitHub Actions generates site/shared-config.js from
// SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY; this file stays empty in Git.
export const sharedConfig = {
  url: "", // https://YOUR_PROJECT.supabase.co
  publishableKey: "", // sb_publishable_... or the legacy anon public key
};
