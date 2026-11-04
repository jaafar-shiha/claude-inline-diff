import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A throwaway project set up for review; the integration test plays Claude's edits in it.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-inline-diff-test-'));
fs.mkdirSync(path.join(workspace, '.claude', 'inline-diff'), { recursive: true });
fs.mkdirSync(path.join(workspace, 'lib'));
// Setup writes the hook into ~/.claude/settings.json; keep the tests away from the real one.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-inline-diff-home-'));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: workspace,
	launchArgs: ['--disable-extensions'],
	env: { HOME: home, REAL_HOME: os.homedir() },
	mocha: { ui: 'tdd', timeout: 20000 },
});
