import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
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

  if (!cfg.testPlan?.id) err('"testPlan.id" is required');
  if (!cfg.local?.type) err('"local.type" is required (gherkin | markdown)');
  if (!cfg.local?.include) err('"local.include" is required');
}

export const CONFIG_TEMPLATE_JSON = JSON.stringify(
  {
    orgUrl: 'https://dev.azure.com/YOUR_ORG',
    project: 'YOUR_PROJECT',
    auth: {
      type: 'pat',
      token: '$AZURE_DEVOPS_TOKEN',
    },
    testPlan: {
      id: 0,
      suiteId: 0,
    },
    local: {
      type: 'gherkin',
      include: 'specs/**/*.feature',
      exclude: [],
    },
    sync: {
      tagPrefix: 'tc',
      areaPath: '',
      iterationPath: '',
    },
  },
  null,
  2
);
