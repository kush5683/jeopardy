type Props = {
  onRetry: () => void;
  message?: string;
};

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
