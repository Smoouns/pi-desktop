type InvokeHandler = (command: string, args: Record<string, unknown> | undefined) => unknown | Promise<unknown>;

let handler: InvokeHandler = (command) => {
	throw new Error(`Unexpected invoke: ${command}`);
};

export function rpcSetInvokeHandler(next: InvokeHandler): void {
	handler = next;
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
	return await handler(command, args) as T;
}
