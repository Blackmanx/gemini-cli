/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { fetchWithTimeout } from '../utils/fetch.js';
import {
  registerHandler,
  type InternalPage,
  type SiteHandler,
} from './types.js';

/**
 * Built-in site readers, ported from oh-my-pi's web scrapers.
 *
 * Rules every handler here obeys:
 * - no API key, no OAuth, no paid or login-gated source;
 * - `null` on anything unexpected, so the caller falls back to plain fetching
 *   instead of failing;
 * - uncertainty goes into `notes`, never into invented content.
 *
 * No third-party reader service (firecrawl/jina/parallel) and no SERP scraper
 * is used anywhere here: every source is a documented public endpoint.
 */

const HANDLER_TIMEOUT_MS = 10_000;
const USER_AGENT =
  'Mozilla/5.0 (compatible; Google-Gemini-CLI/1.0; +https://github.com/google-gemini/gemini-cli)';
/** Raw file/feed payloads are cut here so one huge response cannot flood context. */
const RAW_TEXT_LIMIT = 200_000;
const MAX_ITEMS = 25;

// ---------------------------------------------------------------------------
// Shared JSON / formatting helpers
// ---------------------------------------------------------------------------

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return isJsonObject(value) ? value : undefined;
}

function jsonString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function jsonNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function jsonBoolean(value: unknown): boolean {
  return value === true;
}

function jsonArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: unknown[] = [];
  for (const item of value) {
    out.push(item);
  }
  return out;
}

function jsonStringList(value: unknown): string[] {
  const out: string[] = [];
  for (const item of jsonArray(value)) {
    const text = jsonString(item);
    if (text !== undefined) {
      out.push(text);
    }
  }
  return out;
}

function isoDate(value: unknown): string | undefined {
  const text = jsonString(value);
  if (text === undefined) {
    return undefined;
  }
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime())
    ? undefined
    : parsed.toISOString().slice(0, 10);
}

function truncated(
  value: string,
  limit: number,
): { text: string; truncated: boolean } {
  if (value.length <= limit) {
    return { text: value, truncated: false };
  }
  return { text: `${value.slice(0, limit)}\n\n… [truncated]`, truncated: true };
}

function bullet(
  items: readonly string[],
  maxItems: number = items.length,
): string {
  const lines = items.slice(0, maxItems).map((item) => `- ${item}`);
  if (items.length > maxItems) {
    lines.push(`- … ${items.length - maxItems} more not shown`);
  }
  return lines.join('\n');
}

function sections(parts: ReadonlyArray<string | undefined>): string {
  return parts
    .filter((part) => part !== undefined && part.trim().length > 0)
    .join('\n\n');
}

type MetaEntry = readonly [string, string | number | undefined];

function metaBlock(entries: readonly MetaEntry[]): string {
  const lines: string[] = [];
  for (const [label, value] of entries) {
    if (value === undefined) {
      continue;
    }
    lines.push(`**${label}:** ${value}`);
  }
  return lines.join('\n');
}

function markdownPage(content: string, notes: string[]): InternalPage {
  return { content, contentType: 'text/markdown', notes };
}

async function fetchText(
  url: string,
  accept: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    const response = await fetchWithTimeout(url, HANDLER_TIMEOUT_MS, {
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
    if (!response.ok) {
      return undefined;
    }
    return await response.text();
  } catch {
    return undefined;
  }
}

async function fetchJson(
  url: string,
  signal: AbortSignal | undefined,
  accept: string = 'application/json',
): Promise<Record<string, unknown> | undefined> {
  const text = await fetchText(url, accept, signal);
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return jsonObject(parsed);
  } catch {
    return undefined;
  }
}

function firstNonEmpty(
  parts: ReadonlyArray<string | undefined>,
): string | undefined {
  for (const part of parts) {
    if (part !== undefined && part.trim().length > 0) {
      return part.trim();
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Security databases
// ---------------------------------------------------------------------------

const CVE_PATTERN = /CVE-\d{4}-\d{4,7}/i;

function nvdCvssSection(metrics: Record<string, unknown> | undefined): string {
  if (metrics === undefined) {
    return '';
  }
  const lines: string[] = [];
  for (const [key, value] of Object.entries(metrics)) {
    if (!key.startsWith('cvssMetricV')) {
      continue;
    }
    for (const entry of jsonArray(value)) {
      const metric = jsonObject(entry);
      const data = jsonObject(metric?.['cvssData']);
      const parts: string[] = [];
      const score = jsonNumber(data?.['baseScore']);
      if (score !== undefined) {
        const severity = jsonString(data?.['baseSeverity']);
        parts.push(
          `base score ${score}${severity === undefined ? '' : ` (${severity})`}`,
        );
      }
      const vector = jsonString(data?.['vectorString']);
      if (vector !== undefined) {
        parts.push(`vector \`${vector}\``);
      }
      const impact = jsonNumber(metric?.['impactScore']);
      if (impact !== undefined) {
        parts.push(`impact ${impact}`);
      }
      const exploitability = jsonNumber(metric?.['exploitabilityScore']);
      if (exploitability !== undefined) {
        parts.push(`exploitability ${exploitability}`);
      }
      if (parts.length > 0) {
        lines.push(
          `- **${key.replace('cvssMetric', '')}:** ${parts.join(', ')}`,
        );
      }
    }
  }
  return lines.join('\n');
}

function nvdCpeList(configurations: unknown): string[] {
  const cpes: string[] = [];
  for (const configuration of jsonArray(configurations)) {
    for (const node of jsonArray(jsonObject(configuration)?.['nodes'])) {
      for (const match of jsonArray(jsonObject(node)?.['cpeMatch'])) {
        const entry = jsonObject(match);
        const criteria = jsonString(entry?.['criteria']);
        if (
          jsonBoolean(entry?.['vulnerable']) &&
          criteria !== undefined &&
          !cpes.includes(criteria)
        ) {
          cpes.push(criteria);
        }
      }
    }
  }
  return cpes;
}

const nvdHandler: SiteHandler = {
  hosts: ['nvd.nist.gov', 'services.nvd.nist.gov'],
  kind: 'NVD CVE record',
  async handle(url, signal) {
    const match =
      CVE_PATTERN.exec(url.pathname) ?? CVE_PATTERN.exec(url.search);
    if (match === null) {
      return null;
    }
    const cveId = match[0].toUpperCase();
    const data = await fetchJson(
      `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cveId}`,
      signal,
    );
    const cve = jsonObject(
      jsonObject(jsonArray(data?.['vulnerabilities'])[0])?.['cve'],
    );
    if (cve === undefined) {
      return null;
    }

    let description: string | undefined;
    for (const entry of jsonArray(cve['descriptions'])) {
      if (jsonObject(entry)?.['lang'] === 'en') {
        description = jsonString(jsonObject(entry)?.['value']);
        break;
      }
    }

    const weaknesses: string[] = [];
    for (const weakness of jsonArray(cve['weaknesses'])) {
      for (const entry of jsonArray(jsonObject(weakness)?.['description'])) {
        const record = jsonObject(entry);
        const value = jsonString(record?.['value']);
        if (
          record?.['lang'] === 'en' &&
          value !== undefined &&
          value !== 'NVD-CWE-Other' &&
          value !== 'NVD-CWE-noinfo' &&
          !weaknesses.includes(value)
        ) {
          weaknesses.push(value);
        }
      }
    }

    const references: string[] = [];
    for (const reference of jsonArray(cve['references'])) {
      const record = jsonObject(reference);
      const href = jsonString(record?.['url']);
      if (href === undefined) {
        continue;
      }
      const tags = jsonStringList(record?.['tags']);
      references.push(tags.length > 0 ? `${href} (${tags.join(', ')})` : href);
    }

    const cpes = nvdCpeList(cve['configurations']);
    const content = sections([
      `# ${jsonString(cve['id']) ?? cveId}`,
      metaBlock([
        ['Status', jsonString(cve['vulnStatus'])],
        ['Source', jsonString(cve['sourceIdentifier'])],
        ['Published', isoDate(cve['published'])],
        ['Modified', isoDate(cve['lastModified'])],
      ]),
      description === undefined
        ? undefined
        : `## Description\n\n${description}`,
      nvdCvssSection(jsonObject(cve['metrics'])) === ''
        ? undefined
        : `## CVSS\n\n${nvdCvssSection(jsonObject(cve['metrics']))}`,
      weaknesses.length > 0
        ? `## Weaknesses\n\n${bullet(weaknesses, MAX_ITEMS)}`
        : undefined,
      cpes.length > 0
        ? `## Affected Products\n\n${bullet(cpes, MAX_ITEMS)}`
        : undefined,
      references.length > 0
        ? `## References\n\n${bullet(references, MAX_ITEMS)}`
        : undefined,
    ]);

    return markdownPage(content, [
      'Fetched via the public NVD CVE API (no key required).',
      ...(cpes.length > MAX_ITEMS
        ? [`${cpes.length} CPEs in total, ${MAX_ITEMS} shown.`]
        : []),
    ]);
  },
};

const osvHandler: SiteHandler = {
  hosts: ['osv.dev', 'api.osv.dev'],
  kind: 'OSV vulnerability record',
  async handle(url, signal) {
    const match = /^\/(?:v1\/vulns|vulnerability)\/([A-Za-z0-9._-]+)$/.exec(
      url.pathname,
    );
    if (match === null) {
      return null;
    }
    const vulnId = match[1];
    if (vulnId === undefined) {
      return null;
    }
    const vuln = await fetchJson(
      `https://api.osv.dev/v1/vulns/${vulnId}`,
      signal,
    );
    if (vuln === undefined || jsonString(vuln['id']) === undefined) {
      return null;
    }

    const affectedSections: string[] = [];
    for (const affected of jsonArray(vuln['affected'])) {
      const record = jsonObject(affected);
      const pkg = jsonObject(record?.['package']);
      const pkgName = jsonString(pkg?.['name']);
      if (record === undefined || pkgName === undefined) {
        continue;
      }
      const heading = `### ${jsonString(pkg?.['ecosystem']) ?? 'package'}: ${pkgName}`;
      const ranges: string[] = [];
      for (const range of jsonArray(record['ranges'])) {
        const rangeRecord = jsonObject(range);
        const events: string[] = [];
        for (const event of jsonArray(rangeRecord?.['events'])) {
          const eventRecord = jsonObject(event);
          for (const key of [
            'introduced',
            'fixed',
            'last_affected',
            'limit',
          ] as const) {
            const value = jsonString(eventRecord?.[key]);
            if (value !== undefined) {
              events.push(`${key}: ${value}`);
            }
          }
        }
        if (events.length > 0) {
          ranges.push(
            `- **${jsonString(rangeRecord?.['type']) ?? 'range'}:** ${events.join(' → ')}`,
          );
        }
      }
      const versions = jsonStringList(record['versions']);
      const details = sections([
        ranges.length > 0 ? ranges.join('\n') : undefined,
        versions.length > 0
          ? `- **Versions:** ${truncated(versions.join(', '), 2000).text}`
          : undefined,
        ...jsonArray(record['severity']).map((severity) => {
          const sevRecord = jsonObject(severity);
          const score = jsonString(sevRecord?.['score']);
          return score === undefined
            ? undefined
            : `- **Severity (${jsonString(sevRecord?.['type']) ?? 'unknown'}):** ${score}`;
        }),
      ]);
      affectedSections.push(sections([heading, details]));
    }

    const references = jsonArray(vuln['references']).map((reference) => {
      const record = jsonObject(reference);
      const href = jsonString(record?.['url']);
      if (href === undefined) {
        return undefined;
      }
      const type = jsonString(record?.['type']);
      return type === undefined ? `- ${href}` : `- [${type}](${href})`;
    });
    const creditLines = jsonArray(vuln['credits']).map((credit) => {
      const record = jsonObject(credit);
      const name = jsonString(record?.['name']);
      if (name === undefined) {
        return undefined;
      }
      const type = jsonString(record?.['type']);
      return `- ${name}${type === undefined ? '' : ` (${type})`}`;
    });
    const severities = jsonArray(vuln['severity']).map((severity) => {
      const record = jsonObject(severity);
      const score = jsonString(record?.['score']);
      return score === undefined
        ? undefined
        : `${jsonString(record?.['type']) ?? 'severity'}: ${score}`;
    });

    const content = sections([
      `# ${jsonString(vuln['id']) ?? vulnId}`,
      jsonString(vuln['summary']),
      metaBlock([
        ['Aliases', jsonStringList(vuln['aliases']).join(', ') || undefined],
        ['Published', isoDate(vuln['published'])],
        ['Modified', isoDate(vuln['modified'])],
        ['Withdrawn', isoDate(vuln['withdrawn'])],
        ['Severity', severities.length > 0 ? severities.join(', ') : undefined],
      ]),
      jsonString(vuln['details']) === undefined
        ? undefined
        : `## Details\n\n${jsonString(vuln['details'])}`,
      affectedSections.length > 0
        ? `## Affected Packages\n\n${affectedSections.join('\n\n')}`
        : undefined,
      creditLines.length > 0
        ? `## Credits\n\n${bullet(
            creditLines.filter((line) => line !== undefined),
            MAX_ITEMS,
          )}`
        : undefined,
      references.length > 0
        ? `## References\n\n${bullet(
            references.filter((line) => line !== undefined),
            MAX_ITEMS,
          )}`
        : undefined,
    ]);

    return markdownPage(content, [
      'Fetched via the public OSV API (no key required).',
    ]);
  },
};

const KEV_FEED_URL =
  'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

const cisaKevHandler: SiteHandler = {
  hosts: ['cisa.gov'],
  kind: 'CISA Known Exploited Vulnerabilities catalog',
  async handle(url, signal) {
    const path = url.pathname.toLowerCase();
    if (!path.includes('known-exploited') && !path.endsWith('.json')) {
      return null;
    }
    const catalog = await fetchJson(KEV_FEED_URL, signal);
    if (catalog === undefined) {
      return null;
    }
    const entries = jsonArray(catalog['vulnerabilities']);
    if (entries.length === 0) {
      return null;
    }
    const notes = [
      'Fetched via the public CISA KEV feed (the whole catalog is downloaded, then filtered).',
    ];
    const requested =
      CVE_PATTERN.exec(url.pathname) ?? CVE_PATTERN.exec(url.search);

    if (requested !== null) {
      const cveId = requested[0].toUpperCase();
      const record = entries
        .map((entry) => jsonObject(entry))
        .find((entry) => jsonString(entry?.['cveID'])?.toUpperCase() === cveId);
      if (record === undefined) {
        return null;
      }
      const content = sections([
        `# ${cveId} — Known Exploited Vulnerability`,
        jsonString(record['vulnerabilityName']),
        metaBlock([
          ['Vendor', jsonString(record['vendorProject'])],
          ['Product', jsonString(record['product'])],
          ['Date added', jsonString(record['dateAdded'])],
          ['Due date', jsonString(record['dueDate'])],
          [
            'Ransomware campaign use',
            jsonString(record['knownRansomwareCampaignUse']),
          ],
        ]),
        jsonString(record['shortDescription']) === undefined
          ? undefined
          : `## Description\n\n${jsonString(record['shortDescription'])}`,
        jsonString(record['requiredAction']) === undefined
          ? undefined
          : `## Required action\n\n${jsonString(record['requiredAction'])}`,
      ]);
      return markdownPage(content, notes);
    }

    notes.push(
      `No CVE in the URL, so this is a catalog summary: ${entries.length} entries, newest first.`,
    );
    const newest = entries
      .map((entry) => jsonObject(entry))
      .filter((entry) => entry !== undefined)
      .sort((left, right) =>
        (jsonString(right?.['dateAdded']) ?? '').localeCompare(
          jsonString(left?.['dateAdded']) ?? '',
        ),
      );
    const content = sections([
      `# CISA Known Exploited Vulnerabilities`,
      metaBlock([
        ['Catalog version', jsonString(catalog['catalogVersion'])],
        ['Released', isoDate(catalog['dateReleased'])],
        ['Entries', jsonNumber(catalog['count']) ?? entries.length],
      ]),
      `## Most recently added\n\n${bullet(
        newest.slice(0, MAX_ITEMS).map((entry) => {
          const cve = jsonString(entry?.['cveID']);
          const name = jsonString(entry?.['vulnerabilityName']);
          const added = jsonString(entry?.['dateAdded']);
          return [cve, name, added === undefined ? undefined : `added ${added}`]
            .filter((part) => part !== undefined)
            .join(' — ');
        }),
        MAX_ITEMS,
      )}`,
    ]);
    return markdownPage(content, notes);
  },
};

// ---------------------------------------------------------------------------
// Package registries
// ---------------------------------------------------------------------------

const npmHandler: SiteHandler = {
  hosts: ['npmjs.com', 'registry.npmjs.org'],
  kind: 'npm package metadata',
  async handle(url, signal) {
    const segments = url.pathname.split('/').filter((part) => part.length > 0);
    if (segments[0] === 'package') {
      segments.shift();
    }
    const head = segments[0];
    if (head === undefined) {
      return null;
    }
    let name = decodeURIComponent(head);
    if (head.startsWith('@')) {
      const tail = segments[1];
      if (tail === undefined) {
        return null;
      }
      name = `${decodeURIComponent(head)}/${decodeURIComponent(tail)}`;
    }

    const doc = await fetchJson(
      `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
      signal,
    );
    const version = jsonString(doc?.['version']);
    if (doc === undefined || version === undefined) {
      return null;
    }
    const repository =
      jsonString(jsonObject(doc['repository'])?.['url']) ??
      jsonString(doc['repository']);
    const dependencies = jsonObject(doc['dependencies']);
    const notes = [
      'Fetched via the public npm registry (latest version only, no auth token).',
    ];
    if (jsonString(doc['deprecated']) !== undefined) {
      notes.push(
        `This version is deprecated: ${jsonString(doc['deprecated'])}`,
      );
    }

    const content = sections([
      `# ${name}`,
      jsonString(doc['description']),
      metaBlock([
        ['Version', version],
        ['License', jsonString(doc['license'])],
        ['Homepage', jsonString(doc['homepage'])],
        ['Repository', repository?.replace(/^git\+/, '').replace(/\.git$/, '')],
        ['Published', undefined],
        ['Node engine', jsonString(jsonObject(doc['engines'])?.['node'])],
      ]),
      jsonString(doc['description']) === undefined ? undefined : undefined,
      metaBlock([['Downloads (last week)', undefined]]),
      jsonStringList(doc['keywords']).length > 0
        ? `**Keywords:** ${jsonStringList(doc['keywords']).join(', ')}`
        : undefined,
      dependencies === undefined || Object.keys(dependencies).length === 0
        ? undefined
        : `## Dependencies (${Object.keys(dependencies).length})\n\n${bullet(
            Object.entries(dependencies).map(
              ([dep, range]) => `${dep} \`${jsonString(range) ?? ''}\``,
            ),
            MAX_ITEMS,
          )}`,
      `## Tarball\n\n${jsonString(jsonObject(doc['dist'])?.['tarball']) ?? 'unknown'}`,
    ]);
    return markdownPage(content, notes);
  },
};

const pypiHandler: SiteHandler = {
  hosts: ['pypi.org', 'www.pypi.org'],
  kind: 'PyPI package metadata',
  async handle(url, signal) {
    const match = /^\/project\/([^/]+)\/?$/.exec(url.pathname);
    if (match === null || match[1] === undefined) {
      return null;
    }
    const name = decodeURIComponent(match[1]);
    const data = await fetchJson(
      `https://pypi.org/pypi/${encodeURIComponent(name)}/json`,
      signal,
    );
    const info = jsonObject(data?.['info']);
    const version = jsonString(info?.['version']);
    if (info === undefined || version === undefined) {
      return null;
    }
    const projectUrls = jsonObject(info['project_urls']);
    const urlLines =
      projectUrls === undefined
        ? []
        : Object.entries(projectUrls).map(([label, target]) => {
            const href = jsonString(target);
            return href === undefined ? undefined : `- [${label}](${href})`;
          });
    const requires = jsonStringList(info['requires_dist']);
    const releases = jsonObject(data?.['releases']);

    const content = sections([
      `# ${jsonString(info['name']) ?? name} ${version}`,
      jsonString(info['summary']),
      metaBlock([
        [
          'Author',
          firstNonEmpty([
            jsonString(info['author']),
            jsonString(info['maintainer']),
          ]),
        ],
        [
          'License',
          firstNonEmpty([
            jsonString(info['license']),
            ...jsonStringList(info['classifiers']).filter((entry) =>
              entry.startsWith('License ::'),
            ),
          ]),
        ],
        ['Requires Python', jsonString(info['requires_python'])],
        ['Released', isoDate(info['upload_time_iso_8601'])],
        [
          'Releases on PyPI',
          releases === undefined ? undefined : Object.keys(releases).length,
        ],
        ['Home page', jsonString(info['home_page'])],
      ]),
      urlLines.length > 0
        ? `## Project URLs\n\n${bullet(
            urlLines.filter((line) => line !== undefined),
            MAX_ITEMS,
          )}`
        : undefined,
      requires.length > 0
        ? `## Requirements\n\n${bullet(
            requires.map((entry) => `\`${entry}\``),
            MAX_ITEMS,
          )}`
        : undefined,
    ]);
    return markdownPage(content, [
      'Fetched via the public PyPI JSON API (latest version metadata only, no auth token).',
    ]);
  },
};

const cratesIoHandler: SiteHandler = {
  hosts: ['crates.io', 'docs.rs'],
  kind: 'crates.io package metadata',
  async handle(url, signal) {
    let crateName: string | undefined;
    const cratesMatch = /^\/crates\/([^/]+)/.exec(url.pathname);
    const docsMatch = /^\/(?:crate\/)?([^/]+)/.exec(url.pathname);
    crateName = cratesMatch?.[1] ?? docsMatch?.[1];
    if (crateName === undefined || crateName.length === 0) {
      return null;
    }
    crateName = decodeURIComponent(crateName);

    const data = await fetchJson(
      `https://crates.io/api/v1/crates/${encodeURIComponent(crateName)}`,
      signal,
    );
    const record = jsonObject(data?.['crate']);
    const maxVersion = jsonString(record?.['max_version']);
    if (record === undefined || maxVersion === undefined) {
      return null;
    }
    const versions = jsonArray(record['versions'])
      .map((entry) => jsonObject(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .map(
        (entry) =>
          `- \`${jsonString(entry['num']) ?? '?'}\`${
            jsonBoolean(entry['yanked']) ? ' (yanked)' : ''
          } — published ${isoDate(entry['created_at']) ?? 'unknown'}`,
      );
    const categories = jsonStringList(record['categories']);
    const keywords = jsonStringList(record['keywords']);

    const content = sections([
      `# ${jsonString(record['name']) ?? crateName} ${maxVersion}`,
      jsonString(record['description']),
      metaBlock([
        ['Downloads', jsonNumber(record['downloads'])?.toLocaleString('en-US')],
        [
          'Recent downloads',
          jsonNumber(record['recent_downloads'])?.toLocaleString('en-US'),
        ],
        ['Homepage', jsonString(record['homepage'])],
        ['Repository', jsonString(record['repository'])],
        ['Documentation', jsonString(record['documentation'])],
        ['Updated', isoDate(record['updated_at'])],
      ]),
      keywords.length > 0 ? `**Keywords:** ${keywords.join(', ')}` : undefined,
      categories.length > 0
        ? `**Categories:** ${categories.join(', ')}`
        : undefined,
      versions.length > 0
        ? `## Versions (newest first)\n\n${bullet(versions, MAX_ITEMS)}`
        : undefined,
    ]);
    return markdownPage(content, [
      'Fetched via the public crates.io API (no auth token).',
    ]);
  },
};

function nugetCatalogEntry(
  page: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const items = jsonArray(page['items']);
  const last = jsonObject(items[items.length - 1]);
  return jsonObject(last?.['catalogEntry']);
}

const nugetHandler: SiteHandler = {
  hosts: ['nuget.org', 'api.nuget.org'],
  kind: 'NuGet package metadata',
  async handle(url, signal) {
    const match = /^\/packages\/([^/]+)(?:\/([^/]+))?/.exec(url.pathname);
    if (match === null || match[1] === undefined) {
      return null;
    }
    const packageId = decodeURIComponent(match[1]);
    const requestedVersion = match[2];
    const base = `https://api.nuget.org/v3/registration5-semver2/${encodeURIComponent(
      packageId.toLowerCase(),
    )}`;

    let entry: Record<string, unknown> | undefined;
    let source = `${base}/index.json`;
    if (requestedVersion === undefined) {
      // Two hops: the index lists pages, and the last page holds the newest
      // version's catalog entry.
      for (let hop = 0; hop < 2 && entry === undefined; hop++) {
        const page = await fetchJson(source, signal);
        if (page === undefined) {
          return null;
        }
        entry = nugetCatalogEntry(page);
        if (entry === undefined) {
          source = jsonString(page['@id']);
          if (source === undefined) {
            break;
          }
        }
      }
    } else {
      entry = jsonObject(
        await fetchJson(
          `${base}/${encodeURIComponent(requestedVersion)}.json`,
          signal,
        ),
      );
    }
    const version = jsonString(entry?.['version']);
    if (entry === undefined || version === undefined) {
      return null;
    }

    const dependencyLines: string[] = [];
    for (const group of jsonArray(entry['dependencyGroups'])) {
      const groupRecord = jsonObject(group);
      const framework = jsonString(groupRecord?.['targetFramework']);
      for (const dependency of jsonArray(groupRecord?.['dependencies'])) {
        const record = jsonObject(dependency);
        const id = jsonString(record?.['id']);
        if (id === undefined) {
          continue;
        }
        const range = jsonString(record?.['range']);
        dependencyLines.push(
          `- ${id}${range === undefined ? '' : ` \`${range}\``}${framework === undefined ? '' : ` (${framework})`}`,
        );
      }
    }
    const authors = jsonStringList(entry['authors']);
    const tags = jsonStringList(entry['tags']);

    const content = sections([
      `# ${jsonString(entry['id']) ?? packageId} ${version}`,
      jsonString(entry['summary']) ?? jsonString(entry['description']),
      metaBlock([
        ['Authors', authors.join(', ') || undefined],
        ['Published', isoDate(entry['published'])],
        [
          'License',
          firstNonEmpty([
            jsonString(entry['licenseExpression']),
            jsonString(entry['licenseUrl']),
          ]),
        ],
        ['Project', jsonString(entry['projectUrl'])],
        ['Tags', tags.join(', ') || undefined],
      ]),
      dependencyLines.length > 0
        ? `## Dependencies\n\n${bullet(dependencyLines, MAX_ITEMS)}`
        : undefined,
    ]);
    return markdownPage(content, [
      'Fetched via the public NuGet registration API (no auth token).',
      ...(requestedVersion === undefined
        ? [
            'Latest version shown; the registration index is paged, so older versions are not listed.',
          ]
        : []),
    ]);
  },
};

const mavenHandler: SiteHandler = {
  hosts: ['mvnrepository.com', 'central.sonatype.com'],
  kind: 'Maven Central artifact metadata',
  async handle(url, signal) {
    const match = /^\/artifact\/([^/]+)\/([^/]+)(?:\/([^/]+))?/.exec(
      url.pathname,
    );
    if (match === null || match[1] === undefined || match[2] === undefined) {
      return null;
    }
    const groupId = decodeURIComponent(match[1]);
    const artifactId = decodeURIComponent(match[2]);
    const requestedVersion =
      match[3] === undefined ? undefined : decodeURIComponent(match[3]);
    const query =
      requestedVersion === undefined
        ? `g:"${groupId}" AND a:"${artifactId}" AND core:gav`
        : `g:"${groupId}" AND a:"${artifactId}" AND v:"${requestedVersion}"`;
    const data = await fetchJson(
      `https://search.maven.org/solrsearch/select?q=${encodeURIComponent(query)}&wt=json&rows=20&core=gav`,
      signal,
    );
    const docs = jsonArray(jsonObject(data?.['response'])?.['docs'])
      .map((doc) => jsonObject(doc))
      .filter((doc): doc is Record<string, unknown> => doc !== undefined);
    if (docs.length === 0) {
      return null;
    }
    const first = docs[0];
    if (first === undefined) {
      return null;
    }
    const version =
      requestedVersion ??
      jsonString(first['latestVersion']) ??
      jsonString(first['v']) ??
      'unknown';
    const versionLines =
      requestedVersion === undefined
        ? docs.map(
            (doc) =>
              `- \`${jsonString(doc['v']) ?? '?'}\` — published ${isoDate(doc['timestamp']) ?? 'unknown'}`,
          )
        : [];

    const content = sections([
      `# ${groupId}:${artifactId}:${version}`,
      metaBlock([
        ['Latest version', jsonString(first['latestVersion'])],
        ['Versions on Central', jsonNumber(first['versionCount'])],
        ['Repository id', jsonNumber(first['repositoryId'])],
        ['Last release', isoDate(first['timestamp'])],
      ]),
      `## Links\n\n- [Maven Central](https://repo1.maven.org/maven2/${groupId.replaceAll('.', '/')}/${artifactId}/)\n- [search.maven.org](https://search.maven.org/artifact/${groupId}/${artifactId})`,
      versionLines.length > 0
        ? `## Recent versions\n\n${bullet(versionLines, MAX_ITEMS)}`
        : undefined,
    ]);
    return markdownPage(content, [
      'Fetched via the public search.maven.org Solr API (no auth token).',
      ...(requestedVersion === undefined
        ? [
            'Maven Central metadata has no long description here; only coordinates and versions are shown.',
          ]
        : []),
    ]);
  },
};

/** Go module proxy escaping: an uppercase letter is sent as `!<lowercase>`. */
function escapeGoPath(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}

const goPkgHandler: SiteHandler = {
  hosts: ['pkg.go.dev', 'proxy.golang.org'],
  kind: 'Go module metadata',
  async handle(url, signal) {
    const path = url.pathname.replace(/^\//, '');
    if (path.length === 0 || path.startsWith('static/')) {
      return null;
    }
    const segments = path.split('/').filter((part) => part.length > 0);
    let modulePath: string | undefined;
    let requestedVersion: string | undefined;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment === undefined) {
        continue;
      }
      const at = segment.indexOf('@');
      if (at > 0) {
        modulePath = segments.slice(0, i).join('/');
        requestedVersion = segment.slice(at + 1);
        break;
      }
    }
    modulePath ??= segments.join('/');
    if (!modulePath.includes('.')) {
      // Module paths always start with a domain; without one this is not a
      // module page.
      return null;
    }

    const escaped = escapeGoPath(modulePath);
    const info =
      requestedVersion === undefined
        ? await fetchJson(`https://proxy.golang.org/${escaped}/@latest`, signal)
        : await fetchJson(
            `https://proxy.golang.org/${escaped}/@v/${escapeGoPath(requestedVersion)}.info`,
            signal,
          );
    const version = jsonString(info?.['Version']);
    if (version === undefined) {
      return null;
    }
    const gomod = await fetchText(
      `https://proxy.golang.org/${escaped}/@v/${escapeGoPath(version)}.mod`,
      'text/plain',
      signal,
    );

    const content = sections([
      `# ${modulePath}`,
      metaBlock([
        ['Latest version', version],
        ['Published', isoDate(info?.['Time'])],
        ['Go module', `https://pkg.go.dev/${modulePath}@${version}`],
      ]),
      gomod === undefined || gomod.trim().length === 0
        ? undefined
        : `## go.mod\n\n\`\`\`\n${truncated(gomod, 4000).text}\n\`\`\``,
      "The module proxy serves this module's go.mod; documentation lives on pkg.go.dev and was not fetched here.",
    ]);
    return markdownPage(content, [
      'Fetched via the public Go module proxy (no auth token).',
      ...(requestedVersion === undefined
        ? ['No version in the URL, so the latest release is shown.']
        : []),
    ]);
  },
};

const rubyGemsHandler: SiteHandler = {
  hosts: ['rubygems.org', 'www.rubygems.org'],
  kind: 'RubyGems metadata',
  async handle(url, signal) {
    const match = /^\/gems\/([^/]+)(?:\/versions\/([^/]+))?/.exec(url.pathname);
    if (match === null || match[1] === undefined) {
      return null;
    }
    const gemName = decodeURIComponent(match[1]);
    const requestedVersion = match[2];
    const apiUrl =
      requestedVersion === undefined
        ? `https://rubygems.org/api/v1/gems/${encodeURIComponent(gemName)}.json`
        : `https://rubygems.org/api/v2/rubygems/${encodeURIComponent(gemName)}/versions/${encodeURIComponent(decodeURIComponent(requestedVersion))}.json`;
    const data = await fetchJson(apiUrl, signal);
    const version = jsonString(data?.['version']);
    if (data === undefined || version === undefined) {
      return null;
    }
    const dependencies = jsonObject(data['dependencies']);
    const runtime = jsonArray(dependencies?.['runtime'])
      .map((dependency) => jsonObject(dependency))
      .filter(
        (dependency): dependency is Record<string, unknown> =>
          dependency !== undefined,
      )
      .map((dependency) => {
        const requirements = jsonObject(dependency['requirements']);
        const constraint = firstNonEmpty([
          jsonString(requirements?.['>=']),
          jsonString(requirements?.['=']),
        ]);
        const name = jsonString(dependency['name']);
        return name === undefined
          ? undefined
          : `- ${name}${constraint === undefined ? '' : ` \`>= ${constraint}\``}`;
      })
      .filter((line) => line !== undefined);
    const licenses = jsonStringList(data['licenses']);

    const content = sections([
      `# ${jsonString(data['name']) ?? gemName} ${version}`,
      jsonString(data['info']),
      metaBlock([
        [
          'Authors',
          firstNonEmpty([
            jsonString(data['authors']),
            jsonString(data['author']),
          ]),
        ],
        ['Licenses', licenses.join(', ') || undefined],
        ['Homepage', jsonString(data['homepage_uri'])],
        ['Source', jsonString(data['source_code_uri'])],
        ['Documentation', jsonString(data['documentation_uri'])],
        ['Bug tracker', jsonString(data['bug_tracker_uri'])],
        ['Downloads', jsonNumber(data['downloads'])?.toLocaleString('en-US')],
        ['RubyGems version', jsonString(data['rubygems_version'])],
      ]),
      runtime.length > 0
        ? `## Runtime dependencies\n\n${bullet(runtime, MAX_ITEMS)}`
        : undefined,
    ]);
    return markdownPage(content, [
      'Fetched via the public RubyGems API (no auth token).',
      ...(requestedVersion === undefined ? ['Latest version shown.'] : []),
    ]);
  },
};

const dockerHubHandler: SiteHandler = {
  hosts: ['hub.docker.com', 'registry.hub.docker.com'],
  kind: 'Docker Hub repository metadata',
  async handle(url, signal) {
    const segments = url.pathname.split('/').filter((part) => part.length > 0);
    let namespace = 'library';
    let repository: string | undefined;
    if (segments[0] === 'r' || segments[0] === 'repositories') {
      namespace = segments[1] ?? namespace;
      repository = segments[2];
    } else if (segments[0] === '_') {
      repository = segments[1];
    } else {
      return null;
    }
    if (repository === undefined || repository.length === 0) {
      return null;
    }
    repository = decodeURIComponent(repository);

    const data = await fetchJson(
      `https://hub.docker.com/v2/repositories/${encodeURIComponent(namespace)}/${encodeURIComponent(repository)}`,
      signal,
    );
    if (data === undefined) {
      return null;
    }
    const tagData = await fetchJson(
      `https://hub.docker.com/v2/repositories/${encodeURIComponent(namespace)}/${encodeURIComponent(repository)}/tags?page_size=${MAX_ITEMS}`,
      signal,
    );
    const tags = jsonArray(tagData?.['results'])
      .map((tag) => jsonObject(tag))
      .filter((tag): tag is Record<string, unknown> => tag !== undefined)
      .map(
        (tag) =>
          `- \`${jsonString(tag['name']) ?? '?'}\` — updated ${isoDate(tag['last_updated']) ?? 'unknown'}`,
      );
    const fullDescription = jsonString(data['full_description']) ?? '';
    const description = truncated(fullDescription, 4000);
    const notes = ['Fetched via the public Docker Hub v2 API (no auth token).'];
    if (description.truncated) {
      notes.push('Long description truncated.');
    }
    if (tagData === undefined) {
      notes.push('Tag listing could not be retrieved and is omitted.');
    }

    const content = sections([
      `# ${jsonString(data['name']) ?? repository}`,
      jsonString(data['description']),
      metaBlock([
        ['Namespace', jsonString(data['namespace'])],
        ['Pulls', jsonNumber(data['pull_count'])?.toLocaleString('en-US')],
        ['Stars', jsonNumber(data['star_count'])],
        ['Automated', jsonBoolean(data['is_automated']) ? 'yes' : 'no'],
        ['Status', jsonString(data['status'])],
        ['Last updated', isoDate(data['last_updated'])],
        ['Registry', `https://hub.docker.com/r/${namespace}/${repository}`],
      ]),
      description.text.trim().length > 0
        ? `## Description\n\n${description.text}`
        : undefined,
      tags.length > 0
        ? `## Tags (up to ${MAX_ITEMS})\n\n${bullet(tags, MAX_ITEMS)}`
        : undefined,
    ]);
    return markdownPage(content, notes);
  },
};

const terraformHandler: SiteHandler = {
  hosts: ['registry.terraform.io'],
  kind: 'Terraform Registry module metadata',
  async handle(url, signal) {
    const moduleMatch = /^\/modules\/([^/]+)\/([^/]+)\/([^/]+)/.exec(
      url.pathname,
    );
    if (moduleMatch !== null) {
      const [, namespace, name, provider] = moduleMatch;
      if (
        namespace === undefined ||
        name === undefined ||
        provider === undefined
      ) {
        return null;
      }
      const data = await fetchJson(
        `https://registry.terraform.io/v1/modules/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}/${encodeURIComponent(provider)}`,
        signal,
      );
      const version = jsonString(data?.['version']);
      if (data === undefined || version === undefined) {
        return null;
      }
      const root = jsonObject(data['root']);
      const inputNames = jsonArray(root?.['inputs'])
        .map((input) => jsonObject(input))
        .map((input) => jsonString(input?.['name']))
        .filter((inputName): inputName is string => inputName !== undefined);
      const outputNames = jsonArray(root?.['outputs'])
        .map((output) => jsonObject(output))
        .map((output) => jsonString(output?.['name']))
        .filter((outputName): outputName is string => outputName !== undefined);
      const versionLines = jsonArray(data['versions'])
        .map((entry) => jsonObject(entry))
        .map((entry) => jsonString(entry?.['version']))
        .filter((entry): entry is string => entry !== undefined);
      const content = sections([
        `# ${namespace}/${name}/${provider}`,
        jsonString(data['description']),
        metaBlock([
          ['Version', version],
          ['Verified publisher', jsonBoolean(data['verified']) ? 'yes' : 'no'],
          ['Downloads', jsonNumber(data['downloads'])?.toLocaleString('en-US')],
          ['Published', isoDate(data['published_at'])],
          ['Source', jsonString(data['source'])],
        ]),
        `## Usage\n\n\`\`\`hcl\nmodule "${name}" {\n  source  = "${namespace}/${name}/${provider}"\n  version = "${version}"\n}\n\`\`\``,
        inputNames.length > 0
          ? `## Inputs\n\n${bullet(inputNames, MAX_ITEMS)}`
          : undefined,
        outputNames.length > 0
          ? `## Outputs\n\n${bullet(outputNames, MAX_ITEMS)}`
          : undefined,
        versionLines.length > 0
          ? `## Versions\n\n${bullet(versionLines, MAX_ITEMS)}`
          : undefined,
      ]);
      return markdownPage(content, [
        'Fetched via the public Terraform module registry (no auth token).',
      ]);
    }

    const providerMatch = /^\/providers\/([^/]+)\/([^/]+)/.exec(url.pathname);
    if (providerMatch === null) {
      return null;
    }
    const [, providerNamespace, providerType] = providerMatch;
    if (providerNamespace === undefined || providerType === undefined) {
      return null;
    }
    // The registry's provider endpoints are gated behind service discovery; if
    // the token dance does not work we fall through instead of guessing.
    const discovery = await fetchJson(
      'https://registry.terraform.io/.well-known/terraform.json',
      signal,
    );
    const service = discovery?.['providers.v1'];
    const base =
      jsonString(service) ??
      jsonString(jsonObject(service)?.['url']) ??
      '/v1/providers/';
    const versions = await fetchJson(
      `https://registry.terraform.io${base.replace(/\/$/, '')}/${encodeURIComponent(providerNamespace)}/${encodeURIComponent(providerType)}/versions`,
      signal,
    );
    const versionList = jsonArray(versions?.['versions'])
      .map((entry) => jsonObject(entry))
      .map((entry) => jsonString(entry?.['version']))
      .filter((entry): entry is string => entry !== undefined);
    if (versionList.length === 0) {
      return null;
    }
    const content = sections([
      `# ${providerNamespace}/${providerType}`,
      metaBlock([
        ['Versions available', versionList.length],
        [
          'Registry',
          `https://registry.terraform.io/providers/${providerNamespace}/${providerType}/latest/docs`,
        ],
      ]),
      `## Versions\n\n${bullet(versionList, MAX_ITEMS)}`,
    ]);
    return markdownPage(content, [
      'Fetched via the public Terraform provider registry (no API token used).',
      'The provider registry exposes no prose documentation through this endpoint, so only the version list is shown.',
    ]);
  },
};

const homebrewHandler: SiteHandler = {
  hosts: ['formulae.brew.sh'],
  kind: 'Homebrew formula metadata',
  async handle(url, signal) {
    const match = /^\/(formula|cask)\/([^/]+)\/?$/.exec(url.pathname);
    if (match === null || match[2] === undefined) {
      return null;
    }
    const kind = match[1] === 'cask' ? 'cask' : 'formula';
    const name = decodeURIComponent(match[2]);
    const data = await fetchJson(
      `https://formulae.brew.sh/api/${kind}/${encodeURIComponent(name)}.json`,
      signal,
    );
    if (data === undefined) {
      return null;
    }
    if (kind === 'cask') {
      const content = sections([
        `# ${jsonString(data['token']) ?? name} (cask)`,
        jsonString(data['desc']),
        metaBlock([
          ['Name', jsonString(data['name'])],
          ['Homepage', jsonString(data['homepage'])],
          ['Version', jsonString(data['version'])],
          ['Category', jsonString(data['category'])],
          ['Installed files', jsonNumber(data['installed'])],
        ]),
        jsonStringList(data['urlspecs']).length > 0
          ? `## URLs\n\n${bullet(jsonStringList(data['urlspecs']), MAX_ITEMS)}`
          : undefined,
      ]);
      return markdownPage(content, [
        'Fetched via the public Homebrew API (no auth token).',
      ]);
    }
    const dependencies = jsonStringList(data['dependencies']);
    const content = sections([
      `# ${jsonString(data['name']) ?? name}`,
      jsonString(data['desc']),
      metaBlock([
        ['Version', jsonString(data['versions'])?.split(' ')[0]],
        ['Homepage', jsonString(data['homepage'])],
        ['License', jsonString(data['license'])],
        ['Bottled', jsonBoolean(data['bottle']) ? 'yes' : 'no'],
        ['Deprecated', jsonBoolean(data['deprecated']) ? 'yes' : 'no'],
        ['Disabled', jsonBoolean(data['disabled']) ? 'yes' : 'no'],
      ]),
      dependencies.length > 0
        ? `## Dependencies\n\n${bullet(dependencies, MAX_ITEMS)}`
        : undefined,
    ]);
    const notes = ['Fetched via the public Homebrew API (no auth token).'];
    if (jsonBoolean(data['disabled']) || jsonBoolean(data['deprecated'])) {
      notes.push(
        'Homebrew marks this formula as deprecated or disabled; treat it as unmaintained.',
      );
    }
    return markdownPage(content, notes);
  },
};

// ---------------------------------------------------------------------------
// Academic + code hosting
// ---------------------------------------------------------------------------

function xmlInner(xml: string, tag: string): string | undefined {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const found = pattern.exec(xml)?.[1];
  if (found === undefined) {
    return undefined;
  }
  return found
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function xmlMatches(xml: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const global = new RegExp(
    pattern.source,
    pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
  );
  let match = global.exec(xml);
  while (match !== null) {
    const value = match[1];
    if (value !== undefined) {
      out.push(value);
    }
    match = global.exec(xml);
  }
  return out;
}

const arxivHandler: SiteHandler = {
  hosts: ['arxiv.org', 'www.arxiv.org', 'export.arxiv.org'],
  kind: 'arXiv metadata',
  async handle(url, signal) {
    const match = /^\/(?:abs|pdf|html|ps)\/(.+?)(?:\.pdf)?\/?$/.exec(
      url.pathname,
    );
    if (match === null || match[1] === undefined) {
      return null;
    }
    const paperId = match[1].replace(/\/$/, '');
    if (paperId.length === 0) {
      return null;
    }
    const feed = await fetchText(
      `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(paperId)}`,
      'application/atom+xml',
      signal,
    );
    if (feed === undefined) {
      return null;
    }
    const entryStart = feed.indexOf('<entry>');
    const entry = entryStart === -1 ? undefined : feed.slice(entryStart);
    if (entry === undefined) {
      return null;
    }
    const title = xmlInner(entry, 'title');
    if (title === undefined || /(^|\s)error(\s|$)/i.test(title)) {
      return null;
    }
    const authors = xmlMatches(
      entry,
      /<author>[\s\S]*?<name>([\s\S]*?)<\/name>/i,
    )
      .map((name) => name.replace(/\s+/g, ' ').trim())
      .filter((name) => name.length > 0);
    const categories = [
      ...new Set(xmlMatches(entry, /<category[^>]*\sterm="([^"]+)"/i)),
    ];
    const pdfLink = xmlMatches(
      entry,
      /<link[^>]*\stitle="pdf"[^>]*\shref="([^"]+)"/i,
    )[0];
    const notes = [
      'Fetched via the public arXiv Atom API (no auth token).',
      'Metadata only: the PDF itself is binary and is not converted here.',
    ];
    if (url.pathname.startsWith('/pdf') || url.pathname.endsWith('.pdf')) {
      notes.push(
        'The URL points at the PDF; the abstract page has the readable version.',
      );
    }

    const content = sections([
      `# ${title}`,
      metaBlock([
        ['Authors', authors.join(', ') || undefined],
        ['Published', isoDate(xmlInner(entry, 'published'))],
        ['Updated', isoDate(xmlInner(entry, 'updated'))],
        ['Categories', categories.join(', ') || undefined],
        ['arXiv ID', paperId],
        ['DOI', xmlInner(entry, 'arxiv:doi')],
        ['Journal ref', xmlInner(entry, 'arxiv:journal_ref')],
        ['Abstract page', `https://arxiv.org/abs/${paperId}`],
        ['PDF', pdfLink],
      ]),
      `## Abstract\n\n${xmlInner(entry, 'summary') ?? 'No abstract in the arXiv response.'}`,
    ]);
    return markdownPage(content, notes);
  },
};

const LANGUAGES: Record<string, string> = {
  bash: 'sh',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  java: 'java',
  js: 'js',
  json: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  md: 'md',
  markdown: 'md',
  mjs: 'js',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scala: 'scala',
  sh: 'sh',
  sql: 'sql',
  swift: 'swift',
  tf: 'hcl',
  toml: 'toml',
  ts: 'ts',
  tsx: 'tsx',
  txt: 'text',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'sh',
};

async function githubFilePage(
  rawUrl: string,
  displayPath: string,
  notes: string[],
): Promise<InternalPage | null> {
  const body = await fetchText(rawUrl, 'text/plain', '*/*');
  if (body === undefined) {
    return null;
  }
  const clipped = truncated(body, RAW_TEXT_LIMIT);
  if (clipped.truncated) {
    notes.push(`File truncated at ${RAW_TEXT_LIMIT} characters.`);
  }
  const extension = displayPath.split('.').pop()?.toLowerCase() ?? '';
  const isMarkdown = extension === 'md' || extension === 'markdown';
  const content = isMarkdown
    ? clipped.text
    : `\`\`\`${LANGUAGES[extension] ?? ''}\n${clipped.text}\n\`\`\``;
  return markdownPage(content, notes);
}

const githubHandler: SiteHandler = {
  hosts: ['github.com', 'raw.githubusercontent.com'],
  kind: 'GitHub repository and file content',
  async handle(url, signal) {
    if (url.hostname === 'raw.githubusercontent.com') {
      const notes = ['Raw file fetched from raw.githubusercontent.com.'];
      return githubFilePage(url.href, url.pathname, notes);
    }

    const segments = url.pathname.split('/').filter((part) => part.length > 0);
    const owner = segments[0];
    const repo = segments[1]?.replace(/\.git$/, '');
    if (owner === undefined || repo === undefined) {
      return null;
    }
    const notes = [
      'Fetched via the public GitHub REST API without a token; the anonymous rate limit is 60 requests/hour, so this may fall back to a plain fetch.',
    ];

    if (
      segments[2] === 'blob' &&
      segments[3] !== undefined &&
      segments[4] !== undefined
    ) {
      const ref = segments[3];
      const path = segments.slice(4).join('/');
      notes.push(`Showing \`${path}\` at ref \`${ref}\`.`);
      return githubFilePage(
        `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${ref}/${path
          .split('/')
          .map((part) => encodeURIComponent(part))
          .join('/')}`,
        path,
        notes,
      );
    }

    if (segments[2] === 'tree' && segments[3] !== undefined) {
      const ref = segments[3];
      const path = segments.slice(4).join('/');
      const listing = await fetchJson(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${ref}/${path
          .split('/')
          .filter((part) => part.length > 0)
          .map((part) => encodeURIComponent(part))
          .join('/')}`,
        signal,
      );
      const entries = jsonArray(listing)
        .map((entry) => jsonObject(entry))
        .filter(
          (entry): entry is Record<string, unknown> => entry !== undefined,
        );
      if (entries.length === 0) {
        return null;
      }
      notes.push(
        `Directory listing of \`${path}\` at ref \`${ref}\` (${entries.length} entries).`,
      );
      const content = sections([
        `# ${owner}/${repo} — ${path}`,
        bullet(
          entries.map((entry) => {
            const type = jsonString(entry['type']);
            return `- \`${jsonString(entry['name']) ?? '?'}\`${type === 'dir' ? '/' : ''}${
              jsonString(entry['size']) === undefined
                ? ''
                : ` — ${jsonString(entry['size'])} bytes`
            }`;
          }),
          200,
        ),
      ]);
      return markdownPage(content, notes);
    }

    if (segments.length > 2) {
      return null;
    }

    const repoData = await fetchJson(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      signal,
    );
    if (repoData === undefined) {
      return null;
    }
    const defaultBranch = jsonString(repoData['default_branch']) ?? 'main';
    const topics = jsonStringList(repoData['topics']);
    const release = await fetchJson(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`,
      signal,
    );
    const readme = jsonObject(
      await fetchJson(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
        signal,
      ),
    );
    const readmeUrl = jsonString(readme?.['download_url']);
    const readmeBody =
      readmeUrl === undefined
        ? undefined
        : await fetchText(readmeUrl, 'text/plain', signal);
    const readmeClipped =
      readmeBody === undefined ? undefined : truncated(readmeBody, 60_000);
    if (readmeClipped?.truncated === true) {
      notes.push('README truncated at 60000 characters.');
    }
    if (readmeBody === undefined) {
      notes.push('README could not be retrieved and is omitted.');
    }

    const content = sections([
      `# ${jsonString(repoData['full_name']) ?? `${owner}/${repo}`}`,
      jsonString(repoData['description']),
      metaBlock([
        ['Default branch', defaultBranch],
        [
          'Stars',
          jsonNumber(repoData['stargazers_count'])?.toLocaleString('en-US'),
        ],
        ['Forks', jsonNumber(repoData['forks_count'])?.toLocaleString('en-US')],
        ['Open issues', jsonNumber(repoData['open_issues_count'])],
        ['Language', jsonString(repoData['language'])],
        ['License', jsonString(jsonObject(repoData['license'])?.['spdx_id'])],
        ['Archived', jsonBoolean(repoData['archived']) ? 'yes' : 'no'],
        ['Created', isoDate(repoData['created_at'])],
        ['Pushed', isoDate(repoData['pushed_at'])],
        ['Homepage', jsonString(repoData['homepage'])],
        ['Latest release', jsonString(release?.['tag_name'])],
      ]),
      topics.length > 0 ? `**Topics:** ${topics.join(', ')}` : undefined,
      readmeClipped === undefined
        ? undefined
        : `## README\n\n${readmeClipped.text}`,
    ]);
    return markdownPage(content, notes);
  },
};

// ---------------------------------------------------------------------------
// Registration, in reader priority order
// ---------------------------------------------------------------------------

/** Security databases first, then registries, then academic and code hosting. */
export const builtinHandlers: readonly SiteHandler[] = [
  nvdHandler,
  osvHandler,
  cisaKevHandler,
  npmHandler,
  pypiHandler,
  cratesIoHandler,
  nugetHandler,
  mavenHandler,
  goPkgHandler,
  rubyGemsHandler,
  dockerHubHandler,
  terraformHandler,
  homebrewHandler,
  arxivHandler,
  githubHandler,
];

for (const handler of builtinHandlers) {
  registerHandler(handler);
}
