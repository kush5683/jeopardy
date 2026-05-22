import { Component, ErrorInfo, ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

// Catches render-time errors in the React tree below so one buggy page can't
// blank the whole app. componentDidCatch is the only API for this — function
// components can't substitute via hooks.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  /**
   * Implements the get derived state from error method.
   *
   * Parameters:
   * - `error` (`Error`): Error value inspected or forwarded by the failure path.
   *
   * Output:
   * - `State`: Returned value produced by the function body.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  /**
   * Implements the component did catch method.
   *
   * Parameters:
   * - `error` (`Error`): Error value inspected or forwarded by the failure path.
   * - `info` (`ErrorInfo`): Caller-provided value consumed by the function body.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Log to console so devtools shows the stack; no remote telemetry wired yet.
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  /**
   * Implements the reset function.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `void`: No direct value; effects are applied through state, response objects, timers, or other side-effect targets.
   *
   * Data transformations:
   * - Updates application/browser state, cookies, or persistent browser storage from computed values.
   */
  reset = () => {
    this.setState({ error: null });
  };

  /**
   * Implements the render method.
   *
   * Parameters:
   * - None.
   *
   * Output:
   * - `string | number | boolean | Element | Iterable<ReactNode>`: Rendered React UI derived from current props, state, and fetched data.
   *
   * Data transformations:
   * - Performs control-flow checks and returns or mutates values without additional structural transformation.
   */
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="max-w-lg mx-auto mt-16 text-center space-y-4">
        <h1 className="font-category text-4xl text-jeopardy-gold">
          Something broke
        </h1>
        <p className="text-white/80 text-sm">
          The page hit an error and couldn't render. Try reloading, or head back home.
        </p>
        <pre className="text-left text-xs text-red-300 bg-red-900/20 rounded p-3 overflow-x-auto whitespace-pre-wrap">
          {this.state.error.message}
        </pre>
        <div className="flex gap-2 justify-center">
          <button
            onClick={this.reset}
            className="px-4 py-2 rounded border border-white/30 hover:bg-white/10"
          >
            Try again
          </button>
          <a
            href="/"
            className="px-4 py-2 rounded bg-jeopardy-gold text-black font-semibold"
          >
            Go home
          </a>
        </div>
      </div>
    );
  }
}
