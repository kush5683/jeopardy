type Props = {
  onRetry: () => void;
  message?: string;
};

/**
 * Renders the RetryPanel React component.
 *
 * Parameters:
 * - `{ onRetry, message }` (`Props`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
export function RetryPanel({ onRetry, message }: Props) {
  return (
    <div className="max-w-md mx-auto text-center py-12 space-y-3">
      <p className="text-white/80">{message ?? "Couldn't load this page."}</p>
      <p className="text-xs text-white/50">
        Check your connection — the server may be unreachable.
      </p>
      <button
        onClick={onRetry}
        className="px-4 py-2 rounded border border-white/30 hover:bg-white/10"
      >
        Try again
      </button>
    </div>
  );
}
