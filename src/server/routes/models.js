import { listModels } from '../providers.js';

// Drives the frontend's model picker. Replaces the old hardcoded list where
// Gemini/OpenAI/Anthropic were shown as disabled "Coming Soon" even though
// the Gemini backend path already worked — availability now reflects
// whether the corresponding API key is actually configured.
export async function modelsHandler(req, res) {
  res.json({ models: await listModels() });
}
