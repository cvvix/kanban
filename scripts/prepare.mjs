import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args, cwd = root) {
	execFileSync(command, args, {
		cwd,
		stdio: "inherit",
		env: process.env,
	});
}

function ensureBuildArtifacts() {
	if (existsSync(join(root, "dist", "cli.js"))) {
		return;
	}
	if (!existsSync(join(root, "web-ui", "node_modules"))) {
		run("npm", ["install"], join(root, "web-ui"));
	}
	run("npm", ["run", "build"]);
}

function shouldInstallHusky() {
	return process.env.INIT_CWD === root && existsSync(join(root, ".git"));
}

ensureBuildArtifacts();

if (shouldInstallHusky()) {
	run("npm", ["exec", "--", "husky"]);
}
