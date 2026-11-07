// A mistake in what the user gave the run (the config, a replayed run folder): its message says what to fix, so the
// command prints it as one line, without the stack (src/cli/args.ts)
export class InputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InputError";
  }
}
