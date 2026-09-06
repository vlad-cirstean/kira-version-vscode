/**
 * P8/W12: the one new port this phase adds — see `docs/plans/P8.md`'s "Askpass: four
 * independent guarantees, and one new port" and D54 for why this is not `Secrets` (we store no
 * credential, ever), not `Dialogs` (a modal yes/no surface, not a masked text input), and not a
 * `GitHubAuth`/forge-specific port (P8 is host-agnostic git plumbing).
 *
 * The answer this port gives is handed straight to git's own askpass protocol
 * (`packages/git/src/askpass.ts`) and never cached, logged, or written anywhere by this
 * process — git's own credential helpers already do that, and better.
 */
export interface CredentialRequest {
  /** git's own prompt text, verbatim — e.g. "Password for 'https://alice@github.com': ". */
  readonly prompt: string;
  /** True when the prompt asks for a secret and the input must be masked. */
  readonly masked: boolean;
  readonly signal?: AbortSignal;
}

export interface CredentialPrompt {
  /** Resolves with the user's answer, or `undefined` if they dismissed it or the signal fired.
   *  Must never hang: an implementation that cannot ask resolves `undefined` immediately —
   *  this is one of P8's four independent no-hang guarantees (see the askpass broker,
   *  `packages/git/src/askpass.ts`). */
  ask(request: CredentialRequest): Promise<string | undefined>;
}
