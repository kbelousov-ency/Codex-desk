import { readFile } from 'node:fs/promises';

import { compareVersions, stableVersion } from './app-updates.mjs';
import { SettingsStore } from './window-session.mjs';

const MAX_ARTIFACT_BYTES = 256 * 1024;
const MAX_RELEASES = 128;
const MAX_ITEMS = 100;
const MAX_ITEM_LENGTH = 2000;
const MAX_VERSION_LENGTH = 32;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function cleanItem(value) {
  if (typeof value !== 'string') return null;
  const item = value.trim().replace(/\s+/g, ' ');
  if (!item || item.length > MAX_ITEM_LENGTH) return null;
  // Changelog links are useful in release notes, but the renderer only needs
  // their visible label and must never receive an arbitrary URL to navigate.
  return item.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

function cleanRelease(value) {
  if (!object(value) || !stableVersion(value.version) || value.version.length > MAX_VERSION_LENGTH) return null;
  const items = Array.isArray(value.items) ? value.items.map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS) : [];
  const release = { version: value.version, items };
  if (typeof value.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.date)) release.date = value.date;
  return release;
}

/**
 * Parse the source CHANGELOG or its packaged JSON representation.
 * The parser intentionally keeps only release headings and bullet points;
 * build metadata, links and prose outside a release are not sent to renderer.
 */
export function parseReleaseNotes(input) {
  let sections = [];
  if (typeof input === 'string') {
    const headings = [...input.matchAll(/^##\s+\[([^\]]+)\](?:\s+[—-]\s+(\d{4}-\d{2}-\d{2}))?[^\r\n]*\r?\n/gm)];
    sections = headings.map((heading, index) => {
      const body = input.slice(heading.index + heading[0].length, headings[index + 1]?.index);
      return { version: heading[1], date: heading[2], items: body.split(/\r?\n/).map(line => line.match(/^\s*[-*+]\s+(.+)$/)?.[1]).map(cleanItem).filter(Boolean) };
    });
  } else if (Array.isArray(input)) {
    sections = input;
  } else if (object(input)) {
    sections = Array.isArray(input.releases) ? input.releases : Array.isArray(input.sections) ? input.sections : [];
  }
  const seen = new Set();
  return sections.map(cleanRelease).filter(Boolean).filter(release => {
    if (seen.has(release.version)) return false;
    seen.add(release.version);
    return true;
  }).slice(0, MAX_RELEASES);
}

/** Select notes for the update range, preserving the changelog's newest-first order. */
export function collectReleaseChanges(releases, previousVersion, currentVersion) {
  if (!stableVersion(currentVersion)) return [];
  const parsed = parseReleaseNotes(releases);
  if (previousVersion !== null && previousVersion !== undefined && !stableVersion(previousVersion)) return [];
  return parsed.filter(release => {
    const atOrBeforeCurrent = compareVersions(release.version, currentVersion) <= 0;
    const afterPrevious = previousVersion == null ? release.version === currentVersion : compareVersions(release.version, previousVersion) > 0;
    return atOrBeforeCurrent && afterPrevious;
  });
}

function cleanState(value) {
  return object(value) && stableVersion(value.lastSeenVersion) ? { format: 1, lastSeenVersion: value.lastSeenVersion } : { format: 1 };
}

/** State is kept apart from settings, auth and workspace history. */
export class ReleaseNotesStore extends SettingsStore {
  async snapshot() {
    return cleanState(await super.snapshot());
  }

  markSeen(version) {
    if (!stableVersion(version)) throw new Error('Некорректная версия заметок релиза.');
    return this._update(previous => ({ ...cleanState(previous), lastSeenVersion: version }));
  }
}

export class ReleaseNotesService {
  constructor({ channel = 'development', currentVersion, releases = [], store, isNewProfile = false }) {
    if (!store || typeof store.snapshot !== 'function' || typeof store.markSeen !== 'function') throw new Error('Не задано хранилище заметок релиза.');
    this.channel = channel;
    this.currentVersion = typeof currentVersion === 'string' ? currentVersion : 'development';
    this.releases = parseReleaseNotes(releases);
    this.store = store;
    this.isNewProfile = Boolean(isNewProfile);
  }

  async get() {
    const currentVersion = this.currentVersion;
    const state = await this.store.snapshot();
    const previousVersion = stableVersion(state.lastSeenVersion) ? state.lastSeenVersion : null;
    let shouldShow = false;
    let releases = collectReleaseChanges(this.releases, null, currentVersion);
    if (this.channel === 'stable' && stableVersion(currentVersion)) {
      if (!previousVersion && this.isNewProfile) {
        // A clean installation should establish its baseline silently. This
        // also makes a later update distinguishable from the first launch.
        await this.store.markSeen(currentVersion);
      } else if (previousVersion === null || compareVersions(currentVersion, previousVersion) > 0) {
        shouldShow = true;
        releases = collectReleaseChanges(this.releases, previousVersion, currentVersion);
      }
    }
    if (!releases.length) releases = [{ version: currentVersion, items: ['Обновление Codex Desk установлено. Подробные заметки для этой версии пока недоступны.'] }];
    return { currentVersion, previousVersion, releases, shouldShow };
  }

  async acknowledge() {
    if (this.channel === 'stable' && stableVersion(this.currentVersion)) await this.store.markSeen(this.currentVersion);
  }
}

/** Read a packaged artifact, returning an empty set for a missing development artifact. */
export async function readReleaseNotesFile(filename) {
  try {
    const content = await readFile(filename);
    if (content.byteLength > MAX_ARTIFACT_BYTES) throw new Error('Сборка заметок релиза слишком велика.');
    return parseReleaseNotes(JSON.parse(content.toString('utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export { compareVersions, stableVersion };
