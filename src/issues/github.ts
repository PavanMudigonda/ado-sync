/**
 * GitHub Issues API client — creates and searches issues using Node's built-in
 * https module (no extra dependencies required).
 */

import * as https from 'https';

export interface GitHubIssueOptions {
  repo: string;       // "owner/repo"
  token: string;
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

export interface GitHubIssue {
  number: number;
  html_url: string;
}

export async function createGitHubIssue(opts: GitHubIssueOptions): Promise<GitHubIssue> {
  const payload = JSON.stringify({
    title: opts.title,
    body:  opts.body,
    labels:    opts.labels    ?? [],
    assignees: opts.assignees ?? [],
  });
  return ghRequest<GitHubIssue>('POST', `/repos/${opts.repo}/issues`, opts.token, payload);
}

/**
 * Returns the first open issue matching the given label, or null if none exists.
 * Used for dedup: each per-test issue is labelled "tc:12345" so we can find it again.
 */
export async function findOpenGitHubIssueByLabel(repo: string, token: string, tcLabel: string): Promise<GitHubIssue | null> {
  const q = encodeURIComponent(`repo:${repo} label:"${tcLabel}" state:open`);
  const result = await ghRequest<{ items: GitHubIssue[] }>('GET', `/search/issues?q=${q}&per_page=1`, token, null);
  return result.items?.[0] ?? null;
}

function ghRequest<T = any>(method: string, apiPath: string, token: string, body: string | null): Promise<T> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string | number> = {
      'Authorization':  `Bearer ${token}`,
      'Accept':         'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent':     'ado-sync',
      'Content-Type':   'application/json',
    };
    if (body) headers['Content-Length'] = Buffer.byteLength(body);

    // lgtm [js/file-access-to-http]
    const req = https.request({ hostname: 'api.github.com', path: apiPath, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`GitHub API ${res.statusCode} ${method} ${apiPath}: ${text}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch { reject(new Error(`GitHub API non-JSON response: ${text.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    // lgtm [js/file-access-to-http]
    if (body) req.write(body);
    req.end();
  });
}
