import { SyncConfig } from './types';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeConfigurationKey(key: string): string {
  const normalized = key
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .toLowerCase();
  return normalized || 'config';
}

export function getBaseTagPrefix(config: SyncConfig): string {
  return config.sync?.tagPrefix ?? 'tc';
}

export function getPreferredMarkerTagPrefix(config: SyncConfig): string {
  const basePrefix = getBaseTagPrefix(config);
  if (!config.configurationKey) return basePrefix;
  return `${basePrefix}__${normalizeConfigurationKey(config.configurationKey)}`;
}

export function getMarkerTagPrefixes(config: SyncConfig): string[] {
  const preferredPrefix = getPreferredMarkerTagPrefix(config);
  const basePrefix = getBaseTagPrefix(config);
  return preferredPrefix === basePrefix ? [preferredPrefix] : [preferredPrefix, basePrefix];
}

export function normalizeMarkerTagPrefixes(tagPrefix: string | string[]): string[] {
  return [...new Set((Array.isArray(tagPrefix) ? tagPrefix : [tagPrefix]).filter(Boolean))];
}

export function buildMarkerTagPrefixPattern(tagPrefix: string | string[]): string {
  return normalizeMarkerTagPrefixes(tagPrefix).map(escapeRegex).join('|');
}

export function isMarkerTag(tag: string, tagPrefix: string | string[]): boolean {
  return normalizeMarkerTagPrefixes(tagPrefix).some((prefix) => tag.startsWith(`${prefix}:`));
}