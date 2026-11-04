import { diffLines, type ChangeObject } from 'diff';

// Pure diff logic, kept free of the vscode API so it can be tested with plain Node.

export interface Hunk {
	index: number;
	// First line (0-based) in the current text where this change sits.
	startLine: number;
	// Number of lines Claude added (shown green), starting at startLine.
	addedLines: number;
	removedLines: number;
	removedText: string;
	addedText: string;
}

export interface FileDiff {
	parts: ChangeObject<string>[];
	// For each part, the hunk it belongs to, or -1 for unchanged text.
	partHunk: number[];
	hunks: Hunk[];
}

function countLines(text: string): number {
	if (!text) {
		return 0;
	}
	const lines = text.split('\n').length;
	return text.endsWith('\n') ? lines - 1 : lines;
}

export function computeDiff(base: string, current: string): FileDiff {
	const parts = diffLines(base, current);
	const partHunk: number[] = [];
	const hunks: Hunk[] = [];
	let line = 0;
	let open: Hunk | undefined;

	for (const part of parts) {
		const lines = part.count ?? countLines(part.value);
		if (!part.added && !part.removed) {
			open = undefined;
			partHunk.push(-1);
			line += lines;
			continue;
		}
		if (!open) {
			open = { index: hunks.length, startLine: line, addedLines: 0, removedLines: 0, removedText: '', addedText: '' };
			hunks.push(open);
		}
		partHunk.push(open.index);
		if (part.added) {
			open.addedLines += lines;
			open.addedText += part.value;
			line += lines;
		} else {
			open.removedLines += lines;
			open.removedText += part.value;
		}
	}
	return { parts, partHunk, hunks };
}

// Rebuilds a text where each hunk uses either Claude's version (takeNew) or the original.
function rebuild(diff: FileDiff, takeNew: (hunk: number) => boolean): string {
	let text = '';
	diff.parts.forEach((part, i) => {
		const hunk = diff.partHunk[i];
		if (hunk === -1) {
			text += part.value;
		} else if (takeNew(hunk) ? part.added : part.removed) {
			text += part.value;
		}
	});
	return text;
}

// New original text after accepting one hunk: that hunk's new lines become part of the original.
export function acceptHunk(diff: FileDiff, hunk: number): string {
	return rebuild(diff, h => h === hunk);
}

// New current text after rejecting one hunk: that hunk goes back to the original lines.
export function rejectHunk(diff: FileDiff, hunk: number): string {
	return rebuild(diff, h => h !== hunk);
}
