import { fail, run } from './shell.mjs'

/**
 * The repository, from the remote rather than a constant.
 *
 * A hardcoded owner/name is a thing that silently keeps working after a fork, publishing releases
 * and changelog links to somebody else's repository.
 */
export function repositoryFromRemote() {
  const url = run('git', ['remote', 'get-url', 'origin']).stdout.trim()
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(url)
  if (!match) fail(`origin is not a GitHub remote this tooling can parse: ${url}`)
  return { owner: match[1], name: match[2] }
}

export const token = () => process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN

/**
 * The GitHub REST API, over fetch.
 *
 * `gh` is not installed on this machine and a release should not require it. A token with `contents:
 * write` on this repository is the whole dependency.
 */
async function api(path, { method = 'GET', body, repository } = {}) {
  const authorization = token()
  if (!authorization) fail('no GITHUB_TOKEN (or GH_TOKEN) in the environment.')
  const response = await fetch(`https://api.github.com/repos/${repository.owner}/${repository.name}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${authorization}`,
      'x-github-api-version': '2022-11-28',
      'user-agent': 'weft-release',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await response.text()
  const parsed = text ? JSON.parse(text) : undefined
  return { ok: response.ok, status: response.status, body: parsed, text }
}

/** Check the token can write releases here, before a release has published anything. */
export async function checkToken(repository) {
  const response = await api('', { repository })
  if (!response.ok)
    fail(
      `GitHub rejected the token for ${repository.owner}/${repository.name}: ${response.status} ${response.text}`,
    )
  if (!response.body?.permissions?.push) {
    fail(
      `the GitHub token has no push permission on ${repository.owner}/${repository.name}, so it cannot create a release.`,
    )
  }
  return response.body.full_name
}

export async function releaseByTag(repository, tag) {
  const response = await api(`/releases/tags/${encodeURIComponent(tag)}`, { repository })
  return response.ok ? response.body : undefined
}

/**
 * Create or update the release for a tag.
 *
 * Updating rather than failing on a second run matters: publishing to npm happens before this step,
 * so a release that got as far as the registry and then hit a network error has to be finishable by
 * re-running, not by hand-editing GitHub.
 */
export async function upsertRelease(repository, { tag, name, body, prerelease }) {
  const existing = await releaseByTag(repository, tag)
  const payload = {
    tag_name: tag,
    name,
    body,
    draft: false,
    prerelease,
    make_latest: prerelease ? 'false' : 'true',
  }
  const response = existing
    ? await api(`/releases/${existing.id}`, { method: 'PATCH', body: payload, repository })
    : await api('/releases', { method: 'POST', body: payload, repository })
  if (!response.ok) fail(`GitHub refused the release: ${response.status} ${response.text}`)
  return { url: response.body.html_url, updated: Boolean(existing) }
}

export async function deleteRelease(repository, tag) {
  const existing = await releaseByTag(repository, tag)
  if (!existing) return { deleted: false, reason: 'no release for that tag' }
  const response = await api(`/releases/${existing.id}`, { method: 'DELETE', repository })
  if (!response.ok) fail(`GitHub refused to delete the release: ${response.status} ${response.text}`)
  return { deleted: true, url: existing.html_url }
}
