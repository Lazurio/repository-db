# Review Surface contracts

> This document is the detailed reference for the review resource and change types.
> The normative application-facing rules live in
> [`draft-publish-standard.md`](draft-publish-standard.md).

Repository DB owns Git/YAML status, conflict detection and publish gating. Host
applications can add domain interpretation through a Review Surface adapter, but
the shared contract stays application-agnostic: Repository DB talks about
resources, changes, structural fields, route targets and publish readiness, not
about any one business schema.

This first slice defines only TypeScript contracts and guidance. It does not add
an adapter registry, UI, persistence or publish behavior change.

## Core contract pieces

- `ReviewableResource` is the user-facing unit shown in draft/review UI.
  It has a stable resource id, a required human-readable `label`, an optional
  host-app `routeTarget`, one or more `ResourceChange` rows, a fallback ladder
  and optional publish-readiness references.
- `ResourceChange` is the technical/source change attached to a resource. It
  covers `created`, `modified`, `deleted` and `unknown` changes. Derived output
  (`generated_manifest`) is an ignored cache and never part of a review.
- `ReviewFieldSummary` is the structural field summary used by review lists and
  inline highlights. It uses parsed-record paths such as `details.status`, not
  filesystem paths. It may include app-agnostic `valueKind` and `renderHint`
  metadata so a shared review panel can render fields without importing an app
  component library.
- `ReviewTechnicalReference` keeps data-repo paths available for developer
  details, Git review and agent handoff. These paths are technical metadata and
  must not be the primary normal-user label.
- `ReviewInputChange` is the raw repository-db draft/generated/unknown path
  input before app enrichment. It carries technical refs, coarse Git-ish status,
  optional hashes and optional non-secret JSON diagnostics.
- `ReviewSurfaceAdapter` is the app-provided bridge from raw generic repository
  changes to reviewable resources. A later registry can match adapters by path
  globs and call `toReviewableResources`.
- `ReviewSurfaceSnapshot` is the top-level computed review payload for panels or
  publish summaries. It carries the contract version, baseline head, resources,
  aggregate publish readiness, fallback diagnostics and optional raw inputs.

## Identity and labels

A reviewable resource must expose both a stable machine identity and a readable
human label:

```ts
const resource = {
  appId: "fixture-app",
  resourceType: "fixture-record",
  stableResourceId: "fixture-record:alpha",
  label: "Fixture Alpha",
  routeTarget: { href: "/fixture/records/alpha?review=1" },
  contractMetadata: {
    reviewContractVersion: REVIEW_SURFACE_CONTRACT_VERSION,
    adapterId: "fixture-review-adapter",
    adapterVersion: "1.0.0",
    schemaVersion: "fixture.schema.v1",
    dataSchemaVersion: "fixture-data@1.0.0",
  },
  reviewRepresentationHash: "sha256:resource-review-fixture",
  changes: [],
  fallback: { activeLevel: "resource_adapter", steps: [] },
};
```

The `label` is the primary review UI text. A data-repo path such as
`data/fixture-records/fixture-alpha.yaml` belongs in `technicalRefs`, a technical
details disclosure or an agent/Git handoff. It is never the default button/link
label for normal app users.


## Field metadata

`ReviewFieldSummary` deliberately separates machine paths, readable labels and
render hints:

```ts
const field = {
  fieldPath: "/details/status",
  label: "Status",
  changeKind: "modified",
  valueKind: "enum",
  renderHint: "badge",
  beforeSummary: "Draft",
  afterSummary: "Ready for review",
};
```

`fieldPath` should be a JSON Pointer (RFC 6901) into the parsed record, for
example `/details/status`. Adapters that need a legacy or app-owned path syntax
must document it and keep it deterministic.

`valueKind` and `renderHint` are generic. They describe how a shared review
surface may present a value (`text`, `money`, `date`, `enum`, `object`, …) and
which broad renderer is safe (`plain`, `badge`, `currency`, `json`, …). They are
not app component names and must not encode business-domain types. Detailed raw
values can still be loaded lazily by a later diff/detail API; this contract slice
only standardizes the summary metadata.

## Change kinds

`ResourceChangeKind` intentionally stays coarse:

| Kind | Meaning |
| --- | --- |
| `created` | A canonical resource or file was added. |
| `modified` | Existing parsed data changed. |
| `deleted` | A canonical resource or file was removed. |
| `generated` | A declared generated read model changed. |
| `unknown` | Repository DB cannot map the path to a richer resource/schema yet. |

Unknown changes still appear in review and publish readiness. They degrade to a
technical diff; they must not disappear just because no adapter exists.

## Raw input and snapshot shape

The adapter input is `ReviewInputChange`, not a fully rendered
`ResourceChange`. A raw input change is still technical: it references
repo-relative paths and coarse change status before any app labels, route targets
or field summaries exist. Renames can carry `previousTechnicalRefs`; metadata
must be JSON-serializable and non-secret.

A computed `ReviewSurfaceSnapshot` is the stable top-level handoff object for a
review panel or publish summary:

```ts
const snapshot = {
  reviewContractVersion: REVIEW_SURFACE_CONTRACT_VERSION,
  baselineHead: "0123456789abcdef0123456789abcdef01234567",
  resources: [resource],
  publishReadiness: {
    state: "blocked",
    canPublish: false,
    references: [],
  },
  fallback: resource.fallback,
  reviewRepresentationHash: "sha256:snapshot-review-fixture",
};
```

This is advisory contract shape. It does not wire review readiness into
`publish()` or register adapters; the engine keeps no reviewed marks.

## Fallback ladder

`ReviewFallbackLevel` is ordered from richest to most technical:

1. `resource_adapter` — the host app maps paths to a stable resource id, readable
   label, route target and field summaries.
2. `generic_schema_diff` — Repository DB or a generic parser can show structural
   field changes without app-specific route/anchor metadata.
3. `technical_file_diff` — only raw path/diff evidence is known. This is valid
   for agents and developer details, not a rich normal-user label.
4. `unknown` — the path is visible but no safe classification exists yet.

Review surfaces should render the active level and keep the ladder available for
diagnostics. A missing adapter is a degraded review state, not a hidden change.

## Representation identity

`ReviewSurfaceContractMetadata` travels with a rendered resource so review
consumers know which contract, adapter and schema versions produced the visible
representation. A resource or snapshot `reviewRepresentationHash` should be
derived from stable resource ids, field summaries, technical refs, the fallback
level, baseline head, and review/adapter/schema versions. The engine keeps no
reviewed-state marks: what a publish confirms is the draft revision.

## Adapter/schema version policy

Adapter and schema versions are semantic review-representation versions, not
build counters.

Bump `adapterVersion` or `schemaVersion` when a change can make an existing
review representation misleading, for example:

- a field id or field meaning changes;
- a route target now opens a different review context;
- diff normalization changes before/after summaries materially;
- `REVIEW_SURFACE_CONTRACT_VERSION` changes incompatibly.

Do not bump only for non-invalidating changes, for example:

- adding an optional field label that does not alter existing summaries;
- cosmetic wording changes in helper copy;
- adding a non-blocking metadata field;
- adding a route label while `href` and resource identity stay the same.

## Publish readiness references

`PublishReadinessReference` lets the final publish summary point to blocking and
non-blocking evidence. `PublishReadinessSummary` aggregates those references into
`ready`, `blocked`, `warning` or `unknown` plus a convenience `canPublish` flag.
This is advisory data for the card: `publish()` itself gates on the confirmed
revision, the Git identity, derived output and the validators. The generic kinds
cover:

- `schema_error` — parsed data failed a schema/adapter validation;
- `conflict` — repository conflict state blocks writes or publish;
- `validation_error` — an app rule (or a configured validation command) blocks;
- `unknown` — a visible issue has no richer classification yet.

References can point at `changeIds`, `stableResourceIds` and `technicalRefs` so a
review panel, app row and publish summary can talk about the same draft change.


## JSON metadata boundary

`routeTarget.context`, `ReviewInputChange.metadata`, `ReviewableResource.metadata`
and `ReviewSurfaceSnapshot.metadata` are typed as JSON objects. They are for
small, non-secret diagnostics or grouping hints. They must not carry credentials,
OAuth material, cookies, local host paths or business data that belongs in the
app resource itself.
