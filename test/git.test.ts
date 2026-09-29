import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { changedLines, deleteSnapshotRef, parseUnifiedDiff, snapshotRef, snapshotTree } from "../src/git.js";

const sorted = (m: Map<number, string> | undefined) => [...(m?.keys() ?? [])].sort((a, b) => a - b);

test("parseUnifiedDiff: added, deleted and replaced lines", () => {
	const diff = [
		"diff --git a/src/styles.css b/src/styles.css",
		"index 1111111..2222222 100644",
		"--- a/src/styles.css",
		"+++ b/src/styles.css",
		"@@ -3 +3 @@ .card {",
		"-  padding: 16px;",
		"+  padding: 24px;",
		"@@ -10,0 +11,2 @@",
		"+  color: red;",
		"+  margin: 0;",
		"@@ -20,2 +22,0 @@",
		"-  gap: 4px;",
		"-  border: 0;",
		"",
	].join("\n");
	const f = parseUnifiedDiff(diff).get("src/styles.css");
	assert.ok(f);
	assert.equal(f.oldPath, "src/styles.css");
	assert.deepEqual(sorted(f.added), [3, 11, 12]);
	assert.deepEqual(sorted(f.deleted), [3, 20, 21]);
	assert.equal(f.added.get(3), "  padding: 24px;");
	assert.equal(f.deleted.get(3), "  padding: 16px;");
});

test("parseUnifiedDiff: content that looks like headers stays content", () => {
	const diff = [
		"diff --git a/notes.md b/notes.md",
		"--- a/notes.md",
		"+++ b/notes.md",
		"@@ -1,2 +1,2 @@",
		"--- old rule",
		"-++ weird",
		"+++ new rule",
		"+-- also weird",
		"",
	].join("\n");
	const f = parseUnifiedDiff(diff).get("notes.md");
	assert.deepEqual(sorted(f?.deleted), [1, 2]);
	assert.deepEqual(sorted(f?.added), [1, 2]);
	assert.equal(f?.deleted.get(1), "-- old rule");
	assert.equal(f?.added.get(1), "++ new rule");
	assert.equal(parseUnifiedDiff(diff).size, 1);
});

test("parseUnifiedDiff: renames, new files, deleted files and missing newlines", () => {
	const diff = [
		"diff --git a/src/old.css b/src/new.css",
		"similarity index 90%",
		"rename from src/old.css",
		"rename to src/new.css",
		"index 1111111..2222222 100644",
		"--- a/src/old.css",
		"+++ b/src/new.css",
		"@@ -2 +2 @@",
		"-a { color: red }",
		"\\ No newline at end of file",
		"+a { color: blue }",
		"\\ No newline at end of file",
		"diff --git a/src/pure.css b/src/moved.css",
		"similarity index 100%",
		"rename from src/pure.css",
		"rename to src/moved.css",
		"diff --git a/src/added.css b/src/added.css",
		"new file mode 100644",
		"index 0000000..3333333",
		"--- /dev/null",
		"+++ b/src/added.css",
		"@@ -0,0 +1,2 @@",
		"+.x {}",
		"+.y {}",
		"diff --git a/src/gone.css b/src/gone.css",
		"deleted file mode 100644",
		"index 4444444..0000000",
		"--- a/src/gone.css",
		"+++ /dev/null",
		"@@ -1,2 +0,0 @@",
		"-.z {}",
		"-.w {}",
		"",
	].join("\n");
	const files = parseUnifiedDiff(diff);

	const renamed = files.get("src/new.css");
	assert.equal(renamed?.oldPath, "src/old.css");
	assert.deepEqual(sorted(renamed?.added), [2]);
	assert.deepEqual(sorted(renamed?.deleted), [2]);

	const moved = files.get("src/moved.css");
	assert.equal(moved?.oldPath, "src/pure.css");
	assert.equal(moved?.added.size, 0);

	assert.deepEqual(sorted(files.get("src/added.css")?.added), [1, 2]);

	const gone = files.get("src/gone.css");
	assert.equal(gone?.oldPath, "src/gone.css");
	assert.deepEqual(sorted(gone?.deleted), [1, 2]);
	assert.equal(gone?.added.size, 0);
});

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

test("snapshotTree captures a dirty tree, untracked files included, without touching the index", () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tunnelvision-git-")));
	try {
		git(dir, "init", "-q");
		git(dir, "config", "user.email", "test@example.com");
		git(dir, "config", "user.name", "test");
		fs.writeFileSync(path.join(dir, "styles.css"), ".a {\n  color: red;\n}\n");
		fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.css\n");
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "init");
		const head = git(dir, "rev-parse", "HEAD");

		// Clean: just HEAD, no ref.
		assert.equal(snapshotTree(dir, "clean"), head);
		assert.throws(() => git(dir, "rev-parse", "--verify", "--quiet", snapshotRef("clean")));

		fs.writeFileSync(path.join(dir, "styles.css"), ".a {\n  color: blue;\n}\n");
		fs.writeFileSync(path.join(dir, "new.css"), ".b {}\n");
		fs.writeFileSync(path.join(dir, "ignored.css"), ".c {}\n");
		const statusBefore = git(dir, "status", "--porcelain");

		const rev = snapshotTree(dir, "abc1234-dirty");
		assert.ok(rev && rev !== head);
		assert.equal(git(dir, "rev-parse", snapshotRef("abc1234-dirty")), rev);
		assert.equal(git(dir, "rev-parse", `${rev}^`), head);
		assert.equal(git(dir, "status", "--porcelain"), statusBefore);

		const changes = changedLines(dir, head, rev);
		assert.ok(changes);
		assert.deepEqual(sorted(changes.get("styles.css")?.added), [2]);
		assert.deepEqual(sorted(changes.get("styles.css")?.deleted), [2]);
		assert.deepEqual(sorted(changes.get("new.css")?.added), [1]);
		assert.equal(changes.has("ignored.css"), false);

		deleteSnapshotRef(dir, "abc1234-dirty");
		assert.throws(() => git(dir, "rev-parse", "--verify", "--quiet", snapshotRef("abc1234-dirty")));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
