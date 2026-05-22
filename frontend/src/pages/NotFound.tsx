import { Link } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";

/**
 * Renders the NotFound React component.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `Element`: Rendered React UI derived from current props, state, and fetched data.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
export function NotFound() {
  useDocumentTitle("Page not found");
  return (
    <div className="max-w-lg mx-auto mt-16 text-center space-y-4">
      <h1 className="font-category text-6xl text-jeopardy-gold">404</h1>
      <p className="text-xl text-white/80">
        What is — a page that doesn't exist?
      </p>
      <p className="text-sm text-white/60">
        The URL you followed isn't part of the app.
      </p>
      <div className="pt-4">
        <Link
          to="/"
          className="inline-block px-6 py-3 bg-jeopardy-gold text-black font-semibold rounded"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}
