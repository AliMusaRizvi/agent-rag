import { ingest } from '../ingest.js';
import { GLOBAL_TENANT } from '../vectorstore.js';
import { logger } from '../logger.js';

let ingestInFlight = null;

// Admin-gated (requireApiKey), and de-duplicated: two requests arriving
// before the first finishes both used to run fetchRepoData()+addDocuments()
// and silently double the corpus (audit finding BUG-06). This version
// memoizes the in-flight promise so a second call joins the first instead
// of starting a duplicate run.
export async function ingestHandler(req, res) {
  if (ingestInFlight) {
    const result = await ingestInFlight;
    return res.json({ ...result, joinedInFlightRun: true });
  }

  ingestInFlight = ingest({ tenantId: GLOBAL_TENANT }).finally(() => {
    ingestInFlight = null;
  });

  try {
    const result = await ingestInFlight;
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'Ingestion failed');
    res.status(500).json({ error: 'Ingestion failed', requestId: req.id });
  }
}
