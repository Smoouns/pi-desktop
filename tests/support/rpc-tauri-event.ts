type Listener = (event: { payload: unknown }) => void;

const listeners = new Map<string, Set<Listener>>();

export type UnlistenFn = () => void;

export async function listen<T>(name: string, callback: (event: { payload: T }) => void): Promise<UnlistenFn> {
	const registered = listeners.get(name) ?? new Set<Listener>();
	registered.add(callback as Listener);
	listeners.set(name, registered);
	return () => registered.delete(callback as Listener);
}

export function rpcEmit(name: string, payload: unknown): void {
	for (const listener of listeners.get(name) ?? []) listener({ payload });
}

export function rpcResetEventMock(): void {
	listeners.clear();
}
