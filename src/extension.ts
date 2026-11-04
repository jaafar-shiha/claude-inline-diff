import * as fs from 'fs';
import * as vscode from 'vscode';
import { acceptHunk, computeDiff, rejectHunk, type FileDiff, type Hunk } from './hunks';
import { copyHookScript, isProjectSetUp, readBase, readEntries, recordOutcome, removeEntry, setUpProject, writeBase, type Entry } from './store';

const BASE_SCHEME = 'claude-inline-diff-base';
const DONT_ASK_KEY = 'claudeInlineDiff.dontAskSetup';

interface Review {
	entry: Entry;
	base: string;
	current: string;
	diff: FileDiff;
}

const addedDecoration = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	backgroundColor: 'rgba(46, 160, 67, 0.22)',
	overviewRulerColor: 'rgba(46, 160, 67, 0.8)',
	overviewRulerLane: vscode.OverviewRulerLane.Left,
});

// Marks where lines were removed: a red bar above the line (or below the last line).
const removedAboveDecoration = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	borderColor: 'rgba(248, 81, 73, 0.9)',
	borderStyle: 'solid',
	borderWidth: '2px 0 0 0',
	overviewRulerColor: 'rgba(248, 81, 73, 0.9)',
	overviewRulerLane: vscode.OverviewRulerLane.Left,
});
const removedBelowDecoration = vscode.window.createTextEditorDecorationType({
	isWholeLine: true,
	borderColor: 'rgba(248, 81, 73, 0.9)',
	borderStyle: 'solid',
	borderWidth: '0 0 2px 0',
	overviewRulerColor: 'rgba(248, 81, 73, 0.9)',
	overviewRulerLane: vscode.OverviewRulerLane.Left,
});
// The first removed line, shown as red struck-through text after the changed line.
const removedHintDecoration = vscode.window.createTextEditorDecorationType({});

function removedHover(hunk: Hunk, languageId: string): vscode.MarkdownString {
	let fence = '```';
	while (hunk.removedText.includes(fence)) {
		fence += '`';
	}
	const md = new vscode.MarkdownString();
	md.appendMarkdown(`**Removed by Claude** (${hunk.removedLines} line${hunk.removedLines === 1 ? '' : 's'})\n\n`);
	md.appendMarkdown(`${fence}${languageId}\n${hunk.removedText.replace(/\n$/, '')}\n${fence}`);
	return md;
}

function hunkLine(doc: vscode.TextDocument, hunk: Hunk): number {
	return Math.min(hunk.startLine, Math.max(doc.lineCount - 1, 0));
}

// A tab showing one of our "before Claude ↔ now" diffs; its modified side is the real file.
function reviewDiffTab(tab: vscode.Tab): vscode.TabInputTextDiff | undefined {
	const input = tab.input;
	return input instanceof vscode.TabInputTextDiff && input.original.scheme === BASE_SCHEME && input.modified.scheme === 'file'
		? input : undefined;
}

function plural(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

class Controller implements vscode.CodeLensProvider, vscode.TreeDataProvider<Entry>, vscode.TextDocumentContentProvider {
	private entries = new Map<string, Entry>();
	private seen = new Set<string>();
	private loadedOnce = false;
	private closingDiffs = false;
	private manifestWatchers: vscode.Disposable[] = [];
	private fileWatchers = new Map<string, vscode.Disposable>();
	private refreshTimer: NodeJS.Timeout | undefined;
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	private readonly codeLensEmitter = new vscode.EventEmitter<void>();
	private readonly treeEmitter = new vscode.EventEmitter<void>();
	private readonly baseEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChangeCodeLenses = this.codeLensEmitter.event;
	readonly onDidChangeTreeData = this.treeEmitter.event;
	readonly onDidChange = this.baseEmitter.event;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.statusBar.command = 'claudeInlineDiff.openNextFile';
		this.statusBar.tooltip = 'Open the next file Claude changed';
	}

	dispose(): void {
		clearTimeout(this.refreshTimer);
		this.manifestWatchers.forEach(w => w.dispose());
		this.fileWatchers.forEach(w => w.dispose());
		this.statusBar.dispose();
	}

	get bundledScript(): string {
		return vscode.Uri.joinPath(this.context.extensionUri, 'hooks', 'snapshot.js').fsPath;
	}

	roots(): string[] {
		return (vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
	}

	tracks(absPath: string): boolean {
		return this.entries.has(absPath);
	}

	private watch(pattern: vscode.GlobPattern): vscode.Disposable {
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		watcher.onDidCreate(() => this.scheduleRefresh());
		watcher.onDidChange(() => this.scheduleRefresh());
		watcher.onDidDelete(() => this.scheduleRefresh());
		return watcher;
	}

	watchRoots(): void {
		this.manifestWatchers.forEach(w => w.dispose());
		this.manifestWatchers = this.roots().map(root => this.watch(new vscode.RelativePattern(root, '.claude/inline-diff/manifest.json')));
	}

	// Files that aren't open in an editor change on disk without document events, so watch each one.
	private syncFileWatchers(): void {
		for (const [absPath, watcher] of this.fileWatchers) {
			if (!this.entries.has(absPath)) {
				watcher.dispose();
				this.fileWatchers.delete(absPath);
			}
		}
		for (const absPath of this.entries.keys()) {
			if (!this.fileWatchers.has(absPath)) {
				this.fileWatchers.set(absPath, this.watch(absPath));
			}
		}
	}

	scheduleRefresh(): void {
		clearTimeout(this.refreshTimer);
		this.refreshTimer = setTimeout(() => this.refresh(), 100);
	}

	refresh(): void {
		this.entries = new Map(this.roots().flatMap(readEntries).map(e => [e.absPath, e]));
		this.syncFileWatchers();

		const newFiles = [...this.entries.keys()].filter(p => !this.seen.has(p));
		if (!this.loadedOnce) {
			// Don't pop open files left over from an earlier VS Code session.
			newFiles.forEach(p => this.seen.add(p));
			this.loadedOnce = true;
		} else {
			this.autoOpen(newFiles);
		}
		for (const p of this.seen) {
			if (!this.entries.has(p)) {
				this.seen.delete(p);
			}
		}

		this.closeFinishedDiffs();
		vscode.window.visibleTextEditors.forEach(e => this.decorate(e));
		this.codeLensEmitter.fire();
		this.treeEmitter.fire();
		for (const absPath of this.entries.keys()) {
			this.baseEmitter.fire(this.baseUri(absPath));
		}
		this.updateStatus();
	}

	private async autoOpen(files: string[]): Promise<void> {
		const autoOpen = vscode.workspace.getConfiguration('claudeInlineDiff').get<boolean>('autoOpenFiles', true);
		for (const absPath of files) {
			// A new file doesn't exist until Claude's Write runs; it's retried on the next refresh.
			if (!fs.existsSync(absPath)) {
				continue;
			}
			this.seen.add(absPath);
			if (autoOpen) {
				try {
					await this.openReview(absPath, { preview: false, preserveFocus: true });
				} catch {
					// Binary or unreadable file: it stays in the Claude Changes list.
				}
			}
		}
	}

	private updateStatus(): void {
		const files = [...this.entries.keys()].filter(p => (this.review(p)?.diff.hunks.length ?? 0) > 0);
		if (files.length === 0) {
			this.statusBar.hide();
		} else {
			this.statusBar.text = `$(diff) Claude: ${plural(files.length, 'file')} to review`;
			this.statusBar.show();
		}
		const active = vscode.window.activeTextEditor?.document.uri.fsPath;
		const activeHasChanges = !!active && (this.review(active)?.diff.hunks.length ?? 0) > 0;
		vscode.commands.executeCommand('setContext', 'claudeInlineDiff.activeHasChanges', activeHasChanges);
	}

	private currentText(absPath: string): string {
		const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === absPath);
		if (doc) {
			return doc.getText();
		}
		try {
			return fs.readFileSync(absPath, 'utf8');
		} catch {
			return '';
		}
	}

	review(absPath: string): Review | undefined {
		const entry = this.entries.get(absPath);
		if (!entry) {
			return undefined;
		}
		const base = readBase(entry);
		if (base === undefined) {
			return undefined;
		}
		const current = this.currentText(absPath);
		return { entry, base, current, diff: computeDiff(base, current) };
	}

	// Whether the editor is the file side of our diff view, which draws removed and added lines itself.
	private inReviewDiff(editor: vscode.TextEditor): boolean {
		const group = vscode.window.tabGroups.all.find(g => g.viewColumn === editor.viewColumn);
		const diff = group?.activeTab && reviewDiffTab(group.activeTab);
		return !!diff && diff.modified.fsPath === editor.document.uri.fsPath;
	}

	decorate(editor: vscode.TextEditor): void {
		const doc = editor.document;
		const review = doc.uri.scheme === 'file' && !this.inReviewDiff(editor) ? this.review(doc.uri.fsPath) : undefined;
		const added: vscode.DecorationOptions[] = [];
		const above: vscode.DecorationOptions[] = [];
		const below: vscode.DecorationOptions[] = [];
		const hints: vscode.DecorationOptions[] = [];

		for (const hunk of review?.diff.hunks ?? []) {
			const hover = hunk.removedLines > 0 ? removedHover(hunk, doc.languageId) : undefined;
			for (let i = 0; i < hunk.addedLines; i++) {
				const line = hunk.startLine + i;
				if (line < doc.lineCount) {
					added.push({ range: doc.lineAt(line).range, hoverMessage: i === 0 ? hover : undefined });
				}
			}
			if (hunk.removedLines === 0) {
				continue;
			}
			const range = doc.lineAt(hunkLine(doc, hunk)).range;
			if (hunk.addedLines === 0) {
				(hunk.startLine >= doc.lineCount ? below : above).push({ range, hoverMessage: hover });
			}
			const firstRemoved = hunk.removedText.split('\n').find(l => l.trim())?.trim() ?? '';
			const more = hunk.removedLines > 1 ? `   (−${hunk.removedLines} lines, hover to see)` : '';
			hints.push({
				range: new vscode.Range(range.end, range.end),
				hoverMessage: hover,
				renderOptions: {
					after: {
						contentText: `      ${firstRemoved}`.slice(0, 120) + more,
						color: 'rgba(248, 81, 73, 0.85)',
						textDecoration: 'line-through',
						fontStyle: 'italic',
					},
				},
			});
		}

		editor.setDecorations(addedDecoration, added);
		editor.setDecorations(removedAboveDecoration, above);
		editor.setDecorations(removedBelowDecoration, below);
		editor.setDecorations(removedHintDecoration, hints);
	}

	// CodeLens: file-wide actions on the first line, and Accept/Reject buttons right above each change.
	provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
		const review = doc.uri.scheme === 'file' ? this.review(doc.uri.fsPath) : undefined;
		if (!review || review.diff.hunks.length === 0) {
			return [];
		}
		const uri = doc.uri.toString();
		const top = new vscode.Range(0, 0, 0, 0);
		const lenses = [
			new vscode.CodeLens(top, { title: `$(sparkle) Claude: ${plural(review.diff.hunks.length, 'change')}`, command: '' }),
			new vscode.CodeLens(top, { title: '$(check-all) Accept All ⌥⌘↩', command: 'claudeInlineDiff.acceptFile', arguments: [uri] }),
			new vscode.CodeLens(top, { title: '$(discard) Reject All ⌥⌘⌫', command: 'claudeInlineDiff.rejectFile', arguments: [uri] }),
			new vscode.CodeLens(top, { title: '$(diff) Diff View', command: 'claudeInlineDiff.compareFile', arguments: [uri] }),
		];
		for (const hunk of review.diff.hunks) {
			const range = new vscode.Range(hunkLine(doc, hunk), 0, hunkLine(doc, hunk), 0);
			const stats = [hunk.addedLines && `+${hunk.addedLines}`, hunk.removedLines && `−${hunk.removedLines}`].filter(Boolean).join(' ');
			lenses.push(
				new vscode.CodeLens(range, { title: '$(check) Accept ⌥⌘Y', tooltip: 'Keep this change', command: 'claudeInlineDiff.acceptHunk', arguments: [uri, hunk.startLine] }),
				new vscode.CodeLens(range, { title: '$(close) Reject ⌥⌘N', tooltip: 'Undo this change', command: 'claudeInlineDiff.rejectHunk', arguments: [uri, hunk.startLine] }),
				new vscode.CodeLens(range, { title: stats, command: '' }),
			);
		}
		return lenses;
	}

	// Tree view: the files waiting for review.
	getTreeItem(entry: Entry): vscode.TreeItem {
		const uri = vscode.Uri.file(entry.absPath);
		const item = new vscode.TreeItem(uri);
		item.label = entry.key;
		item.contextValue = 'claudeChangedFile';
		item.command = { title: 'Open', command: 'claudeInlineDiff.openFile', arguments: [uri.toString()] };
		const hunks = this.review(entry.absPath)?.diff.hunks ?? [];
		const added = hunks.reduce((n, h) => n + h.addedLines, 0);
		const removed = hunks.reduce((n, h) => n + h.removedLines, 0);
		item.description = entry.existed ? `+${added} −${removed}` : `new · +${added}`;
		return item;
	}

	getChildren(entry?: Entry): Entry[] {
		if (entry) {
			return [];
		}
		return [...this.entries.values()].sort((a, b) => a.key.localeCompare(b.key));
	}

	// Serves the "before Claude" text for the side-by-side Compare view.
	baseUri(absPath: string): vscode.Uri {
		return vscode.Uri.file(absPath).with({ scheme: BASE_SCHEME });
	}

	provideTextDocumentContent(uri: vscode.Uri): string {
		const entry = this.entries.get(uri.fsPath);
		// Once the review is over the diff is about to close; showing the file keeps it from flashing all green.
		return (entry ? readBase(entry) : undefined) ?? this.currentText(uri.fsPath);
	}

	// ---- actions ----

	// Commands get a URI string (CodeLens), a Uri, a tree Entry, or nothing (keybindings: active editor).
	private target(arg: unknown): string | undefined {
		if (typeof arg === 'string') {
			return vscode.Uri.parse(arg).fsPath;
		}
		if (arg instanceof vscode.Uri) {
			return arg.fsPath;
		}
		if (arg && typeof arg === 'object' && 'absPath' in arg) {
			return (arg as Entry).absPath;
		}
		return vscode.window.activeTextEditor?.document.uri.fsPath;
	}

	private async writeCurrent(absPath: string, text: string): Promise<void> {
		const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === absPath);
		if (!doc) {
			fs.writeFileSync(absPath, text);
			return;
		}
		const edit = new vscode.WorkspaceEdit();
		edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
		await vscode.workspace.applyEdit(edit);
		await doc.save();
	}

	private async deleteFile(absPath: string): Promise<void> {
		const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && d.uri.fsPath === absPath);
		if (doc?.isDirty) {
			await doc.save();
		}
		const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs)
			.filter(t => (t.input instanceof vscode.TabInputText && t.input.uri.fsPath === absPath) || reviewDiffTab(t)?.modified.fsPath === absPath);
		await vscode.window.tabGroups.close(tabs);
		if (fs.existsSync(absPath)) {
			await vscode.workspace.fs.delete(vscode.Uri.file(absPath), { useTrash: true });
		}
	}

	private findHunk(review: Review, startLine: unknown): Hunk | undefined {
		const hunks = review.diff.hunks;
		if (typeof startLine === 'number') {
			return hunks.find(h => h.startLine === startLine);
		}
		// From a keybinding: the change under the cursor, else the next one below it.
		const cursor = vscode.window.activeTextEditor?.selection.active.line ?? 0;
		return hunks.find(h => cursor >= h.startLine && cursor < h.startLine + Math.max(h.addedLines, 1))
			?? hunks.find(h => h.startLine >= cursor)
			?? hunks[hunks.length - 1];
	}

	async acceptHunk(uriArg?: unknown, startLine?: unknown): Promise<void> {
		const absPath = this.target(uriArg);
		const review = absPath ? this.review(absPath) : undefined;
		const hunk = review && this.findHunk(review, startLine);
		if (!review || !hunk) {
			return;
		}
		const base = acceptHunk(review.diff, hunk.index);
		recordOutcome(review.entry, 1, 0);
		if (base === review.current) {
			removeEntry(review.entry);
		} else {
			writeBase(review.entry, base);
		}
		this.refresh();
	}

	async rejectHunk(uriArg?: unknown, startLine?: unknown): Promise<void> {
		const absPath = this.target(uriArg);
		const review = absPath ? this.review(absPath) : undefined;
		const hunk = review && this.findHunk(review, startLine);
		if (!review || !hunk) {
			return;
		}
		const current = rejectHunk(review.diff, hunk.index);
		recordOutcome(review.entry, 0, 1);
		if (current === review.base && !review.entry.existed) {
			await this.deleteFile(review.entry.absPath);
		} else {
			await this.writeCurrent(review.entry.absPath, current);
		}
		if (current === review.base) {
			removeEntry(review.entry);
		}
		this.refresh();
	}

	async acceptFile(uriArg?: unknown): Promise<void> {
		const entry = this.entries.get(this.target(uriArg) ?? '');
		if (entry) {
			this.finishAccepted(entry);
			this.refresh();
		}
	}

	private pendingHunks(entry: Entry): number {
		return this.review(entry.absPath)?.diff.hunks.length ?? 0;
	}

	private finishAccepted(entry: Entry): void {
		recordOutcome(entry, this.pendingHunks(entry), 0);
		removeEntry(entry);
	}

	async rejectFile(uriArg?: unknown, confirm = true): Promise<void> {
		const entry = this.entries.get(this.target(uriArg) ?? '');
		if (!entry) {
			return;
		}
		if (confirm) {
			const question = entry.existed ? `Undo all of Claude's changes to ${entry.key}?` : `Delete ${entry.key}, which Claude created?`;
			if (await vscode.window.showWarningMessage(question, { modal: true }, 'Reject') !== 'Reject') {
				return;
			}
		}
		const base = readBase(entry);
		if (base === undefined) {
			vscode.window.showWarningMessage(`The copy of ${entry.key} from before Claude's edit is missing, so it can't be restored.`);
			return;
		}
		recordOutcome(entry, 0, this.pendingHunks(entry));
		if (entry.existed) {
			await this.writeCurrent(entry.absPath, base);
		} else {
			await this.deleteFile(entry.absPath);
		}
		removeEntry(entry);
		this.refresh();
	}

	async acceptAll(): Promise<void> {
		[...this.entries.values()].forEach(e => this.finishAccepted(e));
		this.refresh();
	}

	async rejectAll(): Promise<void> {
		const count = this.entries.size;
		if (count === 0) {
			return;
		}
		const answer = await vscode.window.showWarningMessage(
			`Undo all of Claude's changes in ${plural(count, 'file')}?`, { modal: true }, 'Reject All');
		if (answer !== 'Reject All') {
			return;
		}
		for (const entry of [...this.entries.values()]) {
			await this.rejectFile(entry.absPath, false);
		}
	}

	async compareFile(uriArg?: unknown): Promise<void> {
		const absPath = this.target(uriArg);
		if (absPath && this.entries.has(absPath)) {
			await this.openDiff(absPath, { preview: false });
		}
	}

	private async openDiff(absPath: string, options: vscode.TextDocumentShowOptions): Promise<void> {
		const entry = this.entries.get(absPath)!;
		await vscode.commands.executeCommand('vscode.diff', this.baseUri(absPath), vscode.Uri.file(absPath),
			`${entry.key} (Claude's changes)`, options);
	}

	// Opens a changed file the way the claudeInlineDiff.openIn setting says.
	private async openReview(absPath: string, options: vscode.TextDocumentShowOptions): Promise<vscode.TextEditor | undefined> {
		const openIn = vscode.workspace.getConfiguration('claudeInlineDiff').get<string>('openIn', 'diff');
		if (openIn === 'diff' && (this.review(absPath)?.diff.hunks.length ?? 0) > 0) {
			await this.openDiff(absPath, options);
			return vscode.window.activeTextEditor?.document.uri.fsPath === absPath ? vscode.window.activeTextEditor : undefined;
		}
		return vscode.window.showTextDocument(vscode.Uri.file(absPath), options);
	}

	// When a file has nothing left to review, its diff view gives way to the normal editor.
	private async closeFinishedDiffs(): Promise<void> {
		if (this.closingDiffs) {
			return;
		}
		this.closingDiffs = true;
		try {
			await this.closeFinishedDiffTabs();
		} catch {
			// A tab closed meanwhile; the next refresh catches up.
		} finally {
			this.closingDiffs = false;
		}
	}

	private async closeFinishedDiffTabs(): Promise<void> {
		for (const group of vscode.window.tabGroups.all) {
			for (const tab of group.tabs) {
				const diff = reviewDiffTab(tab);
				if (!diff || (this.review(diff.modified.fsPath)?.diff.hunks.length ?? 0) > 0) {
					continue;
				}
				if (fs.existsSync(diff.modified.fsPath)) {
					await vscode.window.showTextDocument(diff.modified, {
						viewColumn: group.viewColumn, preview: false, preserveFocus: !(group.isActive && tab.isActive),
					});
				}
				await vscode.window.tabGroups.close(tab);
			}
		}
	}

	async openFile(uriArg?: unknown): Promise<void> {
		const absPath = this.target(uriArg);
		if (!absPath || !fs.existsSync(absPath)) {
			return;
		}
		const editor = await this.openReview(absPath, { preview: false });
		const first = this.review(absPath)?.diff.hunks[0];
		if (editor && first) {
			const pos = new vscode.Position(hunkLine(editor.document, first), 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}
	}

	async openNextFile(): Promise<void> {
		const files = this.getChildren().map(e => e.absPath).filter(p => (this.review(p)?.diff.hunks.length ?? 0) > 0);
		if (files.length === 0) {
			vscode.window.showInformationMessage('No Claude changes left to review.');
			return;
		}
		const active = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
		await this.openFile(vscode.Uri.file(files[(files.indexOf(active) + 1) % files.length]));
	}

	private install(root: string, quiet = false): void {
		try {
			setUpProject(root, this.bundledScript);
			if (!quiet) {
				vscode.window.showInformationMessage(
					'Claude Inline Diff is set up. Edits from any new Claude Code session (VS Code, terminal or desktop app) will show here.');
			}
		} catch (err) {
			vscode.window.showErrorMessage(`Claude Inline Diff setup failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	async setUpHook(): Promise<void> {
		const roots = this.roots();
		if (roots.length === 0) {
			vscode.window.showWarningMessage('Open a project folder first.');
			return;
		}
		const root = roots.length === 1 ? roots[0] : await vscode.window.showQuickPick(roots, { placeHolder: 'Set up Claude Inline Diff for which folder?' });
		if (root) {
			this.install(root);
		}
	}

	async offerSetUp(): Promise<void> {
		copyHookScript(this.bundledScript);
		for (const root of this.roots()) {
			if (isProjectSetUp(root)) {
				// Makes sure the user-wide hook exists and moves older per-project setups to it.
				this.install(root, true);
				this.refresh();
				continue;
			}
			const dontAsk: string[] = this.context.globalState.get(DONT_ASK_KEY, []);
			if (dontAsk.includes(root)) {
				continue;
			}
			const name = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root))?.name ?? root;
			const answer = await vscode.window.showInformationMessage(
				`Show Claude's edits in "${name}" as inline diffs with Accept/Reject?`, 'Set Up', 'Not Now', "Don't Ask Again");
			if (answer === 'Set Up') {
				this.install(root);
			} else if (answer === "Don't Ask Again") {
				await this.context.globalState.update(DONT_ASK_KEY, [...dontAsk, root]);
			}
		}
	}
}

export function activate(context: vscode.ExtensionContext) {
	const controller = new Controller(context);
	const command = (id: string, fn: (...args: any[]) => unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(`claudeInlineDiff.${id}`, fn));

	command('acceptHunk', (uri, line) => controller.acceptHunk(uri, line));
	command('rejectHunk', (uri, line) => controller.rejectHunk(uri, line));
	command('acceptHunkAtCursor', () => controller.acceptHunk());
	command('rejectHunkAtCursor', () => controller.rejectHunk());
	command('acceptFile', uri => controller.acceptFile(uri));
	command('rejectFile', uri => controller.rejectFile(uri));
	command('acceptAll', () => controller.acceptAll());
	command('rejectAll', () => controller.rejectAll());
	command('compareFile', uri => controller.compareFile(uri));
	command('openFile', uri => controller.openFile(uri));
	command('openNextFile', () => controller.openNextFile());
	command('setUpHook', () => controller.setUpHook());
	command('refresh', () => controller.refresh());

	context.subscriptions.push(
		controller,
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, controller),
		vscode.window.registerTreeDataProvider('claudeInlineDiff.changes', controller),
		vscode.workspace.registerTextDocumentContentProvider(BASE_SCHEME, controller),
		vscode.workspace.onDidChangeTextDocument(e => {
			if (e.document.uri.scheme === 'file' && controller.tracks(e.document.uri.fsPath)) {
				controller.scheduleRefresh();
			}
		}),
		vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(e => controller.decorate(e))),
		vscode.window.tabGroups.onDidChangeTabs(() => vscode.window.visibleTextEditors.forEach(e => controller.decorate(e))),
		vscode.window.onDidChangeActiveTextEditor(() => controller.scheduleRefresh()),
		vscode.workspace.onDidChangeWorkspaceFolders(() => {
			controller.watchRoots();
			controller.refresh();
			controller.offerSetUp();
		}),
	);

	controller.watchRoots();
	controller.refresh();
	controller.offerSetUp();
}

export function deactivate() {}
