import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";
import { BoundaryViolationError, RepositoryDbError } from "./types.ts";

/**
 * Record files live inside the data checkout, in real directories. A symbolic
 * link anywhere below the mount root — `data/` itself, a collection
 * directory, a nested group directory, the file — could make a read return a
 * file from outside the checkout or a write create one there, so it is refused.
 * Every engine read and write of record files goes through here, and apps that
 * touch files themselves use the same two functions.
 */

function refuseLink(relativePath: string, component: string): never {
	throw new RepositoryDbError(
		"symlink_refused",
		`${relativePath} is reached through a symbolic link (${component}); record files are read and written only through real directories inside the data checkout. Nothing was read or written.`,
	);
}

/**
 * The absolute path of a file inside the data checkout, after checking that it
 * stays inside the mount and that no existing component below the mount root
 * is a symbolic link (each one is `lstat`ed). Components that do not exist yet
 * are fine: a write creates them as real directories. Throws
 * `boundary_violation` for a path outside the checkout and `symlink_refused`
 * for a link.
 */
export function assertDataPath(mountRoot: string, target: string): string {
	const root = path.resolve(mountRoot);
	const absolute = path.resolve(root, target);
	const relative = path.relative(root, absolute);
	if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new BoundaryViolationError(
			`${target} is outside the data checkout ${root}; record files are read and written only inside it.`,
		);
	}
	let current = root;
	for (const component of relative.split(path.sep)) {
		current = path.join(current, component);
		const stats = lstatSync(current, { throwIfNoEntry: false });
		if (!stats) break;
		if (stats.isSymbolicLink()) refuseLink(relative, path.relative(root, current));
	}
	return absolute;
}

/**
 * Read a file inside the data checkout, or `null` when it does not exist. The
 * same checks as {@link assertDataPath}; the final open also refuses a link
 * (`O_NOFOLLOW`), so a link swapped in after the check is not followed.
 */
export function readDataFile(mountRoot: string, relativePath: string): string | null {
	return readDataBytes(mountRoot, relativePath)?.toString("utf8") ?? null;
}

/** The bytes of a file inside the data checkout, or `null`; see {@link readDataFile}. */
export function readDataBytes(mountRoot: string, relativePath: string): Buffer | null {
	const absolute = assertDataPath(mountRoot, relativePath);
	let fd: number;
	try {
		fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return null;
		if (code === "ELOOP") refuseLink(path.relative(path.resolve(mountRoot), absolute), path.basename(absolute));
		throw error;
	}
	try {
		if (!fstatSync(fd).isFile()) return null;
		return readFileSync(fd);
	} finally {
		closeSync(fd);
	}
}
