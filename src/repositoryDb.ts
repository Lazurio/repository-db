import path from "node:path";
import { assertDataRepoBoundary } from "./boundary.ts";
import { Collection, type CollectionOptions } from "./collections.ts";
import {
	abortConflict,
	activeConflict,
	markConflictResolved,
} from "./conflict.ts";
import { loadRepositoryDbConfig } from "./config.ts";
import {
	type DiscardOptions,
	type DiscardResult,
	discardDraft,
	recordRevertAvailability,
} from "./discard.ts";
import { computeDraftRevision } from "./draftRevision.ts";
import {
	type DraftOriginKind,
	type DraftOwner,
	clearDraftProvenance,
	readDraftOwner,
	recordDraftOrigin,
} from "./origin.ts";
import { type ReviewOptions, computeReviewSnapshot } from "./review.ts";
import { gitFetchAsync } from "./git.ts";
import { runValidateCommands } from "./generated.ts";
import { publish, pullRemote, type PullResult } from "./publish.ts";
import {
	deriveSyncStatus,
	deriveSyncStatusAsync,
	type StatusOptions,
} from "./status.ts";
import type {
	ConflictState,
	ReviewSurfaceSnapshot,
	PublishOptions,
	PublishResult,
	RepositoryDbConfig,
	SyncStatus,
} from "./types.ts";

/**
 * Facade over one mounted repository-db data checkout.
 *
 * Reading is plain filesystem access (thick client, serverless). Writing
 * produces local drafts in the Git working tree; `publish()` turns the
 * current draft batch into one pushed commit. All operations enforce the
 * Git boundary guard so they can never run against a parent code repo.
 */
export class RepositoryDb {
	readonly mountRoot: string;
	readonly config: RepositoryDbConfig;

	private constructor(mountRoot: string, config: RepositoryDbConfig) {
		this.mountRoot = mountRoot;
		this.config = config;
	}

	static open(mountRoot: string): RepositoryDb {
		const resolved = path.resolve(mountRoot);
		const config = loadRepositoryDbConfig(resolved);
		assertDataRepoBoundary(resolved, config);
		return new RepositoryDb(resolved, config);
	}

	collection<T>(name: string, options: CollectionOptions<T>): Collection<T> {
		return new Collection<T>(this.mountRoot, this.config, name, options);
	}

	/** Local sync state (no network). Use {@link statusAsync} for a fresh `behind`. */
	status(): SyncStatus {
		return deriveSyncStatus(this.mountRoot, this.config);
	}

	/** Sync state, optionally running an async `git fetch` first. */
	statusAsync(options: StatusOptions = {}): Promise<SyncStatus> {
		return deriveSyncStatusAsync(this.mountRoot, this.config, options);
	}

	async fetchAsync(): Promise<void> {
		assertDataRepoBoundary(this.mountRoot, this.config);
		await gitFetchAsync(this.mountRoot);
	}

	validate(): string[] {
		assertDataRepoBoundary(this.mountRoot, this.config);
		return runValidateCommands(this.mountRoot, this.config);
	}

	publish(options: PublishOptions): Promise<PublishResult> {
		return publish(this.mountRoot, this.config, options);
	}

	/** Fetch + integrate remote changes (autostash-safe, conflict-guarded). */
	pull(): Promise<PullResult> {
		return pullRemote(this.mountRoot, this.config);
	}

	/**
	 * Resolve the current draft into reviewable resources with business labels,
	 * app routes and structural field diffs. A path no adapter claims still
	 * appears, degraded to a generic or technical diff — never hidden.
	 */
	review(options: ReviewOptions = {}): Promise<ReviewSurfaceSnapshot> {
		return computeReviewSnapshot(this.mountRoot, this.config, options);
	}

	/**
	 * Identity of the draft as it currently stands. The panel shows a draft with
	 * its revision and hands it back on publish or discard, so a confirmation
	 * always applies to the version the user actually saw.
	 */
	draftRevision(): string {
		return computeDraftRevision(this.mountRoot);
	}

	/**
	 * Return draft work to the published state: one canonical record, or the
	 * whole draft. Runs only if the draft still matches the displayed revision.
	 */
	discard(options: DiscardOptions): DiscardResult {
		return discardDraft(this.mountRoot, this.config, options);
	}

	/** Can this record be reverted on its own right now, and if not, why not? */
	canRevertRecord(relativePath: string): { supported: boolean; reason?: string } {
		return recordRevertAvailability(this.mountRoot, this.config, relativePath);
	}

	/**
	 * Record where a write came from, right after the host API or CLI performed
	 * it. Information only; it never gates an operation.
	 */
	recordOrigin(
		paths: readonly string[],
		origin: { kind: DraftOriginKind; actor?: string; source?: string },
	): void {
		recordDraftOrigin(this.mountRoot, paths, origin);
	}

	/** Coarse label for the whole draft: who wrote first after the last publish. */
	draftOwner(): DraftOwner | undefined {
		return readDraftOwner(this.mountRoot);
	}

	/** Drop both provenance markers; the draft they described no longer exists. */
	clearDraftProvenance(): void {
		clearDraftProvenance(this.mountRoot);
	}

	conflict(): ConflictState | undefined {
		return activeConflict(this.mountRoot);
	}

	abortConflict(): void {
		abortConflict(this.mountRoot);
	}

	markConflictResolved(): void {
		markConflictResolved(this.mountRoot);
	}
}
