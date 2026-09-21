/** UI-only response fence. Runtime identity includes the child-process generation;
 * revision also separates A -> B -> A switches within the same running child. */
export class SessionRefreshScope {
	private revision = 0;
	invalidate(): void { this.revision += 1; }
	capture(runtimeIdentity: string, currentRuntimeIdentity: () => string): () => boolean {
		const revision = this.revision;
		return () => revision === this.revision && runtimeIdentity === currentRuntimeIdentity();
	}
}
