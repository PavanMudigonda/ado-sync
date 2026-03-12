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

/**
 * Deep merge two plain objects. Source values overwrite target values.
 * Arrays are replaced, not concatenated.
 */
function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] !== null &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Load a config file (JSON or YAML) and return the raw parsed object.
 */
function loadRawConfig(configPath: string): Record<string, any> {
  const raw = fs.readFileSync(configPath, 'utf8');
  const ext = path.extname(configPath).toLowerCase();
  if (ext === '.json') {
    return JSON.parse(raw);
  }
  return yaml.load(raw) as Record<string, any>;
}

/**
 * Resolve hierarchical configuration by loading parent configs recursively.
 * Parent configs are merged bottom-up: child values override parent values.
 */
function resolveHierarchicalConfig(configPath: string, visited = new Set<string>()): Record<string, any> {
  const absPath = path.resolve(configPath);
  if (visited.has(absPath)) {
    throw new Error(`Circular parent config reference detected: ${absPath}`);
  }
  visited.add(absPath);

  const parsed = loadRawConfig(absPath);

  // Check for parent config
  const parentConfigPath = parsed.toolSettings?.parentConfig;
  const ignoreParent = parsed.toolSettings?.ignoreParentConfig === true;

  if (parentConfigPath && !ignoreParent) {
    const resolvedParent = path.resolve(path.dirname(absPath), parentConfigPath);
    if (!fs.existsSync(resolvedParent)) {
      throw new Error(`Parent config file not found: ${resolvedParent} (referenced from ${absPath})`);
    }
    const parentConfig = resolveHierarchicalConfig(resolvedParent, visited);
    // Child overrides parent
    return deepMerge(parentConfig, parsed);
  }

  return parsed;
}

export function loadConfig(configPath: string): SyncConfig {
  const parsed = resolveHierarchicalConfig(configPath);
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

  // Format defaults
  if (cfg.sync.format) {
    cfg.sync.format.prefixBackgroundSteps = cfg.sync.format.prefixBackgroundSteps ?? true;
    cfg.sync.format.prefixTitle = cfg.sync.format.prefixTitle ?? true;
    cfg.sync.format.useExpectedResult = cfg.sync.format.useExpectedResult ?? false;
    cfg.sync.format.syncDataTableAsText = cfg.sync.format.syncDataTableAsText ?? false;
    cfg.sync.format.showParameterListStep = cfg.sync.format.showParameterListStep ?? 'whenUnusedParameters';
  }

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
  const validLocalTypes = ['gherkin', 'reqnroll', 'markdown', 'csv', 'excel', 'csharp', 'java', 'javascript', 'python', 'playwright', 'puppeteer', 'cypress', 'testcafe', 'detox', 'espresso', 'xcuitest', 'flutter'];
  if (!cfg.local?.type) err(`"local.type" is required (${validLocalTypes.join(' | ')})`);
  if (!validLocalTypes.includes(cfg.local.type))
    err(`"local.type" must be one of: ${validLocalTypes.join(', ')} (got "${cfg.local.type}")`);
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
  configurationKey: '',
  auth: {
    type: 'pat',
    token: '$AZURE_DEVOPS_TOKEN',
  },
  testPlan: {
    id: 0,
    suiteId: 0,
    suiteMapping: 'flat',
    // suiteRouting: routes tests to different suites within this plan based on tags.
    // Routes are evaluated in order; the first match wins.
    // Remove or leave empty to use suiteId for all tests.
    suiteRouting: [],
  },
  // testPlans: multi-plan mode — sync to multiple test plans in one config.
  // When present, overrides testPlan for each entry.
  // Each entry supports id, suiteId, suiteMapping, include, exclude, suiteRouting, suiteConditions.
  // Example:
  // testPlans: [
  //   { id: 100, suiteId: 200, include: 'specs/smoke/**/*.feature', suiteRouting: [{ tags: '@critical', suite: 'Critical' }, { suite: 'Smoke' }] },
  //   { id: 101, suiteId: 300, include: 'specs/regression/**/*.feature' },
  // ],
  local: {
    type: 'gherkin',
    include: 'specs/**/*.feature',
    exclude: [],
    condition: '',
  },
  toolSettings: {
    parentConfig: '',
    outputLevel: 'normal',
  },
  sync: {
    tagPrefix: 'tc',
    titleField: 'System.Title',
    areaPath: '',
    iterationPath: '',
    disableLocalChanges: false,
    conflictAction: 'overwrite',
    links: [],
    state: {
      setValueOnChangeTo: '',
    },
    fieldUpdates: {},
    format: {
      useExpectedResult: false,
      prefixBackgroundSteps: true,
      prefixTitle: true,
      syncDataTableAsText: false,
    },
    attachments: {
      enabled: false,
      tagPrefixes: [],
      baseFolder: '',
    },
    pull: {
      enabled: false,
      enableCreatingNewLocalTestCases: false,
    },
    // AI summarization for code-based test types (playwright, cypress, jest, etc.)
    ai: {
      provider: 'heuristic',
      // provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: '$ANTHROPIC_API_KEY'
      // provider: 'openai',    model: 'gpt-4o-mini',       apiKey: '$OPENAI_API_KEY'
      // provider: 'ollama',    model: 'qwen2.5-coder:7b',  baseUrl: 'http://localhost:11434'
      analyzeFailures: false,
    },
    // Condition-based suite assignment (additive — tests are added to each matching suite)
    suiteConditions: [],
  },
  customizations: {
    fieldDefaults: {
      enabled: false,
      defaultValues: {},
    },
    ignoreTestCaseTags: {
      enabled: false,
      tags: [],
    },
    tagTextMapTransformation: {
      enabled: false,
      textMap: {},
    },
  },
  publishTestResults: {
    testResult: {
      sources: [],
    },
    testConfiguration: {
      name: '',
    },
    testRunSettings: {
      name: '',
    },
  },
};

export const CONFIG_TEMPLATE_JSON = JSON.stringify(CONFIG_TEMPLATE_OBJECT, null, 2);

export const CONFIG_TEMPLATE_YAML = yaml.dump(CONFIG_TEMPLATE_OBJECT, { indent: 2, lineWidth: 120 });
