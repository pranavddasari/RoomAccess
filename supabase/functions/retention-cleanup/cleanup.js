// Shared with Node fixture tests. Database claims serialize against attachment;
// physical deletion always uses Storage API, followed by explicit acknowledgement.
export async function runCleanup(client, { dryRun = true, maxBatches = 12 } = {}) {
 const summary = { dryRun, objectsDeleted: 0, batches: 0, failures: [] };
 const rpc = async (name, args) => { const { data, error } = await client.rpc(name, args); if (error) throw error; return data; };
 if (dryRun) return { ...summary, plan: await rpc('retention_plan', { p_dry_run: true }) };
 for (let batch = 0; batch < maxBatches; batch++) {
  const plan = await rpc('retention_plan', { p_dry_run: false });
  if (!plan.paths.length) break;
  const paths = [...new Set(plan.paths.map(item => item.storage_path))];
  const { error } = await client.storage.from('session-photos').remove(paths);
  if (error) { summary.failures.push(error.message); break; }
  await rpc('retention_ack', { p_paths: paths });
  summary.objectsDeleted += paths.length; summary.batches++;
 }
 // Successfully removed sessions can finalize even if another batch failed.
 summary.database = await rpc('retention_finalize');
 return summary;
}
