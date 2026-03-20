/**
 * AI-powered spec file generation from ADO User Stories.
 *
 * Providers:
 *   local       — node-llama-cpp GGUF model running in-process
 *   ollama      — local Ollama REST API (http://localhost:11434)
 *   openai      — OpenAI Chat Completions (or compatible endpoint)
 *   anthropic   — Anthropic Messages API
 *   huggingface — Hugging Face Inference API (OpenAI-compatible /v1 endpoint)
 *   bedrock     — AWS Bedrock (requires @aws-sdk/client-bedrock-runtime)
 *   azureai     — Azure OpenAI Service (OpenAI-compatible, api-key header)
 *
 * Output formats:
 *   markdown    — Playwright-planner style spec (Feature/Role/Options/Scenario blocks)
 *   gherkin     — BDD .feature file with Scenario and Scenario Outline
 */

import { AdoStory } from '../azure/work-items';

// ─── Public types ─────────────────────────────────────────────────────────────

export type AiGenerateProvider =
  | 'local'
  | 'ollama'
  | 'openai'
  | 'anthropic'
  | 'huggingface'
  | 'bedrock'
  | 'azureai'
  | 'github'
  | 'azureinference';

export interface AiGenerateOpts {
  provider: AiGenerateProvider;
  /**
   * Model identifier:
   *   local:           path to .gguf file
   *   ollama:          model tag (e.g. qwen2.5-coder:7b)
   *   openai:          model name (e.g. gpt-4o)
   *   anthropic:       model name (e.g. claude-sonnet-4-6)
   *   huggingface:     model id (e.g. mistralai/Mistral-7B-Instruct-v0.3)
   *   bedrock:         model id (e.g. anthropic.claude-3-haiku-20240307-v1:0)
   *   azureai:         deployment name (e.g. gpt-4o)
   *   github:          GitHub Models model name (e.g. gpt-4o, Meta-Llama-3.1-70B-Instruct)
   *   azureinference:  model name deployed on Azure AI Inference endpoint
   */
  model?: string;
  /** Base URL override (ollama, openai-compatible, azureai/azureinference full endpoint). */
  baseUrl?: string;
  /** API key — or $ENV_VAR reference. */
  apiKey?: string;
  /** AWS region for bedrock (default: AWS_REGION env or us-east-1). */
  region?: string;
  /** Fall back to template output if the AI call fails. Default: true. */
  heuristicFallback?: boolean;
}

export type GenerateSpecFormat = 'markdown' | 'gherkin';

// ─── Prompt templates ─────────────────────────────────────────────────────────

const MARKDOWN_PROMPT = `You are a QA engineer writing markdown spec files for E2E testing.

Given the ADO user story below, generate a complete markdown spec in this exact format:

# {Short feature area title}

Feature: {Feature name}
Role: {user role, e.g. "user" or "admin"}
Options: {feature permission flags needed, or "none"}
Timeout: 180000
Tags: {comma-separated tags, always include "smoke" for the main scenario}

## Scenario: {Main happy-path scenario title}

Preconditions:
- {Required permission or system state}
- User is authenticated

- Given {initial page/context}
- When {primary user action}
- And {additional action if needed}
- Then {expected result}
- And {additional assertion if applicable}

## Scenario: {Edge case or secondary scenario title}

Preconditions:
- {Precondition}

- Given {initial context}
- When {action}
- Then {expected result}

Rules:
- Generate 2-4 scenarios covering the main happy path and key edge cases from the acceptance criteria
- Be specific: use real button names, field labels, and UI messages from the description
- Identify the minimum user permissions needed for the feature
- Output ONLY the markdown — no preamble, explanation, or code fences

Story details:
Title: {TITLE}
Work Item Type: {TYPE}
State: {STATE}

Description:
{DESCRIPTION}

Acceptance Criteria:
{AC}`;

const GHERKIN_PROMPT = `You are a QA engineer writing BDD feature files in Gherkin syntax.

Given the ADO user story below, generate a complete Gherkin .feature file.

Requirements:
- Feature block with a short description
- 2-3 Scenario blocks for main happy-path and key negative cases
- 1 Scenario Outline with an Examples table if the AC mentions multiple values/inputs to test
- Place an @tc:0000 tag above each Scenario/Scenario Outline (placeholder for Azure TC ID)
- Steps must be specific: use real button names, field names, and expected messages
- Scenario Outline Examples table must have at least 2-3 rows
- Output ONLY the .feature content — no preamble, explanation, or code fences

Story details:
Title: {TITLE}
Work Item Type: {TYPE}
State: {STATE}

Description:
{DESCRIPTION}

Acceptance Criteria:
{AC}`;

function buildPrompt(story: AdoStory, format: GenerateSpecFormat): string {
  const template = format === 'gherkin' ? GHERKIN_PROMPT : MARKDOWN_PROMPT;
  return template
    .replace('{TITLE}', story.title)
    .replace('{TYPE}', story.workItemType ?? 'User Story')
    .replace('{STATE}', story.state ?? 'Active')
    .replace('{DESCRIPTION}', story.description?.trim() || '(not provided)')
    .replace('{AC}', story.acceptanceCriteria?.trim() || '(not provided)');
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const esmImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

function resolveEnvVar(value: string): string {
  if (value.startsWith('$')) return process.env[value.slice(1)] ?? value;
  return value;
}

// ─── Provider implementations ─────────────────────────────────────────────────

interface LlamaSession {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  LlamaChatSession: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
}

const llamaCache = new Map<string, Promise<LlamaSession>>();

async function getLlamaSession(modelPath: string): Promise<LlamaSession> {
  if (llamaCache.has(modelPath)) return llamaCache.get(modelPath)!;
  const promise = (async (): Promise<LlamaSession> => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-explicit-any
    const esmImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
    const llamaModule = await esmImport('node-llama-cpp');
    const { getLlama, LlamaChatSession } = llamaModule;
    const llama = await getLlama();
    const model = await llama.loadModel({ modelPath });
    return { LlamaChatSession, model };
  })();
  llamaCache.set(modelPath, promise);
  return promise;
}

async function localProvider(prompt: string, modelPath: string): Promise<string> {
  const { LlamaChatSession, model } = await getLlamaSession(modelPath);
  const context = await model.createContext();
  try {
    const session = new LlamaChatSession({ contextSequence: context.getSequence() });
    return await session.prompt(prompt) as string;
  } finally {
    if (typeof context.dispose === 'function') await context.dispose();
  }
}

async function ollamaProvider(prompt: string, model: string, baseUrl: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Ollama: any;
  try {
    ({ Ollama } = await esmImport('ollama'));
  } catch {
    throw new Error("'ollama' provider requires the ollama package. Install it with: npm install ollama");
  }
  const client = new Ollama({ host: baseUrl });
  const response = await client.chat({
    model,
    messages: [{ role: 'user', content: prompt }],
  });
  return response.message?.content ?? '';
}

async function openaiProvider(
  prompt: string,
  model: string,
  apiKey: string,
  baseUrl?: string
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let OpenAI: any;
  try {
    ({ OpenAI } = await esmImport('openai'));
  } catch {
    throw new Error("'openai' provider requires the openai package. Install it with: npm install openai");
  }
  const client = new OpenAI({
    apiKey,
    ...(baseUrl ? { baseURL: baseUrl.replace(/\/$/, '') } : {}),
  });
  const msg = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 4096,
  });
  return msg.choices[0]?.message?.content ?? '';
}

async function anthropicProvider(
  prompt: string,
  model: string,
  apiKey: string,
  baseUrl?: string
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Anthropic: any;
  try {
    ({ default: Anthropic } = await esmImport('@anthropic-ai/sdk'));
  } catch {
    throw new Error("'anthropic' provider requires @anthropic-ai/sdk. Install it with: npm install @anthropic-ai/sdk");
  }
  const client = new Anthropic({
    apiKey,
    ...(baseUrl ? { baseURL: baseUrl.replace(/\/$/, '') } : {}),
  });
  const msg = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [{ role: 'user', content: prompt }],
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (msg.content[0] as any)?.text ?? '';
}

async function huggingfaceProvider(
  prompt: string,
  model: string,
  apiKey: string
): Promise<string> {
  // Hugging Face exposes an OpenAI-compatible /v1 endpoint — use the openai SDK with a custom baseURL
  return openaiProvider(prompt, model, apiKey, 'https://api-inference.huggingface.co/v1');
}

async function githubProvider(
  prompt: string,
  model: string,
  apiKey: string
): Promise<string> {
  // GitHub Models is OpenAI-compatible — use the openai SDK with the GitHub Models endpoint
  return openaiProvider(prompt, model, apiKey, 'https://models.inference.ai.azure.com');
}

async function azureinferenceProvider(
  prompt: string,
  model: string,
  apiKey: string,
  endpoint: string
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ModelClient: any, AzureKeyCredential: any;
  try {
    ({ default: ModelClient } = await esmImport('@azure-rest/ai-inference'));
    ({ AzureKeyCredential } = await esmImport('@azure/core-auth'));
  } catch {
    throw new Error(
      "'azureinference' provider requires @azure-rest/ai-inference and @azure/core-auth. " +
      'Install with: npm install @azure-rest/ai-inference @azure/core-auth'
    );
  }
  const client = ModelClient(endpoint.replace(/\/$/, ''), new AzureKeyCredential(apiKey));
  const response = await client.path('/chat/completions').post({
    body: {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4096,
    },
  });
  if (response.status !== '200') {
    throw new Error(`Azure AI Inference ${response.status}: ${JSON.stringify(response.body)}`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (response.body as any).choices?.[0]?.message?.content ?? '';
}

// ─── Bedrock credential pre-flight ───────────────────────────────────────────

function warnIfNoBedrockCredentials(): void {
  const hasEnv = !!(process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY']);
  const hasProfile = !!(process.env['AWS_PROFILE'] || process.env['AWS_DEFAULT_PROFILE']);
  if (hasEnv || hasProfile) return;
  try {
    const credFile = require('path').join(require('os').homedir(), '.aws', 'credentials');
    require('fs').accessSync(credFile);
    return;
  } catch { /* not found */ }
  process.stderr.write(
    '  [ai] Warning: No AWS credentials detected for bedrock provider.\n' +
    '  Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, configure AWS_PROFILE,\n' +
    '  or ensure ~/.aws/credentials exists. The call will fail without credentials.\n'
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bedrockInvokeWithRetry(client: any, command: any, maxRetries = 3, baseDelayMs = 5_000): Promise<any> {
  let attempt = 0;
  while (true) {
    try {
      return await client.send(command);
    } catch (err: unknown) {
      const name = (err as any)?.name ?? '';
      const isThrottle = name === 'ThrottlingException' || name === 'ServiceUnavailableException' || (err as any)?.$retryable;
      if (isThrottle && attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        process.stderr.write(
          `  [ai-generate] bedrock throttled — retrying in ${Math.round(delay / 1000)}s (${attempt + 1}/${maxRetries})\n`
        );
        await new Promise((r) => setTimeout(r, delay));
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

async function bedrockProvider(
  prompt: string,
  model: string,
  region: string
): Promise<string> {
  warnIfNoBedrockCredentials();

  // Dynamic import — requires @aws-sdk/client-bedrock-runtime to be installed
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bedrockModule: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-explicit-any
    const esmImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
    bedrockModule = await esmImport('@aws-sdk/client-bedrock-runtime');
  } catch {
    throw new Error(
      'AWS Bedrock requires @aws-sdk/client-bedrock-runtime. Install it with: npm install @aws-sdk/client-bedrock-runtime'
    );
  }

  const { BedrockRuntimeClient, InvokeModelCommand } = bedrockModule;
  const client = new BedrockRuntimeClient({ region });

  // Support Claude models and Amazon Titan/Nova; default to Anthropic Claude format
  const isClaudeModel = /anthropic\.claude/.test(model);
  const isTitanModel = /amazon\.titan/.test(model);
  const isNovaModel = /amazon\.nova/.test(model);
  const isLlamaModel = /meta\.llama/.test(model);

  let body: string;
  if (isClaudeModel) {
    body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
  } else if (isTitanModel) {
    body = JSON.stringify({
      inputText: prompt,
      textGenerationConfig: { maxTokenCount: 4096, temperature: 0.3 },
    });
  } else if (isNovaModel || isLlamaModel) {
    body = JSON.stringify({
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { max_new_tokens: 4096, temperature: 0.3 },
    });
  } else {
    // Generic: try OpenAI-compatible messages format
    body = JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 4096,
    });
  }

  const response = await bedrockInvokeWithRetry(client, new InvokeModelCommand({
    modelId: model,
    body: new TextEncoder().encode(body),
    contentType: 'application/json',
    accept: 'application/json',
  }));
  const responseText = new TextDecoder().decode(response.body);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = JSON.parse(responseText) as any;

  // Handle different response shapes
  return (
    data.content?.[0]?.text ??           // Anthropic Claude
    data.results?.[0]?.outputText ??     // Amazon Titan
    data.output?.message?.content?.[0]?.text ?? // Amazon Nova
    data.generation ??                   // Meta Llama
    ''
  );
}

async function azureaiProvider(
  prompt: string,
  model: string,
  apiKey: string,
  baseUrl: string
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let AzureOpenAI: any;
  try {
    ({ AzureOpenAI } = await esmImport('openai'));
  } catch {
    throw new Error("'azureai' provider requires the openai package. Install it with: npm install openai");
  }
  const client = new AzureOpenAI({
    apiKey,
    endpoint: baseUrl.replace(/\/$/, ''),
    apiVersion: '2024-12-01-preview',
    deployment: model,
  });
  const msg = await client.chat.completions.create({
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    max_tokens: 4096,
  });
  return msg.choices[0]?.message?.content ?? '';
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Generate a spec file (markdown or gherkin) for an ADO story using an AI provider.
 * Returns the raw file content as a string.
 * Falls back to null if generation fails and heuristicFallback is false (caller handles).
 */
export async function generateSpecFromStory(
  story: AdoStory,
  format: GenerateSpecFormat,
  opts: AiGenerateOpts
): Promise<string> {
  const prompt = buildPrompt(story, format);
  const heuristicFallback = opts.heuristicFallback ?? true;

  const run = async (): Promise<string> => {
    switch (opts.provider) {
      case 'local': {
        if (!opts.model) throw new Error('local provider requires --ai-model <path/to/model.gguf>');
        return localProvider(prompt, opts.model);
      }
      case 'ollama': {
        return ollamaProvider(
          prompt,
          opts.model ?? 'qwen2.5-coder:7b',
          opts.baseUrl ?? 'http://localhost:11434'
        );
      }
      case 'openai': {
        return openaiProvider(
          prompt,
          opts.model ?? 'gpt-4o',
          resolveEnvVar(opts.apiKey ?? ''),
          opts.baseUrl ?? 'https://api.openai.com/v1'
        );
      }
      case 'anthropic': {
        return anthropicProvider(
          prompt,
          opts.model ?? 'claude-sonnet-4-6',
          resolveEnvVar(opts.apiKey ?? ''),
          opts.baseUrl ?? 'https://api.anthropic.com/v1'
        );
      }
      case 'huggingface': {
        if (!opts.model) throw new Error('huggingface provider requires --ai-model <model-id>');
        return huggingfaceProvider(
          prompt,
          opts.model,
          resolveEnvVar(opts.apiKey ?? '')
        );
      }
      case 'bedrock': {
        return bedrockProvider(
          prompt,
          opts.model ?? 'anthropic.claude-3-haiku-20240307-v1:0',
          opts.region ?? process.env['AWS_REGION'] ?? 'us-east-1'
        );
      }
      case 'azureai': {
        if (!opts.baseUrl) throw new Error('azureai provider requires --ai-url <azure-endpoint>');
        return azureaiProvider(
          prompt,
          opts.model ?? 'gpt-4o',
          resolveEnvVar(opts.apiKey ?? ''),
          opts.baseUrl
        );
      }
      case 'github': {
        return githubProvider(
          prompt,
          opts.model ?? 'gpt-4o',
          resolveEnvVar(opts.apiKey ?? process.env['GITHUB_TOKEN'] ?? '')
        );
      }
      case 'azureinference': {
        if (!opts.baseUrl) throw new Error('azureinference provider requires --ai-url <endpoint>');
        return azureinferenceProvider(
          prompt,
          opts.model ?? 'gpt-4o',
          resolveEnvVar(opts.apiKey ?? ''),
          opts.baseUrl
        );
      }
    }
  };

  try {
    const result = await run();
    return result.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (heuristicFallback) {
      process.stderr.write(`  [ai-generate] ${opts.provider} failed (${msg}), using template output\n`);
      return ''; // caller falls back to template
    }
    throw err;
  }
}
