import { validateProduction } from './deploy-check.mjs';
export function targetSettings(current, version) {
  const vars = {};
  for (const binding of version.resources?.bindings ?? []) {
    if (binding.type === 'plain_text') vars[binding.name] = binding.text;
    if (binding.type === 'json') vars[binding.name] = typeof binding.json === 'string' ? JSON.parse(binding.json) : binding.json;
  }
  const bucket = version.resources?.bindings?.find(binding => binding.name === 'bucket' && binding.type === 'r2_bucket');
  if (!bucket || bucket.bucket_name !== current.r2_buckets[0].bucket_name || (bucket.jurisdiction ?? '') !== (current.r2_buckets[0].jurisdiction ?? '')) throw new Error('Target R2 binding differs; review resource compatibility manually');
  if (!vars.build_time || !Number.isFinite(Date.parse(vars.build_time))) throw new Error('Target version has no valid build_time; use a manually reviewed dashboard rollback for legacy versions');
  if (vars.base_url?.replace(/\/+$/, '') !== current.vars.base_url?.replace(/\/+$/, '')) throw new Error('Target base_url differs; review routing before rollback');
  if ((version.resources?.bindings ?? []).some(binding => binding.type === 'secret_text')) throw new Error('Cannot read target secret bindings for acceptance; review manually');
  const settings = { ...current, vars };
  return { settings, cfg: validateProduction(settings) };
}
