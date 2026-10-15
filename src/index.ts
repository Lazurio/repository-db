/**
 * Public API of @lazurio/repository-db.
 *
 * Kept deliberately small: an app opens a data checkout through the
 * {@link createSyncHost} service (or the {@link RepositoryDb} facade), writes
 * records through collections or `writeRecordDraft`, reviews, publishes,
 * pulls and discards through the facade, and words the card with
 * {@link deriveDraftPanel}. Git itself is not part of the API: an app never
 * commits, pushes, rebases or merges its data.
 */
export { RepositoryDb } from "./repositoryDb.ts";
export type { CommitIdentity } from "./identity.ts";
export {
	createSyncHost,
	type SyncHost,
	type SyncHostEvent,
	type SyncHostOptions,
	type SyncHostProblem,
	type SyncHostRecordRef,
	type SyncHostStatus,
} from "./syncHost.ts";
export {
	Collection,
	documentFileName,
	recordRevision,
	recordRevisionFromBytes,
	writeRecordDraft,
	type CollectionDocument,
	type CollectionOptions,
	type RecordWriteOptions,
} from "./collections.ts";
export { CONFIG_FILE_NAME } from "./config.ts";
export { assertDataPath, readDataFile } from "./dataPath.ts";
export { normalizeRemoteUrl } from "./boundary.ts";
export { ensureGenerated, type EnsureGeneratedResult } from "./generated.ts";
export type { PullOptions, PullResult } from "./publish.ts";
export { initDataRepo, type InitOptions, type InitResult } from "./init.ts";
export { parseCommitMessage, type ParsedCommitMessage } from "./trailers.ts";
export { ENGINE_DIR } from "./lock.ts";
export {
	parseYaml,
	toStableJson,
	toStableYaml,
	writeFileAtomic,
	writeYamlFileAtomic,
} from "./yamlIo.ts";
export * from "./types.ts";
export {
	DraftChangedError,
	RevertNotSupportedError,
	type DiscardOptions,
	type DiscardResult,
	type DiscardScope,
	type RevertAvailability,
} from "./discard.ts";
export { computeDraftRevision } from "./draftRevision.ts";
export type { DraftOriginKind, DraftOwner } from "./origin.ts";
export { readBaselineFile, reviewBaselineRef, type ReviewOptions } from "./review.ts";
export { structuralDiff, type StructuralDiffResult } from "./structuralDiff.ts";
export {
	deriveDraftPanel,
	type DraftPanelAction,
	type DraftPanelCapabilities,
	type DraftPanelConflict,
	type DraftPanelFieldRow,
	type DraftPanelInput,
	type DraftPanelModel,
	type DraftPanelRecord,
	type DraftPanelRecordInput,
	type DraftPanelTone,
} from "./draftPanel.ts";
