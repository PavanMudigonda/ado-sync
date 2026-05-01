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

The roadmap below focuses only on the remaining gaps that limit scale, predictability, or user trust.

---

## Phase 2: Build a real hierarchy engine

### Problem to solve

Current suite support is no longer limited to the old enum-based mapping, but the hierarchy model still needs to grow beyond the current generated folder, file, tag-driven, and explicit level-rule trees.

### Product direction

Create named hierarchy definitions that can materialize test suites from local structure or explicit routing rules.

### Proposed capabilities

- broader stale-membership cleanup beyond the current move-driven and stale-branch pruning
- optional multiple hierarchy outputs from the same local corpus

### Main files

- `src/azure/test-cases.ts`
- `src/sync/engine.ts`
- `src/types.ts`
- `docs-site/docs/advanced.md`
- `docs-site/docs/configuration.md`

### Exit criteria

- hierarchy definitions support richer models than the current generated folder, file, tag-driven, and explicit level-rule trees
- hierarchy sync can add, move, and prune memberships safely across richer models
- teams can maintain more than one suite view without duplicating specs

Remaining follow-up:

- expand cleanup beyond the current move-driven and stale-branch pruning into broader stale-membership policies
- support multiple parallel hierarchy outputs from the same local corpus

---

## Phase 3: Expand the command surface for scale workflows

### Problem to solve

The current command line is stronger than it was before, but larger repositories and CI pipelines still need a few additional control points and consistency improvements.

### Priority work

1. Extend the diagnostic model beyond push, pull, and status into result publication and other admin workflows.
2. Allow temporary auth and routing overrides in a controlled way.
3. Decide whether any of the new constrained modes should extend beyond push/watch.
4. Keep command docs aligned with the shipped control surface as new flags land.

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

1. Phase 2: remaining hierarchy extensions
2. Phase 5: deeper automation and result-routing behavior
3. Phase 4: configuration ergonomics and shared profiles
4. Phase 6: extension model

This order builds on the already-delivered ownership and command-surface foundations, then adds the routing depth, publishing depth, and configuration ergonomics needed for larger installations.

---

## Near-term backlog candidates

If the goal is to start implementation immediately, the highest-value first batch is:

1. add migration guidance for teams adopting `syncTarget.tagged` from older suite-scoped configs
2. extend the diagnostic model into result publication and other non-sync commands
3. extend hierarchy definitions beyond current generated trees into parallel-output models
4. keep package-boundary validation in CI as the artifact surface evolves

That batch reduces operational risk, hardens ownership boundaries, and keeps the release artifact aligned with the product surface.
