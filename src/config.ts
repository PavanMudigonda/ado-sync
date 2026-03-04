import * as fs from 'fs';
import * as yaml from 'js-yaml';
import * as path from 'path';

import { SyncConfig } from './types';

const CONFIG_FILENAMES = ['ado-sync.json', 'ado-sync.yml', 'ado-sync.yaml'];

export function resolveConfigPath(explicitPath?: string): string {
  if (explicitPath) {
    const abs = path.resolve(explicitPath);
    if (!fs.existsSync(abs)) throw new Error(`Config file not found: ${abs}`);
    return abs;
  }

  for (const name of CONFIG_FILENAMES) {
    const candidate = path.resolve(process.cwd(), name);
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `No config file found. Create one of: ${CONFIG_FILENAMES.join(', ')}\n` +
    `Run 'ado-sync init' to generate a template.`
  );
}

export function loadConfig(configPath: string): SyncConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  const ext = path.extname(configPath).toLowerCase();

  let parsed: unknown;
  if (ext === '.json') {
    parsed = JSON.parse(raw);
  } else {
    parsed = yaml.load(raw);
  }

  const cfg = parsed as SyncConfig;

  // Expand env var tokens like "$MY_TOKEN"
  if (cfg.auth?.token?.startsWith('$')) {
    const envKey = cfg.auth.token.slice(1);
    const envVal = process.env[envKey];
    if (!envVal) {
      throw new Error(
        `Environment variable '${envKey}' (referenced in auth.token) is not set.`
      );
    }
    cfg.auth.token = envVal;
  }

  validateConfig(cfg, configPath);

  // Default values
  cfg.sync = cfg.sync ?? {};
  cfg.sync.tagPrefix = cfg.sync.tagPrefix ?? 'tc';
  cfg.sync.titleField = cfg.sync.titleField ?? 'System.Title';
  cfg.sync.conflictAction = cfg.sync.conflictAction ?? 'overwrite';
  cfg.sync.disableLocalChanges = cfg.sync.disableLocalChanges ?? false;

  return cfg;
}

function validateConfig(cfg: SyncConfig, filePath: string): void {
  const err = (msg: string) => {
    throw new Error(`Config error in ${filePath}: ${msg}`);
  };

  if (!cfg.orgUrl) err('"orgUrl" is required');
  if (!cfg.project) err('"project" is required');
  if (!cfg.auth?.type) err('"auth.type" is required (pat | accessToken | managedIdentity)');

  if (cfg.auth.type !== 'managedIdentity' && !cfg.auth.token) {
    err('"auth.token" is required for auth type "' + cfg.auth.type + '"');
  }
  if (cfg.auth.type === 'managedIdentity' && !cfg.auth.applicationIdURI) {
    err('"auth.applicationIdURI" is required when auth.type is "managedIdentity"');
  }

  if (!cfg.testPlan?.id && !cfg.testPlans?.length) {
    err('"testPlan.id" or "testPlans" array is required');
  }
  if (!cfg.local?.type) err('"local.type" is required (gherkin | markdown)');
  if (!cfg.local?.include) err('"local.include" is required');
}

/**
 * Apply CLI --config-override values to a loaded config.
 * Each override is a string like "sync.tagPrefix=mytag" or "testPlan.id=42".
 * Dot-path navigation sets nested values. Numbers are coerced automatically.
 */
export function applyOverrides(cfg: SyncConfig, overrides: string[]): void {
  for (const override of overrides) {
    const eqIdx = override.indexOf('=');
    if (eqIdx === -1) {
      throw new Error(`Invalid --config-override "${override}": expected format "path=value"`);
    }
    const dotPath = override.slice(0, eqIdx).trim();
    const rawValue = override.slice(eqIdx + 1);

    const segments = dotPath.split('.');
    let obj: any = cfg;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (obj[seg] === undefined || obj[seg] === null) obj[seg] = {};
      obj = obj[seg];
    }

    const lastKey = segments[segments.length - 1];
    // Coerce: number if parseable, boolean if 'true'/'false', else string
    const numVal = Number(rawValue);
    if (rawValue === 'true') {
      obj[lastKey] = true;
    } else if (rawValue === 'false') {
      obj[lastKey] = false;
    } else if (!isNaN(numVal) && rawValue.trim() !== '') {
      obj[lastKey] = numVal;
    } else {
      obj[lastKey] = rawValue;
    }
  }
}

const CONFIG_TEMPLATE_OBJECT = {
  orgUrl: 'https://dev.azure.com/YOUR_ORG',
  project: 'YOUR_PROJECT',
  auth: {
    type: 'pat',
    token: '$AZURE_DEVOPS_TOKEN',
  },
  testPlan: {
    id: 0,
    suiteId: 0,
    suiteMapping: 'flat',
  },
  local: {
    type: 'gherkin',
    include: 'specs/**/*.feature',
    exclude: [],
  },
  sync: {
    tagPrefix: 'tc',
    titleField: 'System.Title',
    areaPath: '',
    iterationPath: '',
    disableLocalChanges: false,
    conflictAction: 'overwrite',
    links: [],
  },
};

export const CONFIG_TEMPLATE_JSON = JSON.stringify(CONFIG_TEMPLATE_OBJECT, null, 2);

export const CONFIG_TEMPLATE_YAML = yaml.dump(CONFIG_TEMPLATE_OBJECT, { indent: 2, lineWidth: 120 });
