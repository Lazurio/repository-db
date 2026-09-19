import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { assertNoActiveConflict } from "./conflict.ts";
import { withDraftWriteLock } from "./lock.ts";
import { readYamlFile, writeYamlFileAtomic } from "./yamlIo.ts";
import {
	type DocumentParser,
	RecordChangedError,
	type RepositoryDbConfig,
	RepositoryDbError,
} from "./types.ts";

/**
 * Document envelope written to disk. The engine owns the envelope (schema
 * version, id); the host application owns the record shape via the injected
 * parser. One document = one YAML file named encodeURIComponent(id) + .yaml.
 */
export interface CollectionDocument<T> {
	schemaVersion: string;
	id: string;
	record: T;
	[key: string]: unknown;
}

export interface CollectionOptions<T> {
	/** Expected envelope schemaVersion, e.g. `deal.v3`. */
	schemaVersion: string;
	/** Domain parser for the record payload (zod-compatible). */
	parser?: DocumentParser<T>;
	/** Optional subdirectory below the data layout dir (defaults to the collection name). */
	directory?: string;
}

/**
 * Revision of one stored record: a hash of its file exactly as stored, or
 * `null` when the record does not exist.
 *
 * A client keeps the revision of the version it started editing and hands it
 * back with the save; the write runs only if the record is still that version.
 * It is per record on purpose: saving one deal never waits on, or fails
 * because of, a change to another. The draft revision answers a different
 * question — which whole draft a publish confirms.
 */
export function recordRevision(filePath: string): string | null {
	let bytes: Buffer;
	try {
		bytes = readFileSync(filePath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export interface RecordWriteOptions {
	/**
	 * Revision of the stored record this write was derived from, `null` when
	 * the record must not exist yet. Omitted only by a writer that has no
	 * displayed version to hold the write to, such as an agent script.
	 */
	baseRevision?: string | null;
}

/**
 * The one way a draft record gets written: through the shared gate, refused
 * during a conflict, and — when the caller names the version it started from —
 * only if the record is still that version. Check and write happen under the
 * same gate, so no other supported write can slip in between.
 *
 * For layouts a {@link Collection} does not describe, a host passes the file
 * and does the write itself inside `write`.
 */
export function writeRecordDraft<T>(
	mountRoot: string,
	filePath: string,
	options: RecordWriteOptions,
	write: () => T,
): T {
	assertNoActiveConflict(mountRoot);
	return withDraftWriteLock(mountRoot, () => {
		// Re-checked under the gate: a publish can record a conflict and
		// release the lock between the check above and this write.
		assertNoActiveConflict(mountRoot);
		if (options.baseRevision !== undefined) {
			const current = recordRevision(filePath);
			if (current !== options.baseRevision) {
				throw new RecordChangedError(
					current === null
						? `${path.basename(filePath)} no longer exists; it was deleted or reverted since it was read.`
						: options.baseRevision === null
							? `${path.basename(filePath)} already exists; it was created by someone else in the meantime.`
							: `${path.basename(filePath)} was saved by someone else since it was read.`,
					current,
				);
			}
		}
		return write();
	});
}

export function documentFileName(id: string): string {
	if (!id || id !== id.trim()) {
		throw new RepositoryDbError("invalid_id", `invalid document id: "${id}"`);
	}
	return `${encodeURIComponent(id)}.yaml`;
}

export class Collection<T> {
	readonly name: string;
	private readonly mountRoot: string;
	private readonly directory: string;
	private readonly options: CollectionOptions<T>;

	constructor(
		mountRoot: string,
		config: RepositoryDbConfig,
		name: string,
		options: CollectionOptions<T>,
	) {
		this.name = name;
		this.mountRoot = mountRoot;
		this.directory = path.join(
			mountRoot,
			config.layout.data,
			options.directory ?? name,
		);
		this.options = options;
	}

	get directoryPath(): string {
		return this.directory;
	}

	listIds(): string[] {
		if (!existsSync(this.directory)) return [];
		return readdirSync(this.directory)
			.filter((file) => file.endsWith(".yaml"))
			.map((file) => decodeURIComponent(file.slice(0, -".yaml".length)))
			.sort((a, b) => a.localeCompare(b, "en"));
	}

	has(id: string): boolean {
		return existsSync(path.join(this.directory, documentFileName(id)));
	}

	get(id: string): CollectionDocument<T> | undefined {
		const filePath = path.join(this.directory, documentFileName(id));
		if (!existsSync(filePath)) return undefined;
		return this.parseEnvelope(readYamlFile(filePath), id);
	}

	getOrThrow(id: string): CollectionDocument<T> {
		const document = this.get(id);
		if (!document) {
			throw new RepositoryDbError(
				"not_found",
				`document ${id} not found in collection ${this.name}`,
			);
		}
		return document;
	}

	/** Read every document. Collections are lazy by default — prefer get(). */
	list(): CollectionDocument<T>[] {
		return this.listIds().map((id) => this.getOrThrow(id));
	}

	/** Revision of one document as stored, `null` when it does not exist. */
	revision(id: string): string | null {
		return recordRevision(path.join(this.directory, documentFileName(id)));
	}

	/**
	 * Write a document as a local draft (working-tree change, no commit).
	 * Refused while a conflict state is active, and — with a base revision —
	 * when the stored document is no longer that version. Returns the new
	 * revision.
	 */
	put(
		id: string,
		record: T,
		extraEnvelope: Record<string, unknown> = {},
		options: RecordWriteOptions = {},
	): string {
		const parsed = this.options.parser ? this.options.parser.parse(record) : record;
		const envelope: CollectionDocument<T> = {
			...extraEnvelope,
			schemaVersion: this.options.schemaVersion,
			id,
			record: parsed,
		};
		const filePath = path.join(this.directory, documentFileName(id));
		return writeRecordDraft(this.mountRoot, filePath, options, () => {
			writeYamlFileAtomic(filePath, envelope);
			return recordRevision(filePath) as string;
		});
	}

	/** Delete a document as a local draft change, under the same rules as put. */
	remove(id: string, options: RecordWriteOptions = {}): boolean {
		const filePath = path.join(this.directory, documentFileName(id));
		return writeRecordDraft(this.mountRoot, filePath, options, () => {
			if (!existsSync(filePath)) return false;
			rmSync(filePath);
			return true;
		});
	}

	private parseEnvelope(raw: unknown, id: string): CollectionDocument<T> {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			throw new RepositoryDbError(
				"invalid_document",
				`document ${id} in ${this.name} is not a mapping`,
			);
		}
		const envelope = raw as Record<string, unknown>;
		if (envelope.schemaVersion !== this.options.schemaVersion) {
			throw new RepositoryDbError(
				"schema_mismatch",
				`document ${id} in ${this.name} has schemaVersion "${String(envelope.schemaVersion)}", expected "${this.options.schemaVersion}"`,
			);
		}
		if (envelope.id !== id) {
			throw new RepositoryDbError(
				"id_mismatch",
				`document file for ${id} declares id "${String(envelope.id)}"`,
			);
		}
		const record = this.options.parser
			? this.options.parser.parse(envelope.record)
			: (envelope.record as T);
		return { ...envelope, schemaVersion: this.options.schemaVersion, id, record };
	}
}
