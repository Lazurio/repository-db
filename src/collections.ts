import {
	existsSync,
	readdirSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { assertNoActiveConflict } from "./conflict.ts";
import { withDraftWriteLock } from "./lock.ts";
import { readYamlFile, writeYamlFileAtomic } from "./yamlIo.ts";
import {
	type DocumentParser,
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

	/**
	 * Write a document as a local draft (working-tree change, no commit).
	 * Refused while a conflict state is active.
	 */
	put(id: string, record: T, extraEnvelope: Record<string, unknown> = {}): void {
		assertNoActiveConflict(this.mountRoot);
		const parsed = this.options.parser ? this.options.parser.parse(record) : record;
		const envelope: CollectionDocument<T> = {
			...extraEnvelope,
			schemaVersion: this.options.schemaVersion,
			id,
			record: parsed,
		};
		// Through the shared gate: a write must not land inside a publish or a
		// discard, or the user would confirm one draft and get another.
		withDraftWriteLock(this.mountRoot, () => {
			// Re-checked under the gate: a publish can record a conflict and
			// release the lock between the check above and this write.
			assertNoActiveConflict(this.mountRoot);
			writeYamlFileAtomic(path.join(this.directory, documentFileName(id)), envelope);
		});
	}

	/** Delete a document as a local draft change. */
	remove(id: string): boolean {
		assertNoActiveConflict(this.mountRoot);
		const filePath = path.join(this.directory, documentFileName(id));
		return withDraftWriteLock(this.mountRoot, () => {
			assertNoActiveConflict(this.mountRoot);
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
