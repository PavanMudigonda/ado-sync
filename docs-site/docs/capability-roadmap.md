# Capability Roadmap

This roadmap captures the remaining work to expand ado-sync toward portfolio-scale usage. Items already shipped have been removed — only pending capabilities remain.

> **Reading guide:** Start with [At a glance](#at-a-glance) for the full picture in 30 seconds. Jump to a specific phase for implementation detail. Reference sections (glossary, FAQ, error catalog) are at the end for lookup as needed.

### Table of contents

- [At a glance](#at-a-glance)
- [Current strengths (delivered)](#current-strengths-delivered)
- [Non-goals](#non-goals)
- [Phase 2: Hierarchy engine (remaining)](#phase-2-hierarchy-engine-remaining)
- [Phase 3: Command surface (remaining)](#phase-3-command-surface-remaining)
- [Phase 4: Configuration ergonomics (remaining)](#phase-4-configuration-ergonomics-remaining)
- [Phase 5: Result publishing (remaining)](#phase-5-result-publishing-remaining)
- [Phase 6: Extension points](#phase-6-extension-points)
- [Implementation order & effort](#recommended-implementation-order)
- [Near-term backlog](#near-term-backlog-candidates)
- [Dependency graph](#phase-dependency-graph)
- [Cross-cutting concerns](#cross-cutting-concerns)
- [Validation strategy](#validation-strategy)
- [Glossary](#glossary)
- [File interaction matrix](#file-interaction-matrix)
- [Decision log](#decision-log)
- [Performance budget](#performance-budget)
- [Rollback strategy](#rollback-and-feature-flag-strategy)
- [FAQ](#faq)
- [ADO API surface](#ado-api-surface-by-phase)
- [Structured logging](#structured-log-output)
- [Error catalog](#error-catalog)
- [Troubleshooting](#troubleshooting-runbook)
- [Implementer's guide](#implementers-guide)
- [Revision history](#revision-history)

---

## At a glance

| Phase | Focus | Status | Complexity | Pending work |
|-------|-------|--------|------------|--------------|
| 2 | Hierarchy engine | Mostly delivered | Low | Broader stale-membership policies |
| 3 | Command surface | Partially delivered | Medium | Glob-based `--include`, auth overrides, env vars, doc-check |
| 4 | Configuration | Partially delivered | Medium | JSONC, personal overlays, remote profiles, config show |
| 5 | Result publishing | Partially delivered | High | Classification rules, multi-destination, dry-run audit |
| 6 | Extension points | Not started | High | Full plugin model |

---

## Current strengths (delivered)

ado-sync already delivers:

- Bidirectional push and pull for local specs and Azure DevOps test cases
- Broad parser coverage across Gherkin, source-code, tabular, and result-file formats
- Azure work item linking, state updates, attachments, and field updates
- Test result publishing with multiple input formats
- Higher-level workflows: stale detection, coverage, trend analysis, AI-assisted generation, editor integration
- Command-surface foundations: constrained modes (`--create-only`, `--link-only`, `--update-only`), `--source-file` scoping
- Multi-plan hierarchy via `testPlans[]` array with per-plan hierarchy, suiteRouting, and suiteConditions
- Suite hierarchy models: `byFolder`, `byFile`, `byTag`, `byLevels` with nested suite creation
- Stale-membership cleanup via `cleanupEmptySuites` and `pruneEmptyGeneratedSuitesForPathKey()`
- Ancestor-folder config inheritance via `toolSettings.parentConfig` with deep merge and cycle detection
- Retry handling via `flakyTestOutcome` option (`lastAttemptOutcome`, `firstAttemptOutcome`, `worstOutcome`)
- Environment variable references in config values (`$ENV_VAR` syntax for auth.token, ai.apiKey, etc.)
- `ADO_SYNC_CONFIG` environment variable for config path override

---

## Non-goals

These are explicitly out of scope for this roadmap:

- **Full ADO API parity** — ado-sync is not a general-purpose ADO client; it syncs test artifacts
- **Real-time sync** — event-driven webhook integration is a future consideration, not a current phase
- **Multi-tenant SaaS hosting** — ado-sync remains a CLI/CI tool, not a hosted service
- **Replacing ADO's native UI** — the tool complements the web interface, it does not replace it

---

## Phase 2: Hierarchy engine (remaining)

| Status | Dependencies | Complexity |
|--------|--------------|------------|
| Mostly delivered | — | Low |

### What's already done

- Multi-plan hierarchy via `testPlans[]` with per-plan config
- Suite models: `byFolder`, `byFile`, `byTag`, `byLevels`
- Empty-suite pruning after moves (`cleanupEmptySuites`)

### Remaining work

Expand stale-membership cleanup beyond the current move-driven and empty-suite pruning into broader policies:

1. Time-based staleness detection — remove memberships for specs not synced within a configurable window
2. Branch-aware pruning — clean up suites associated with deleted/merged branches
3. Orphan detection report — `ado-sync stale --suites` to list memberships with no matching local spec

### User stories

- As a release manager, I want time-based staleness policies so that abandoned test cases don't persist indefinitely in suite views.
- As a team lead, I want orphan detection so that I can audit suite membership accuracy before a release.

### Main files

| File | Expected change |
|------|----------------|
| `src/azure/test-cases.ts` | Time-based and branch-aware pruning logic |
| `src/sync/engine.ts` | Staleness policy evaluation during sync |
| `src/types.ts` | `StalenessPolicy` interface with time/branch/orphan options |

### Exit criteria

- Stale-membership policies are configurable per plan entry
- `ado-sync stale --suites` reports orphaned memberships without modifying remote state
- Time-based pruning respects a safety threshold (`maxPruneCount`)

### Success metrics

- Stale-membership count across monitored projects trends toward zero after enabling policies
- Zero data-loss incidents from automated pruning

### Example config shape

```jsonc
{
  "testPlans": [{
    "hierarchy": { "mode": "byFolder" },
    "stalenessPolicy": {
      "maxAge": "30d",
      "pruneBranches": ["merged", "deleted"],
      "maxPruneCount": 50
    }
  }]
}
```

### Acceptance scenarios

| # | Given | When | Then |
|---|-------|------|------|
| 1 | A test case hasn't been synced in 45 days; policy is `maxAge: 30d` | `ado-sync push` | Membership is removed from the suite |
| 2 | Pruning would remove 60 memberships; `maxPruneCount` is 50 | `ado-sync push` | Error `E_HIERARCHY_ORPHAN`; no changes made |
| 3 | Operator wants to audit without changing anything | `ado-sync stale --suites` | Report lists orphaned memberships with last-sync dates |

### Delivery milestones

| Milestone | Scope | Ship criteria |
|-----------|-------|---------------|
| 2-alpha | `ado-sync stale --suites` report command | Shows orphans without modifying remote |
| 2-beta | Time-based and branch-aware pruning with `maxPruneCount` safety | Validated on 2+ real projects |
| 2-GA | Full policy config; docs updated | No P1 bugs for 2 weeks |

---

## Phase 3: Command surface (remaining)

| Status | Dependencies | Complexity |
|--------|--------------|------------|
| Partially delivered | — | Medium |

### What's already done

- `--create-only`, `--link-only`, `--update-only` constrained modes
- `--source-file <path>` for specific file targeting
- `$ENV_VAR` reference syntax in config values
- `ADO_SYNC_CONFIG` env var

### Remaining work

1. **Glob-based `--include` filter** — scope sync to subdirectories via glob patterns (broader than `--source-file` which requires exact paths)
2. **Auth override flags** — `--pat-override` and `--org-override` for temporary auth without editing config
3. **Systematic `ADO_SYNC_*` environment variables** — convention for all config overrides via env
4. **CLI doc-check in CI** — automated validation that `--help` output stays in sync with docs

### User stories

- As a CI engineer, I want to sync only tests matching a glob pattern so that pipeline runs stay fast without listing every file.
- As an operator, I want to pass a temporary PAT override via flag so that I can troubleshoot auth issues without editing shared config.

### Main files

| File | Expected change |
|------|----------------|
| `src/cli.ts` | `--include` glob flag, `--pat-override`, `--org-override` flags |
| `src/config.ts` | Runtime override merging from CLI flags and `ADO_SYNC_*` env vars |
| `src/sync/engine.ts` | Glob-based scope filtering before sync execution |
| `docs-site/docs/cli.md` | Updated command reference |

### Exit criteria

- `--include 'src/payments/**'` syncs only matching specs (glob, not exact path)
- `--pat-override` and `--org-override` work without modifying config on disk
- All config keys are overridable via `ADO_SYNC_` prefixed env vars
- CI check fails if `--help` output diverges from docs

### Success metrics

- CI pipeline duration for scoped syncs is proportional to scope size, not total repo size
- No config-file edits required for standard CI override patterns

### Example CLI usage

```bash
# Glob-based scope (broader than existing --source-file)
ado-sync push --include 'src/payments/**'

# Temporary auth override for debugging
ado-sync push --pat-override "$TEMP_PAT" --org-override "https://dev.azure.com/debug-org"

# Env var override (systematic convention)
ADO_SYNC_PAT="$TOKEN" ADO_SYNC_ORG="https://dev.azure.com/my-org" ado-sync push
```

### Acceptance scenarios

| # | Given | When | Then |
|---|-------|------|------|
| 1 | A monorepo with 200 spec files across 10 services | `ado-sync push --include 'src/payments/**'` | Only payment-service specs are synced |
| 2 | An operator needs to debug with a different org | `ado-sync push --org-override $URL --pat-override $PAT` | Commands execute against override target |
| 3 | `ADO_SYNC_PROJECT` is set in environment | `ado-sync push` (no flag) | Project from env var overrides config file |
| 4 | A new flag is added to the CLI | CI doc-check runs | Build fails if `--help` diverges from docs |

### Migration notes

- All new flags are opt-in; existing commands behave identically without them
- `ADO_SYNC_*` env vars take precedence over config file but are overridden by explicit flags
- Existing `--source-file` continues to work alongside `--include`

### Delivery milestones

| Milestone | Scope | Ship criteria |
|-----------|-------|---------------|
| 3-alpha | `--include` glob filter | Works in local testing |
| 3-beta | Auth overrides + `ADO_SYNC_*` env vars | CI pipeline templates validated in 2+ repos |
| 3-GA | Doc-check CI gate; all flags documented | No flag changes for 1 release cycle |

### CI pipeline examples

**GitHub Actions:**

```yaml
- name: Sync changed tests only
  run: ado-sync push --include 'src/payments/**' --create-only
  env:
    ADO_SYNC_PAT: ${{ secrets.ADO_PAT }}
    ADO_SYNC_ORG: ${{ vars.ADO_ORG }}
```

**Azure Pipelines:**

```yaml
- script: ado-sync push --include '$(Build.SourcesDirectory)/tests/**' --dry-run
  displayName: 'Dry-run sync (PR validation)'
  env:
    ADO_SYNC_PAT: $(ADO_PAT)
```

---

## Phase 4: Configuration ergonomics (remaining)

| Status | Dependencies | Complexity |
|--------|--------------|------------|
| Partially delivered | Phase 3 (benefits from env var decisions) | Medium |

### What's already done

- Ancestor-folder config inheritance via `toolSettings.parentConfig` with deep merge
- Circular reference detection in config chain
- `$ENV_VAR` reference syntax for secrets in config values

### Remaining work

1. **Comment-tolerant JSON (JSONC) parsing** — allow comments in config files
2. **Personal config overlays** — `.ado-sync.local.json` that is git-ignored by default
3. **Remote profiles** — reusable, named connection settings that multiple repos can reference via `"extends"`
4. **`config show --resolved` command** — debug tool showing final merged config with source attribution

### User stories

- As a platform team member, I want to publish a shared org-level config profile so that every repo inherits connection settings without copy-paste.
- As a developer, I want to keep my personal PAT in a local overlay that is git-ignored by default so that credentials never end up in version control.

### Main files

| File | Expected change |
|------|----------------|
| `src/config.ts` | JSONC parsing, overlay loading, profile resolution, `config show` logic |
| `src/types.ts` | Config schema types for overlays, profiles, and `"extends"` |
| `src/cli.ts` | `config show --resolved` command |
| `docs-site/docs/configuration.md` | Layering guide, profile reference |

### Exit criteria

- Config files with `//` and `/* */` comments parse successfully
- `.ado-sync.local.json` is auto-added to `.gitignore` on first use
- `"extends": "profile-name"` loads shared settings from `~/.config/ado-sync/profiles/`
- `config show --resolved` displays final config with each value's source file annotated

### Success metrics

- Average config file size for multi-team orgs decreases by 50%+ after adopting profiles
- Zero credential-leak incidents from config files checked into version control
- New-repo onboarding time (config setup) drops below 5 minutes

### Example config layering

```
~/.config/ado-sync/profiles/acme-corp.json   ← org-wide connection settings
├── /repo/.ado-sync.json                     ← repo-specific sync rules (extends profile)
│   └── /repo/.ado-sync.local.json           ← personal overlay (git-ignored)
```

```jsonc
// ~/.config/ado-sync/profiles/acme-corp.json
{
  "profile": "acme-corp",
  "organization": "https://dev.azure.com/acme",
  "project": "Engineering",
  "defaultArea": "Engineering\\QA"
}

// /repo/.ado-sync.json
{
  "extends": "acme-corp",
  "syncTarget": { "tagged": true },
  "include": ["tests/**"]
}
```

### Open questions

- Should `"extends"` coexist with existing `toolSettings.parentConfig`? (likely yes — profiles for org settings, parentConfig for repo hierarchy)
- What is the merge strategy when profile and repo config define the same key — last-wins or deep-merge? (current parentConfig uses deep-merge)

### Acceptance scenarios

| # | Given | When | Then |
|---|-------|------|------|
| 1 | A profile exists at `~/.config/ado-sync/profiles/acme.json` | Repo config has `"extends": "acme"` | Resolved config merges profile settings with repo overrides |
| 2 | A `.ado-sync.local.json` is created | `git status` | The file appears in `.gitignore` and is not tracked |
| 3 | Config uses `// comments` | `ado-sync push` | Comments are tolerated; config parses successfully |
| 4 | An operator runs `ado-sync config show --resolved` | — | Each value shows its source (profile / repo / local / env) |

### Delivery milestones

| Milestone | Scope | Ship criteria |
|-----------|-------|---------------|
| 4-alpha | JSONC parsing; `config show --resolved` | No regressions in existing tests |
| 4-beta | Personal overlays with auto-gitignore | Validated with 3+ team configurations |
| 4-GA | Remote profiles with `"extends"`; full docs | Onboarding time measurably reduced |

---

## Phase 5: Result publishing (remaining)

| Status | Dependencies | Complexity |
|--------|--------------|------------|
| Partially delivered | Phase 2 remaining work (staleness informs routing) | High |

### What's already done

- Result publishing to a single target suite (`publishTestResults.testSuite`)
- Retry handling via `flakyTestOutcome` with `lastAttemptOutcome` / `firstAttemptOutcome` / `worstOutcome`
- Basic `sync.markAutomated` boolean toggle

### Remaining work

1. **Automation classification rules** — pattern-matching rules instead of a single coarse toggle
2. **Multi-destination publishing** — route results to more than one suite per publish operation
3. **Classification audit in dry-run** — `ado-sync publish --dry-run` shows which rule matched each test

### User stories

- As a test architect, I want fine-grained automation classification rules so that manual exploratory tests and automated regression tests get correct metadata without a blanket toggle.
- As a pipeline owner, I want results published to multiple suites simultaneously so that the regression suite and nightly suite both reflect the latest run.

### Main files

| File | Expected change |
|------|----------------|
| `src/sync/publish-results.ts` | Classification rules engine, multi-destination routing, dry-run audit |
| `src/azure/test-runs.ts` | Run creation for multiple target suites |
| `src/azure/test-cases.ts` | Automation status write-back per classification rule |
| `src/types.ts` | `ClassificationRule`, `RoutingPolicy` interfaces |
| `docs-site/docs/publish-test-results.md` | Rule syntax reference |

### Exit criteria

- Classification rules determine automation status per test case (not a blanket toggle)
- `publishTestResults.destinations` array routes results to multiple suites
- `ado-sync publish --dry-run` shows which rule matched each test and which destination was selected

### Success metrics

- Automation status mismatches between local and remote drop to zero for configured repos
- Teams using multi-destination publishing report no manual suite-copy workarounds

### Example classification rules

```jsonc
{
  "publishTestResults": {
    "automationRules": [
      {
        "match": { "tags": ["@manual", "@exploratory"] },
        "classification": "manual"
      },
      {
        "match": { "path": "tests/regression/**" },
        "classification": "automated",
        "destinations": ["Regression Suite", "Nightly Suite"]
      },
      {
        "match": { "default": true },
        "classification": "automated"
      }
    ]
  }
}
```

### Open questions

- Should multi-destination publishing be transactional (all-or-nothing) or best-effort with partial-failure reporting?
- How should conflicting classification rules be resolved — first-match-wins (like current config) or priority field?

### Acceptance scenarios

| # | Given | When | Then |
|---|-------|------|------|
| 1 | A spec tagged `@manual` matches a classification rule | `ado-sync publish` | Test case automation status is set to "manual" in ADO |
| 2 | A rule routes to two suites | `ado-sync publish` | Results appear in both suites |
| 3 | An operator wants to audit rule matching | `ado-sync publish --dry-run` | Each test shows which rule matched and destination selected |
| 4 | No rules are configured; `sync.markAutomated: true` is set | `ado-sync push` | Legacy toggle behavior continues unchanged |

### Migration notes

- Existing `sync.markAutomated` boolean continues to work as a catch-all rule with lowest priority
- Multi-destination is opt-in; default remains single-suite via `publishTestResults.testSuite`
- `automationRules` array is evaluated top-to-bottom; first match wins

### Delivery milestones

| Milestone | Scope | Ship criteria |
|-----------|-------|---------------|
| 5-alpha | Classification rules engine (single-destination) | Rules correctly classify against existing test corpus |
| 5-beta | Multi-destination routing; dry-run audit output | Validated with a real multi-suite project |
| 5-GA | Full rule syntax docs; migration from single toggle | No automation-status regressions for 2 weeks |

---

## Phase 6: Extension points

| Status | Dependencies | Complexity |
|--------|--------------|------------|
| Not started | Phases 2, 5 (stable core interfaces required) | High |

### Problem to solve

ado-sync already supports many ecosystems, but every new integration currently requires first-party changes to the parser switch statement in `src/sync/engine.ts`.

### Product direction

Introduce a narrow extension model for parser registration, result ingestion, custom routing, and metadata transforms.

### User stories

- As an integrator, I want to register a custom parser for our proprietary test format without forking ado-sync so that we stay on the upgrade path.
- As a platform team, I want to ship a routing policy extension that maps tests to suites using our internal service catalog.

### Candidate extension seams

- local spec discovery
- parser registration
- result-file ingestion
- test-case field transformation
- run-routing policies

### Main files

| File | Expected change |
|------|----------------|
| `src/types.ts` | Extension interface contracts and registration types |
| `src/config.ts` | Extension discovery and loading from config |
| `src/parsers/` | Refactor built-in parsers to use the extension interface |
| `src/sync/engine.ts` | Hook points for custom discovery and routing (replace switch) |
| `src/sync/publish-results.ts` | Hook points for custom ingestion and transforms |

### Exit criteria

- New parsers ship as separate packages without modifying core
- `ado-sync extensions list` shows registered extensions
- `ado-sync extensions validate` checks version compatibility
- Built-in parsers continue to work without any extension configuration

### Success metrics

- New parser integrations ship without modifying core `src/sync/` or `src/azure/` files
- Time-to-first-extension for a third-party contributor is under 1 day with docs alone
- Core package size stays constant as extension count grows

### Example extension registration

```jsonc
{
  "extensions": [
    {
      "name": "robot-framework-parser",
      "type": "parser",
      "package": "@acme/ado-sync-robot",
      "filePatterns": ["**/*.robot"]
    },
    {
      "name": "service-catalog-router",
      "type": "routing-policy",
      "package": "@acme/ado-sync-catalog-router"
    }
  ]
}
```

```bash
ado-sync extensions list
ado-sync extensions validate
```

### Risks

- Over-engineering the plugin surface before usage patterns stabilize — start with parser seam only
- Version compatibility between core and extensions needs a clear semver contract
- Performance overhead from indirection must stay negligible for the zero-extension case

### Acceptance scenarios

| # | Given | When | Then |
|---|-------|------|------|
| 1 | A third-party parser is registered in config | `ado-sync push` with matching files | Extension parser is loaded and specs are synced |
| 2 | An extension has an incompatible version | `ado-sync extensions validate` | Clear error with version mismatch details |
| 3 | No extensions are configured | `ado-sync push` | Performance identical to pre-extension builds |
| 4 | A routing-policy extension is registered | `ado-sync push --dry-run` | Dry-run shows which extension handled each routing decision |

### Delivery milestones

| Milestone | Scope | Ship criteria |
|-----------|-------|---------------|
| 6-alpha | Parser extension seam only; one built-in parser refactored to use it | Internal parser works identically through extension interface |
| 6-beta | Result-ingestion and routing-policy seams; `extensions list/validate` | One real third-party extension functional |
| 6-GA | All 5 seams open; extension authoring docs; semver contract | Two independent extensions ship without core changes |

---

## Recommended implementation order

| Order | Phase | Rationale | Estimated effort |
|-------|-------|-----------|-----------------|
| 1 | Phase 3: command surface | Low-hanging wins; unblocks CI adoption at scale | 1–2 weeks |
| 2 | Phase 4: config ergonomics | Reduces onboarding friction; benefits from Phase 3 env var decisions | 2–3 weeks |
| 3 | Phase 2: staleness policies | Small scope; completes the hierarchy story | 1–2 weeks |
| 4 | Phase 5: classification & multi-destination | High enterprise demand; builds on stable core | 3–4 weeks |
| 5 | Phase 6: extension model | Requires all prior interfaces to stabilize | 4–5 weeks |

**Total estimated effort:** 11–16 weeks (sequential). Phases 3 and 2-remaining can overlap.

---

## Near-term backlog candidates

Highest-value first batch for immediate implementation:

| # | Item | Risk reduced | Effort |
|---|------|-------------|--------|
| 1 | `--include` glob filter for push/pull/watch | Unblocks monorepo CI without per-file listing | 2–3 days |
| 2 | JSONC config parsing | Removes friction for teams that comment their configs | 1 day |
| 3 | `config show --resolved` command | Eliminates debugging time for layered configs | 2–3 days |
| 4 | `ADO_SYNC_*` env var convention | Enables clean CI templates without config editing | 2–3 days |

---

## Phase dependency graph

```
Already delivered (Phase 1 + most of 2, 3, 4, 5)
├── Phase 3 remaining: --include, auth overrides, env vars
│   └── Phase 4 remaining: JSONC, overlays, profiles (benefits from env decisions)
├── Phase 2 remaining: staleness policies
│   └── Phase 5 remaining: classification rules, multi-destination
│       └── Phase 6: extension model (needs stable interfaces)
```

---

## Cross-cutting concerns

| Concern | Approach |
|---------|----------|
| **Backwards compatibility** | Config schema changes are additive; old configs remain valid |
| **Performance at scale** | Batch ADO API calls; diff-based updates, not full rebuilds |
| **Observability** | Structured log output with operation counts, timing, and error context |
| **Error recovery** | Partial failures leave remote consistent; re-run resumes |
| **Security** | Credentials never logged; PAT handling follows least-privilege scoping |

### Security considerations

| Threat | Mitigation | Phase |
|--------|-----------|-------|
| PAT leakage in logs | Credentials redacted from all log output | All |
| PAT in config committed to git | Personal overlays git-ignored; `config show` redacts secrets | 4 |
| Malicious extension code | Extensions loaded from declared packages only | 6 |
| Over-permissioned PAT | Docs recommend minimum scopes; `--dry-run` needs only read | All |
| Config injection via ancestor discovery | Already stops at boundaries via `parentConfig` | 4 |

### Stakeholder responsibilities

| Role | Responsibility | Phases |
|------|---------------|--------|
| **Product owner** | Prioritize phases, resolve open questions | All |
| **Core developer** | Implement, test, update docs in same PR | All |
| **Platform/DevOps** | Validate CI templates, test env var convention | 3, 4 |
| **QA lead** | Validate classification rules against real suite structures | 5 |
| **Security reviewer** | Review credential handling, extension loading | 4, 6 |
| **Early adopters** | Beta testing, feedback on ergonomics | All (beta+) |

---

## Validation strategy

Each phase ships with:

1. **Dry-run output** — every destructive operation previews its effect before committing
2. **Integration tests** — covering the happy path and at least one error/edge case per exit criterion
3. **Migration path** — existing configs continue to work unchanged; new features are opt-in
4. **Documentation update** — docs-site pages updated in the same PR as the implementation

### Test pyramid by phase

| Test type | Phase 2 rem. | Phase 3 rem. | Phase 4 rem. | Phase 5 rem. | Phase 6 |
|-----------|-------------|-------------|-------------|-------------|---------|
| **Unit** | Staleness policy evaluation | Glob matching, env var resolution | JSONC parsing, overlay merge, profile resolution | Rule matching, classification logic | Interface validation, extension loading |
| **Integration** | Pruning against ADO sandbox | Scoped push end-to-end | Layered config from filesystem | Publish with classification to live ADO | Extension invoked in sync pipeline |
| **E2E** | Staleness report on real project | CI pipeline with `--include` | Fresh repo onboarding with profiles | Multi-destination publish | Third-party parser syncing custom format |
| **Regression** | Existing cleanup still works | `--source-file` still works | `parentConfig` still works | `sync.markAutomated` still works | Zero-extension perf unchanged |

---

## Glossary

| Term | Definition |
|------|-----------|
| **Staleness policy** | Rules defining when a suite membership is considered stale and eligible for pruning |
| **Constrained mode** | A CLI execution mode that limits allowed operations (create-only, link-only, update-only) |
| **Config overlay** | A local-only config file (`.ado-sync.local.json`) that merges on top of shared config; git-ignored |
| **Config profile** | A reusable, named set of connection settings that repos can reference via `"extends"` |
| **Classification rule** | A pattern-matching rule that determines automation status (automated/manual) per test |
| **Routing policy** | Logic determining which ADO suite(s) a result or test case publishes to |
| **Extension seam** | A defined interface point where third-party code hooks into the sync pipeline |
| **Spec** | A local test specification file in any supported format |

---

## File interaction matrix

| File | Phase 2 rem. | Phase 3 rem. | Phase 4 rem. | Phase 5 rem. | Phase 6 |
|------|-------------|-------------|-------------|-------------|---------|
| `src/types.ts` | ✓ | | ✓ | ✓ | ✓ |
| `src/config.ts` | | ✓ | ✓ | | ✓ |
| `src/cli.ts` | | ✓ | ✓ | | |
| `src/sync/engine.ts` | ✓ | ✓ | | | ✓ |
| `src/azure/test-cases.ts` | ✓ | | | ✓ | |
| `src/sync/publish-results.ts` | | | | ✓ | ✓ |

**Key conflicts:** `src/types.ts` touched by 4 phases — land Phase 3+4 types before Phase 5+6.

---

## Decision log

| Date | Phase | Decision | Rationale | Decided by |
|------|-------|----------|-----------|------------|
| — | — | *(fill as decisions are made)* | — | — |

---

## Performance budget

| Operation | Target | Hard limit | Notes |
|-----------|--------|------------|-------|
| Config resolution (with profile + overlay) | < 50ms | 200ms | Includes JSONC parsing and profile loading |
| Glob scope filtering (500 specs) | < 100ms | 500ms | `--include` pattern matching |
| Staleness evaluation (1000 cases) | < 2s | 10s | Local diff against last-sync timestamps |
| Multi-destination publish (500 results × 2 suites) | < 60s | 180s | Parallel API calls |
| Extension loading (5 extensions) | < 200ms | 1s | Package require + interface validation |

---

## Rollback and feature-flag strategy

| Stage | Mechanism | Rollback path |
|-------|-----------|---------------|
| Alpha | Hidden behind `--experimental` flag | Remove flag usage |
| Beta | Visible in `--help` marked `[beta]` | Remove config block; old behavior resumes |
| GA | Fully documented; stable contract | Semver-governed breaking changes only |

**Guarantees:**
- No phase modifies ADO data in a way that prevents reverting to a prior ado-sync version
- Config schema is always backwards-compatible
- Dry-run available at every stage

---

## FAQ

**Q: Will existing configs break when I upgrade?**
A: Never. All schema changes are additive. `sync.markAutomated`, `parentConfig`, and existing `testPlans[]` definitions remain valid.

**Q: How does `--include` differ from existing `--source-file`?**
A: `--source-file` takes exact file paths (repeatable). `--include` takes glob patterns for broader scoping without listing every file.

**Q: Can I use profiles alongside existing `parentConfig`?**
A: Yes. `parentConfig` handles repo-hierarchy inheritance. Profiles handle org-level shared settings. They compose.

**Q: What happens if classification rules aren't configured?**
A: The existing `sync.markAutomated` boolean continues to work as a catch-all. Classification rules are opt-in.

**Q: What's the minimum viable extension?**
A: A parser extension — a package exporting a `parse(filePath): TestSpec[]` function and declaring `filePatterns` in config.

---

## ADO API surface by phase

| Phase | API area | Key endpoints | Permission required |
|-------|----------|---------------|---------------------|
| 2 rem. | Test Plans | `DELETE _apis/testplan/Plans/{id}/Suites/{id}/TestCase` | Test Plans: Read & Write |
| 3 rem. | — | No new API surface (CLI-only) | — |
| 4 rem. | — | No new API surface (local config) | — |
| 5 rem. | Test Runs | `POST _apis/test/runs`, `POST _apis/test/runs/{id}/results` | Test Runs: Read & Write |
| 6 | Varies | Extension-determined | Extension-dependent |

---

## Structured log output

```jsonc
// Example: staleness report
{
  "level": "info",
  "phase": "stale-suites",
  "stats": { "orphaned_memberships": 12, "stale_by_age": 8, "stale_by_branch": 4 },
  "dry_run": true,
  "timestamp": "2026-05-01T10:23:45.123Z"
}

// Example: classification audit (dry-run)
{
  "level": "info",
  "phase": "publish",
  "operation": "classify",
  "test": "tests/regression/checkout.feature:12",
  "rule_matched": "path:tests/regression/**",
  "classification": "automated",
  "destinations": ["Regression Suite", "Nightly Suite"],
  "timestamp": "2026-05-01T10:24:01.456Z"
}
```

---

## Error catalog

| Error code | Phase | Message | Resolution |
|------------|-------|---------|------------|
| `E_STALE_THRESHOLD` | 2 | `Pruning would remove {n}; exceeds maxPruneCount` | Review with `--dry-run`, then increase threshold |
| `E_SCOPE_EMPTY` | 3 | `No specs matched the --include pattern` | Verify pattern with `ado-sync list --include '...'` |
| `E_AUTH_OVERRIDE` | 3 | `PAT override failed authentication` | Verify PAT scopes |
| `E_JSONC_PARSE` | 4 | `Config parse error at line {n}` | Check for malformed JSON (comments are fine, trailing commas are not) |
| `E_PROFILE_NOT_FOUND` | 4 | `Profile '{name}' not found` | Create at `~/.config/ado-sync/profiles/{name}.json` |
| `E_CLASSIFY_AMBIGUOUS` | 5 | `Multiple rules matched with equal priority` | Add explicit priority or make patterns mutually exclusive |
| `E_PUBLISH_PARTIAL` | 5 | `Published to 1 of 2 destinations` | Check suite permissions; re-run to retry |
| `E_EXT_VERSION` | 6 | `Extension requires core ≥{v}` | Upgrade ado-sync or downgrade extension |
| `E_EXT_LOAD` | 6 | `Failed to load extension '{pkg}'` | Run `npm ls {pkg}`; check `extensions validate` |

---

## Troubleshooting runbook

### "--include pattern matches nothing"

1. Test the pattern: `ado-sync list --include 'your/pattern/**'`
2. Ensure the pattern is relative to repo root (not absolute)
3. Check that spec files exist at the expected paths

### "config show --resolved shows unexpected values"

1. Run with `--verbose` to see full resolution chain
2. Check for `.ado-sync.local.json` overriding values
3. Verify `"extends"` profile exists and is valid JSONC
4. Check `ADO_SYNC_*` env vars that may override config

### "Classification rules aren't matching"

1. Run `ado-sync publish --dry-run` to see per-test rule matching
2. Rules evaluate top-to-bottom; first match wins
3. Tag rules require exact names including `@` prefix
4. Path patterns use glob syntax

### "Extension loads locally but fails in CI"

1. Verify package in `dependencies` (not `devDependencies`)
2. Run `ado-sync extensions validate` in CI
3. Check Node.js version compatibility
4. Use `npm ci` for deterministic installs

---

## Implementer's guide

### Before starting

1. Read the phase section fully (remaining work → exit criteria → scenarios)
2. Check the [decision log](#decision-log) for resolved questions
3. Review the [file interaction matrix](#file-interaction-matrix) for overlap with in-flight work
4. Set up an ADO sandbox project — never test against production

### During implementation

1. Start with alpha milestone scope — smallest useful slice
2. Add structured log output from day one
3. Write acceptance scenarios as integration tests first
4. Update docs in the same PR
5. `--dry-run` is the first integration point — validates logic without API risk

### PR checklist

- [ ] Acceptance scenarios pass as automated tests
- [ ] Structured log output covers new operations
- [ ] `--dry-run` previews without side effects
- [ ] No regressions in existing test suite
- [ ] Performance within budget (measured)
- [ ] Error catalog entries added for new failure modes
- [ ] Docs updated
- [ ] Config schema additive (old configs still parse)
- [ ] No credentials in log output

### Post-deployment monitoring

| Signal | Alert threshold |
|--------|-----------------|
| Error rate increase | > 2× baseline |
| API rate-limit hits | > 5 per hour per user |
| Performance regression | > 1.5× budget |
| Support ticket spike | > 3 related tickets in 1 week |

---

## Revision history

| Date | Change |
|------|--------|
| 2026-05-01 | Rewrote roadmap to remove delivered items; retained only pending work |
