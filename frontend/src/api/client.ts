import axios from "axios";

export const api = axios.create({
  baseURL: "/api",
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("jeopardy_token");
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// We don't have a refresh-token flow, so an expired/invalid JWT means the user
// has to log in again. Detect 401s, clear the stale auth, and bounce to /login
// with a returnTo so we can drop the user back where they were after re-auth.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error?.response?.status === 401) {
      const hadAuth = localStorage.getItem("jeopardy_token");
      localStorage.removeItem("jeopardy_token");
      localStorage.removeItem("jeopardy_user");
      // Only redirect if we actually had a token to begin with — otherwise this
      // was a "you need to log in" 401 from a page that handles it inline
      // (e.g. /clues/submit attempts without auth). Also avoid an infinite
      // bounce loop if we're already on the login flow.
      const path = window.location.pathname;
      if (hadAuth && path !== "/login" && path !== "/register") {
        const returnTo = path + window.location.search;
        window.location.replace(
          `/login?returnTo=${encodeURIComponent(returnTo)}&sessionExpired=1`,
        );
      }
    }
    return Promise.reject(error);
  },
);
