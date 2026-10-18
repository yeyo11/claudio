import type { ClaudioDistribution, ClaudioReleaseInfo } from '@claudio/shared';
import type { EventBus } from './events.ts';
import type { CoreConfig } from './paths.ts';
import { VERSION, VersionCheck, compareVersions, type VersionCheckOptions } from './version-check.ts';

// `latest` never answers with a draft or a pre-release, so an edge build is never offered
const RELEASES_URL = 'https://api.github.com/repos/yeyo11/claudio/releases/latest';
const DISTRIBUTIONS: readonly ClaudioDistribution[] = ['docker', 'appimage', 'deb'];

/** A file attached to a release: the server bundle, its manifest and signature among them */
export interface ReleaseAsset {
  name: string;
  url: string;
}

interface Stored {
  latest: string | null;
  publishedAt: string | null;
  url: string | null;
  checkedAt: string | null;
  /** What the release attaches, for an in-app update to find its bundle; a mirror must serve the same shape */
  assets: ReleaseAsset[];
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function assetsOf(value: unknown): ReleaseAsset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((asset: unknown) => {
    if (!asset || typeof asset !== 'object') return [];
    const { name, url, browser_download_url: download } = asset as Record<string, unknown>;
    const href = text(download) ?? text(url);
    return typeof name === 'string' && href ? [{ name, url: href }] : [];
  });
}

export interface ReleaseWatchOptions extends VersionCheckOptions {
  /** The version this server runs */
  current: string;
  /** Where `system.release` goes when a check finds a newer release */
  events?: EventBus;
}

/**
 * Whether a newer Claudio than this one has been released, for every client of this server: the
 * one check a deployment runs, so a desktop window, a browser tab and a phone all agree. GitHub is
 * asked on demand or once a day, and what it said is kept in `release.json`.
 */
export class ReleaseWatch extends VersionCheck<Stored> {
  private readonly current: string;
  private readonly events: EventBus | undefined;
  /** Seeded with what the file holds, so a restart does not announce the same release again */
  private announced: string | null;

  constructor(config: CoreConfig, options: ReleaseWatchOptions) {
    super(
      config,
      {
        file: 'release.json',
        offSwitch: 'CLAUDIO_UPDATE_CHECK',
        empty: { latest: null, publishedAt: null, url: null, checkedAt: null, assets: [] },
        parse: (saved) => ({
          latest: text(saved.latest),
          publishedAt: text(saved.publishedAt),
          url: text(saved.url),
          checkedAt: text(saved.checkedAt),
          assets: assetsOf(saved.assets),
        }),
      },
      options,
    );
    this.current = options.current;
    this.events = options.events;
    this.announced = this.stored.latest;
  }

  get distribution(): ClaudioDistribution {
    const value = this.env.CLAUDIO_DISTRIBUTION?.trim().toLowerCase();
    return DISTRIBUTIONS.find((d) => d === value) ?? 'source';
  }

  /** What the last check learned. Never touches the network. */
  info(): ClaudioReleaseInfo {
    const { latest, publishedAt, url, checkedAt } = this.stored;
    return {
      current: this.current,
      latest,
      publishedAt,
      url,
      checkedAt,
      updateAvailable: latest !== null && compareVersions(latest, this.current) > 0,
      distribution: this.distribution,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /** The newest release and what it attaches, as the last check left them. Never touches the network. */
  latestRelease(): { version: string; assets: ReleaseAsset[] } | null {
    const { latest, assets } = this.stored;
    return latest === null ? null : { version: latest, assets };
  }

  protected async fetchLatest(): Promise<Stored> {
    const url = this.env.CLAUDIO_RELEASES_URL || RELEASES_URL;
    const res = await this.fetchFn(url, {
      // GitHub refuses a request without a user-agent
      headers: { accept: 'application/vnd.github+json', 'user-agent': `claudio/${this.current}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown; published_at?: unknown; assets?: unknown };
    const version = typeof body.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : '';
    if (!VERSION.test(version)) throw new Error('the release has no version tag');
    return { latest: version, publishedAt: text(body.published_at), url: text(body.html_url), checkedAt: this.checkedAtIso, assets: assetsOf(body.assets) };
  }

  protected failure(reason: string): string {
    return `Could not reach GitHub: ${reason}`;
  }

  protected afterCheck(): void {
    const release = this.info();
    const { latest } = release;
    if (latest === null || !release.updateAvailable) return;
    if (this.announced !== null && compareVersions(latest, this.announced) <= 0) return;
    this.announced = latest;
    this.events?.emit({ type: 'system.release', title: `Claudio ${latest} is available`, release });
  }
}
