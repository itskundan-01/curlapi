/**
 * Updating the application in place.
 *
 * The thing that makes this cheap is what the payload is: the whole application
 * is well under a megabyte, because the browser belongs to the user and the Node
 * runtime is installed once and then left alone. So an update is not a new
 * installer to download and re-run — it is a small archive, unpacked over the
 * one directory the installer owns. The runtime is not touched, nothing outside
 * ~/.curlapi is touched, and there is no operating-system machinery involved in
 * replacing a signed application bundle.
 *
 * That last point is the one that matters for a project with no signing
 * certificate. Replacing files inside a directory needs no notarisation and
 * raises no SmartScreen prompt, so this path works for free on all three
 * platforms — which the usual "download and relaunch a new binary" flow does
 * not.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { HOME, IS_MANAGED_INSTALL, PROJECT_ROOT, REPO, VERSION } from '../paths.ts';
import { extractZip, looksLikeCurlapiPayload } from './zip.ts';

export type ReleaseInfo = {
  version: string;
  /** Direct download for the payload zip, or null if the release has none. */
  downloadUrl: string | null;
  /** URL of the SHA256SUMS asset published beside it. */
  checksumsUrl: string | null;
  notes: string;
  publishedAt: string | null;
};

export type UpdateStatus = {
  current: string;
  latest: string | null;
  available: boolean;
  /** False for an npm or from-source checkout, where npm owns the files. */
  updatable: boolean;
  /** Why an update cannot be applied here, when `updatable` is false. */
  reason: string | null;
  /**
   * Why the check produced no answer, when `latest` is null.
   *
   * "Nobody has published a release yet" and "this machine cannot reach GitHub"
   * both leave the caller with no version to compare against, and telling a user
   * their network is broken when the truth is that the project has not shipped
   * yet sends them looking in the wrong place.
   */
  checkError: string | null;
  release: ReleaseInfo | null;
};

// --- versions -------------------------------------------------------------

type Parsed = { parts: number[]; prerelease: string[] };

function parseVersion(input: string): Parsed {
  const [core, pre] = input.replace(/^v/, '').split('-', 2);
  return {
    parts: core.split('.').map((n) => Number(n) || 0),
    prerelease: pre ? pre.split('.') : [],
  };
}

/**
 * Semver ordering, to the extent this project uses it.
 *
 * The one rule worth spelling out is that a prerelease sorts *below* the release
 * it leads to, so 0.2.0-beta.1 is older than 0.2.0. Getting that backwards would
 * strand every beta user on the last beta, which is precisely the group who most
 * need the update to arrive.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);

  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i++) {
    const difference = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;

  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
    const l = left.prerelease[i];
    const r = right.prerelease[i];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;

    // Numeric identifiers compare as numbers, so beta.10 is newer than beta.9
    // rather than sorting before it as text.
    const bothNumeric = /^\d+$/.test(l) && /^\d+$/.test(r);
    if (bothNumeric) return Number(l) < Number(r) ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

// --- checking -------------------------------------------------------------

type GitHubAsset = { name: string; browser_download_url: string };
type GitHubRelease = {
  tag_name?: string;
  body?: string;
  published_at?: string;
  assets?: GitHubAsset[];
};

/**
 * Asks GitHub what the newest release is.
 *
 * Never throws: an update check is a background courtesy, and a machine that is
 * offline or behind a proxy that blocks api.github.com should see a workspace
 * that works, not an error about a feature it did not ask for.
 */
export async function checkForUpdate(timeoutMs = 6000): Promise<UpdateStatus> {
  const base: UpdateStatus = {
    current: VERSION,
    latest: null,
    available: false,
    updatable: IS_MANAGED_INSTALL,
    reason: IS_MANAGED_INSTALL
      ? null
      : `This copy runs from ${PROJECT_ROOT}, which the installer does not own. ` +
        'Update it the way it was installed — `npm update -g curlapi`, or `git pull`.',
    checkError: null,
    release: null,
  };

  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 404) {
      return { ...base, checkError: `${REPO} has not published any releases yet.` };
    }
    if (!response.ok) {
      return {
        ...base,
        checkError:
          response.status === 403
            ? "GitHub's API rate limit is exhausted for this network; try again later."
            : `GitHub answered HTTP ${response.status} when asked about releases.`,
      };
    }

    const body = (await response.json()) as GitHubRelease;
    const latest = (body.tag_name ?? '').replace(/^v/, '');
    if (!latest) return { ...base, checkError: 'The newest release has no version tag.' };

    const assets = body.assets ?? [];
    const payload = assets.find((a) => a.name.endsWith('-app.zip'));
    const checksums = assets.find((a) => a.name === 'SHA256SUMS');

    return {
      ...base,
      latest,
      available: compareVersions(latest, VERSION) > 0,
      release: {
        version: latest,
        downloadUrl: payload?.browser_download_url ?? null,
        checksumsUrl: checksums?.browser_download_url ?? null,
        notes: body.body ?? '',
        publishedAt: body.published_at ?? null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      checkError:
        err instanceof Error && err.name === 'TimeoutError'
          ? 'GitHub did not answer in time.'
          : `Could not reach GitHub: ${message}`,
    };
  }
}

/**
 * The same check, at most once a day, and only if the user has not opted out.
 *
 * Reaching for the network at startup is a real cost in a tool whose selling
 * point is that it runs locally and sends nothing anywhere, so it is worth being
 * careful about: one request a day, to GitHub, asking only what the latest tag
 * is. `CURLAPI_NO_UPDATE_CHECK=1` turns even that off, and the answer is cached
 * on disk so a machine that opens the workspace ten times a day does not ask ten
 * times.
 */
export async function checkForUpdateDaily(): Promise<UpdateStatus | null> {
  if (process.env['CURLAPI_NO_UPDATE_CHECK']) return null;

  const stampPath = join(HOME, 'update-check.json');
  const day = 24 * 60 * 60 * 1000;

  try {
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8')) as {
      at?: number;
      status?: UpdateStatus;
    };
    if (stamp.at && Date.now() - stamp.at < day && stamp.status) {
      // The recorded answer was about the version installed at the time. After
      // an update it describes the release we are now running, and replaying it
      // would announce an update to the version already in use.
      return stamp.status.current === VERSION ? stamp.status : null;
    }
  } catch {
    // No stamp, or an unreadable one. Either way, check.
  }

  // A short timeout: this runs while the user is waiting for a workspace, and a
  // slow network must not hold that up.
  const status = await checkForUpdate(3000);
  if (!status.latest) return null;

  try {
    writeFileSync(stampPath, JSON.stringify({ at: Date.now(), status }), 'utf8');
  } catch {
    // Failing to record the check only means checking again sooner.
  }
  return status;
}

// --- applying -------------------------------------------------------------

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Finds the recorded hash for one file in a SHA256SUMS listing.
 *
 * Matched on the whole final field rather than with `endsWith`, because
 * `curlapi-0.3.0-app.zip` is a suffix of nothing but itself while
 * `app.zip` is a suffix of every payload ever published. Returns null when the
 * listing has no entry, which the caller must treat as a failure — see
 * `applyUpdate`.
 */
export function expectedChecksumFor(sums: string, fileName: string): string | null {
  for (const line of sums.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 2) continue;
    // The name may be prefixed with `*` for binary mode, which sha256sum writes
    // and which is not part of the name.
    if (fields[fields.length - 1].replace(/^\*/, '') === fileName) return fields[0];
  }
  return null;
}

async function download(url: string, timeoutMs: number): Promise<Buffer> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

export type ApplyProgress = (message: string) => void;

/**
 * Replaces the installed application with `release`.
 *
 * The swap is three renames rather than an overwrite, so the window in which the
 * installation is neither the old version nor the new one is as short as the
 * filesystem can make it. If anything fails before that point nothing has moved
 * yet, and if the final rename fails the previous version is put back.
 */
export async function applyUpdate(
  release: ReleaseInfo,
  onProgress: ApplyProgress = () => {},
): Promise<void> {
  if (!IS_MANAGED_INSTALL) {
    throw new Error(
      `This copy runs from ${PROJECT_ROOT}, which the desktop installer does not own, ` +
        'so replacing it would fight whatever does. Use `npm update -g curlapi` instead.',
    );
  }
  if (!release.downloadUrl) {
    throw new Error(`Release ${release.version} publishes no application payload to install.`);
  }

  onProgress(`Downloading curlapi ${release.version}`);
  const payload = await download(release.downloadUrl, 120_000);

  // Verification is required, not attempted. Every path that cannot produce a
  // confirmed hash fails the update, because the alternative — carrying on and
  // reporting success — is indistinguishable to the user from having checked,
  // and this is the one place where a bad download gets to replace the program.
  if (!release.checksumsUrl) {
    throw new Error(
      `Release ${release.version} publishes no SHA256SUMS, so the download cannot be ` +
        'verified. Nothing has been changed.',
    );
  }

  onProgress('Verifying the download');
  const sums = (await download(release.checksumsUrl, 30_000)).toString('utf8');
  const name = release.downloadUrl.split('/').pop() ?? '';
  const expected = expectedChecksumFor(sums, name);

  if (!expected) {
    throw new Error(
      `The checksums published for ${release.version} have no entry for ${name}, ` +
        'so the download cannot be verified. Nothing has been changed.',
    );
  }

  const actual = sha256(payload);
  if (expected !== actual) {
    throw new Error(
      `Checksum mismatch on the ${release.version} payload.\n` +
        `  expected  ${expected}\n  got       ${actual}\n` +
        'Nothing has been changed.',
    );
  }

  if (!looksLikeCurlapiPayload(payload)) {
    throw new Error('The downloaded archive does not contain a curlapi build. Nothing has been changed.');
  }

  const staging = join(HOME, '.staging-update');
  const previous = join(HOME, 'app.previous');
  const target = join(HOME, 'app');

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  onProgress('Unpacking');
  const result = extractZip(payload, staging);
  if (result.rejected.length > 0) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(
      `The payload tried to write outside the install directory (${result.rejected[0]}). ` +
        'Nothing has been changed.',
    );
  }
  if (!existsSync(join(staging, 'src', 'cli.ts'))) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error('The unpacked payload has no src/cli.ts in it. Nothing has been changed.');
  }

  onProgress('Installing');
  rmSync(previous, { recursive: true, force: true });
  if (existsSync(target)) renameSync(target, previous);

  try {
    renameSync(staging, target);
  } catch (err) {
    // Put the working version back before reporting: leaving no application at
    // all is a far worse outcome than a failed update.
    if (existsSync(previous) && !existsSync(target)) renameSync(previous, target);
    throw err;
  }

  rmSync(previous, { recursive: true, force: true });

  // Recorded so a later run can say what it came from, and so the desktop
  // launcher's log carries the history when something goes wrong after an
  // update rather than before one.
  try {
    writeFileSync(
      join(HOME, 'last-update.json'),
      JSON.stringify(
        { from: VERSION, to: release.version, at: new Date().toISOString() },
        null,
        2,
      ),
      'utf8',
    );
  } catch {
    // A note we could not write is not a reason to call the update a failure.
  }
}

/** Reads the recorded result of the last update, if there was one. */
export function lastUpdate(): { from: string; to: string; at: string } | null {
  try {
    return JSON.parse(readFileSync(join(HOME, 'last-update.json'), 'utf8')) as {
      from: string;
      to: string;
      at: string;
    };
  } catch {
    return null;
  }
}
