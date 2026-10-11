export function buildTime(previous, now = Date.now()) {
  return new Date(Math.max(now, (Date.parse(previous) || 0) + 1)).toISOString();
}
export async function checkHealth(baseURL, expectedTime, { fetcher = fetch, pause = ms => new Promise(ok => setTimeout(ok, ms)), attempts = 6 } = {}) {
  let failure;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const url = new URL(`${baseURL}/v1/health`); url.searchParams.set('deployment', expectedTime);
      const response = await fetcher(url, { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(10000) });
      const body = await response.json();
      if (response.ok && body.status === 'ok' && body.storage === 'ok' && body.time === expectedTime) return;
      failure = `HTTP ${response.status}, status=${body.status}, time=${body.time}`;
    } catch (error) { failure = error.message; }
    if (attempt + 1 < attempts) await pause(2000);
  }
  throw new Error(`Deployment timestamp/health check failed: ${failure}`);
}
export async function publishAndAccept({ publish, health, smoke, save }, report) {
  report.status = 'publishing'; await save(report);
  await publish();
  report.status = 'published_pending_acceptance'; await save(report);
  try {
    await health(); report.health = 'passed'; await save(report);
    await smoke(); report.smoke = 'passed'; report.status = 'accepted'; await save(report);
  } catch (error) {
    report.status = 'published_quality_failed'; report.failure = error.message;
    await save(report); throw error;
  }
}
