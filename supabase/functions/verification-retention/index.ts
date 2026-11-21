// Daily retention job for Verified Seller records (called by the scheduled job in the database).
// 1. Runs the retention rules in the database (redacts expired records and queues their photos).
// 2. Securely deletes queued photos through the Storage API and records the deletion in the audit trail.
// The caller must present the shared secret stored in the database vault.
import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const secret = req.headers.get('x-retention-secret') ?? '';
  const ok = await sb.rpc('verification_cron_secret_ok', { p_secret: secret });
  if (ok.error || ok.data !== true) return new Response('Forbidden', { status: 403 });

  const run = await sb.rpc('verification_retention_run');
  if (run.error) return Response.json({ error: 'retention failed' }, { status: 500 });

  let deleted = 0, failed = 0;
  for (let round = 0; round < 10; round++) {
    const pending = await sb.rpc('verification_purge_pending', { p_limit: 100 });
    if (pending.error || !pending.data?.length) break;
    const rows = pending.data as { id: number; path: string }[];
    const rm = await sb.storage.from('verification-photos').remove(rows.map((r) => r.path));
    if (rm.error) { failed += rows.length; break; }
    // Files already gone count as deleted.
    const done = await sb.rpc('verification_purge_done', { p_ids: rows.map((r) => r.id) });
    if (done.error) { failed += rows.length; break; }
    deleted += rows.length;
  }
  return Response.json({ retention: run.data, files_deleted: deleted, failed });
});
