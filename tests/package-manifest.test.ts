import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const packageJsonUrl = new URL("../package.json", import.meta.url);
const packageRootUrl = new URL("../", import.meta.url);

describe("package manifest", () => {
	it("declares a single Pi extension entry point", () => {
		const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
			name?: string;
			type?: string;
			keywords?: string[];
			pi?: { extensions?: string[] };
			files?: string[];
		};

		assert.equal(packageJson.name, "afk");
		assert.equal(packageJson.type, "module");
		assert.ok(packageJson.keywords?.includes("pi-package"));
		assert.ok(packageJson.keywords?.includes("pi-extension"));
		assert.deepEqual(packageJson.pi?.extensions, ["./extensions/index.ts"]);
		assert.deepEqual(packageJson.files, ["extensions", "README.md", "CHANGELOG.md", "LICENSE"]);
		assert.equal(existsSync(new URL("extensions/index.ts", packageRootUrl)), true);
	});

	it("uses current @earendil-works Pi package names as peers", () => {
		const packageJsonText = readFileSync(packageJsonUrl, "utf8");
		const packageJson = JSON.parse(packageJsonText) as {
			peerDependencies?: Record<string, string>;
		};

		assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
		assert.equal(packageJson.peerDependencies?.["typebox"], "*");
		assert.equal(packageJson.peerDependencies?.["@mariozechner/pi-coding-agent"], undefined);
		assert.doesNotMatch(packageJsonText, /@mariozechner\//);
	});

	it("declares Telegram runtime and Pi AI schema dependencies", () => {
		const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			peerDependencies?: Record<string, string>;
		};

		assert.equal(typeof packageJson.dependencies?.grammy, "string");
		assert.equal(packageJson.peerDependencies?.["@earendil-works/pi-ai"], "*");
		assert.equal(typeof packageJson.devDependencies?.["@earendil-works/pi-ai"], "string");
	});
});
