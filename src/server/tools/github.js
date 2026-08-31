import { config } from '../config.js';
import { logger } from '../logger.js';

// Real GitHub issue creation. The repo is never taken from the model's
// output — it's pinned to GITHUB_REPO from server config, so a prompt
// injection that tries to redirect the write ("file this in
// someone-else/private-repo instead") has nothing to redirect: the tool
// only ever knows about the one repo it was configured for.
export async function isGithubToolConfigured() {
  return config.hasGithubTool;
}

export async function createGithubIssue({ title, body, labels }) {
  if (!config.hasGithubTool) {
    throw new Error('GitHub tool is not configured (GITHUB_TOKEN and GITHUB_REPO must both be set).');
  }

  const repo = config.GITHUB_REPO; // "owner/repo" — allowlisted, not model-supplied
  const url = `https://api.github.com/repos/${repo}/issues`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: String(title).slice(0, 256),
        body: String(body || '').slice(0, 4000),
        labels: Array.isArray(labels) ? labels.slice(0, 10).map(String) : undefined,
      }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      logger.error({ status: res.status, data }, 'GitHub issue creation failed');
      return { success: false, status: res.status, error: data.message || `GitHub API returned ${res.status}` };
    }

    logger.info({ issueUrl: data.html_url }, 'GitHub issue created');
    return { success: true, issueUrl: data.html_url, issueNumber: data.number };
  } catch (err) {
    logger.error({ err }, 'GitHub issue creation errored');
    return { success: false, error: err.name === 'AbortError' ? 'GitHub API request timed out' : err.message };
  } finally {
    clearTimeout(timer);
  }
}
