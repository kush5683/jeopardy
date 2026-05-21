import axios from "axios";

export const api = axios.create({
  baseURL: "/api",
});

// Browser auth rides on an HttpOnly same-site cookie, so the client can't clear
// the credential directly. On a 401, bounce the user to /login unless the
// request explicitly opted out (used by the initial auth bootstrap).
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      const skipRedirect =
        error?.config?.headers?.["X-Skip-Auth-Redirect"] === "1";
      // Skip redirects for the initial auth bootstrap on public pages, and
      // avoid an infinite bounce loop if we're already on the login flow.
      const path = window.location.pathname;
      if (!skipRedirect && path !== "/login" && path !== "/register") {
        const returnTo = path + window.location.search;
        window.location.replace(
          `/login?returnTo=${encodeURIComponent(returnTo)}&sessionExpired=1`,
        );
      }
    }
    return Promise.reject(error);
  },
);
