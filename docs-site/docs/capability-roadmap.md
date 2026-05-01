# Capability Roadmap

This roadmap turns the recent benchmark review into a product-owned plan for expanding ado-sync without copying another tool's terminology or structure.

The goal is straightforward: make large-scale synchronization more predictable, make result publishing more trustworthy, and give teams a cleaner path from single-suite setups to portfolio-scale usage.

---

## Current strengths

ado-sync already delivers a solid base:

- bidirectional push and pull for local specs and Azure DevOps test cases
- broad parser coverage across Gherkin, source-code, tabular, and result-file formats
- Azure work item linking, state updates, attachments, and field updates
- test result publishing with multiple input formats
- higher-level workflows such as stale detection, coverage, trend analysis, AI-assisted generation, and editor integration

The roadmap below focuses on gaps that limit scale, predictability, or user trust.

---

## Phase 1: Introduce scoped synchronization

### Problem to solve

Today the model is centered on a plan, optional suite mapping, and local filters. That works for smaller installations, but it does not give teams a strong way to define which remote inventory a configuration owns.

### Product direction

Add a first-class sync target model that tells ado-sync exactly which remote set belongs to a configuration. This should be original to ado-sync, not a copy of anyone else's schema.

### Proposed design direction

Introduce a new top-level concept such as `syncTarget` or `ownership` with selectable modes:

- `tagged` for test cases carrying a generated ownership tag
- `suite` for test cases managed through a designated suite root
- `query` for test cases matched by an Azure DevOps query or rule set

This model should work alongside `configurationKey`, not replace it.

### Main files

- `src/types.ts`
- `src/config.ts`
- `src/sync/engine.ts`
- `src/cli.ts`
- `docs-site/docs/configuration.md`

### Exit criteria

- push, pull, stale detection, and status all use the same ownership boundary
- removing a local scenario does not risk touching unrelated remote items
- multiple configurations can target the same project without collisions

---

## Phase 2: Build a real hierarchy engine

### Problem to solve

Current suite support is useful but narrow. It covers basic mapping and conditional routing, but not richer hierarchy construction, cleanup rules, or multiple parallel views of the same inventory.

### Product direction

Create named hierarchy definitions that can materialize test suites from local structure, tags, or explicit routing rules.

### Proposed capabilities

- folder-based hierarchy generation
- file-based hierarchy generation
- tag-driven hierarchy generation
- explicit level rules for multi-level suite trees
- cleanup policies for stale nodes and stale memberships
- optional multiple hierarchy outputs from the same local corpus

### Main files

- `src/azure/test-cases.ts`
- `src/sync/engine.ts`
- `src/types.ts`
- `docs-site/docs/advanced.md`
- `docs-site/docs/configuration.md`

### Exit criteria

- hierarchy definitions are declarative and testable
- hierarchy sync can add, move, and prune memberships safely
- teams can maintain more than one suite view without duplicating specs

---

## Phase 3: Expand the command surface for scale workflows

### Problem to solve

The current command line is clean, but it is missing a few control points that matter in large repositories and CI pipelines.

### Priority work

1. Add source-file filters for push and pull.
2. Add operation modes such as create-only, link-only, and update-only where applicable.
3. Add consistent diagnostic controls across commands.
4. Allow temporary auth and routing overrides in a controlled way.

### Main files

- `src/cli.ts`
- `src/config.ts`
- `src/sync/engine.ts`
- `docs-site/docs/cli.md`

### Exit criteria

- operators can target a small slice of a large repo without changing config files
- CI jobs can run low-risk creation-only or link-only flows
- troubleshooting output is consistent across push, pull, status, and result publication

---

## Phase 4: Modernize configuration ergonomics

### Problem to solve

The configuration model is powerful enough for a single repository, but it becomes awkward when shared across many teams or environments.

### Product direction

Make configuration layering easier, safer, and more portable.

### Priority work

1. Support comment-tolerant JSON configuration parsing.
2. Add optional parent-config discovery through ancestor folders.
3. Add personal config overlays for credentials and machine-local overrides.
4. Add reusable remote profiles so org-level connection settings do not need to be copied into every repository.

### Main files

- `src/config.ts`
- `src/types.ts`
- `docs-site/docs/configuration.md`
- `src/cli.ts`

### Exit criteria

- teams can share base config safely without checking credentials into the repo
- repository config stays small even when many projects use the same Azure DevOps org
- the override and inheritance rules are explicit and easy to debug

---

## Phase 5: Deepen automation and result publishing

### Problem to solve

The core publishing flow works, but automation metadata and run routing are still simpler than what enterprise teams usually need.

### Product direction

Expand the publishing model so it can express how tests were executed, where runs should land, and how automated metadata should be maintained.

### Priority work

1. Support automation classification rules instead of a single coarse toggle.
2. Allow controlled publication to more than one destination suite when desired.
3. Add stronger matching and fallback rules for automated result association.
4. Expand comment and attachment policies for complex retry-heavy pipelines.

### Main files

- `src/sync/publish-results.ts`
- `src/azure/test-runs.ts`
- `src/azure/test-cases.ts`
- `src/types.ts`
- `docs-site/docs/publish-test-results.md`

### Exit criteria

- automation metadata is predictable across push and publish flows
- result publication can be routed beyond a single suite binding when required
- retry-heavy pipelines produce consistent final outcomes

---

## Phase 6: Add extension points instead of hard-coding every variant

### Problem to solve

ado-sync already supports many ecosystems, but every new integration currently tends to require first-party changes.

### Product direction

Introduce a narrow extension model for parser registration, result ingestion, custom routing, and metadata transforms.

### Candidate extension seams

- local spec discovery
- parser registration
- result-file ingestion
- test-case field transformation
- run-routing policies

### Main files

- `src/types.ts`
- `src/config.ts`
- parser modules under `src/parsers/`
- `src/sync/engine.ts`
- `src/sync/publish-results.ts`

### Exit criteria

- new ecosystems can be added without invasive changes to the core sync engine
- experimental integrations can ship behind stable interfaces
- core maintenance load stays bounded as format coverage expands

---

## Recommended implementation order

1. Phase 1: scoped synchronization model
2. Phase 3: command-surface improvements needed to operate the new scope model
3. Phase 2: hierarchy engine
4. Phase 5: deeper automation and result-routing behavior
5. Phase 4: configuration ergonomics and shared profiles
6. Phase 6: extension model

This order hardens ownership boundaries first, then adds the operational controls and routing depth needed for larger installations.

---

## Near-term backlog candidates

If the goal is to start implementation immediately, the highest-value first batch is:

1. design `syncTarget` ownership schema in `src/types.ts`
2. wire ownership filtering into `status`, `push`, `pull`, and `stale`
3. add `--source-file`, `--create-only`, and `--link-only` style command controls
4. design declarative hierarchy definitions that can coexist with `syncTarget`
5. tighten result-routing rules for suite-aware publication at scale

That batch reduces operational risk, hardens ownership boundaries, and lays the foundation for the larger roadmap.