import * as path from 'path';

import { ExtensionConfig, ExtensionManifest, ParserExtension, RoutingPolicyExtension } from './types';

export interface LoadedExtension {
  config: ExtensionConfig;
  manifest: ExtensionManifest;
  instance: ParserExtension | RoutingPolicyExtension;
}

export async function loadExtensions(
  extensions: ExtensionConfig[] | undefined,
  configDir: string
): Promise<LoadedExtension[]> {
  if (!extensions?.length) return [];

  const loaded: LoadedExtension[] = [];
  for (const ext of extensions) {
    const resolved = resolveExtensionPackage(ext.package, configDir);
    const mod = await import(resolved);
    const instance = mod.default ?? mod;
    const manifest: ExtensionManifest = instance.manifest ?? {
      name: ext.name,
      version: '0.0.0',
      type: ext.type,
    };
    loaded.push({ config: ext, manifest, instance });
  }
  return loaded;
}

function resolveExtensionPackage(pkg: string, configDir: string): string {
  if (pkg.startsWith('.') || pkg.startsWith('/')) {
    return path.resolve(configDir, pkg);
  }
  return require.resolve(pkg, { paths: [configDir] });
}

export function validateExtensions(extensions: LoadedExtension[], coreVersion: string): string[] {
  const errors: string[] = [];
  for (const ext of extensions) {
    if (ext.manifest.minCoreVersion) {
      const required = ext.manifest.minCoreVersion.replace(/^v/, '');
      const current = coreVersion.replace(/^v/, '');
      if (compareVersions(current, required) < 0) {
        errors.push(
          `Extension "${ext.config.name}" requires core >=${required} but current is ${current}`
        );
      }
    }
  }
  return errors;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}
