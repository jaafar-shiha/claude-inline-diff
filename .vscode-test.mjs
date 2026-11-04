import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A throwaway project set up for review; the integration test plays Claude's edits in it.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-inline-diff-test-'));
fs.mkdirSync(path.join(workspace, '.claude', 'inline-diff'), { recursive: true });
fs.mkdirSync(path.join(workspace, 'lib'));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: workspace,
	launchArgs: ['--disable-extensions'],
	mocha: { ui: 'tdd', timeout: 20000 },
});
