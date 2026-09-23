import type { TaskBinding } from "../harness/task-contract.js";

/** Explicit submit metadata, consumed by the host input hook before Pi stores/expands the prompt. */
export function createTaskSubmission() {
	const open = "<pi-desktop-task-v1>", close = "</pi-desktop-task-v1>";
	return {
		encode(text: string, task: TaskBinding): string {
			return text + "\n" + open + JSON.stringify(task) + close;
		},
		decode(text: string): { text: string; binding: unknown | null } {
			const index = text.lastIndexOf("\n" + open);
			if (index < 0) return { text, binding: null };
			if (!text.endsWith(close) || text.indexOf(open) !== index + 1) throw new Error("Invalid task submission envelope");
			const payload = text.slice(index + 1 + open.length, -close.length);
			if (payload.length > 32768) throw new Error("Task submission exceeds capacity");
			return { text: text.slice(0, index), binding: JSON.parse(payload) };
		},
	};
}
