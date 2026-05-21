import { describe, it, expect } from "vitest";
import { newAgent, registerUser, authHeader } from "./helpers";

describe("auth + friends", () => {
  it("registers a user and sets a usable session cookie", async () => {
    const agent = newAgent();
    const { cookies, userId } = await registerUser(agent);
    expect(cookies.some((cookie) => cookie.startsWith("jeopardy_session="))).toBe(true);
    expect(userId).toBeTruthy();

    const me = await agent.get("/api/stats/me").expect(200);
    expect(me.body).toHaveProperty("totalAnswered", 0);
  });

  it("rejects duplicate email on register", async () => {
    const agent = newAgent();
    const { email } = await registerUser(agent);
    await agent
      .post("/api/auth/register")
      .send({ email, password: "password1", displayName: "X" })
      .expect(409);
  });

  it("rejects wrong password on login", async () => {
    const agent = newAgent();
    const { email } = await registerUser(agent);
    await agent
      .post("/api/auth/login")
      .send({ email, password: "wrong-password" })
      .expect(401);
  });

  it("logs in with correct password", async () => {
    const agent = newAgent();
    const { email } = await registerUser(agent, { password: "password1" });
    const res = await agent
      .post("/api/auth/login")
      .send({ email, password: "password1" })
      .expect(200);
    expect(res.body.user.email).toBe(email);
    const cookies = Array.isArray(res.headers["set-cookie"])
      ? res.headers["set-cookie"]
      : [];
    expect(cookies.some((cookie) => cookie.startsWith("jeopardy_session="))).toBe(
      true,
    );
  });

  it("logout clears the session cookie", async () => {
    const agent = newAgent();
    await registerUser(agent);
    await agent.post("/api/auth/logout").expect(200);
    await agent.get("/api/stats/me").expect(401);
  });

  it("friends/request does not enumerate emails", async () => {
    const agent = newAgent();
    const { token } = await registerUser(agent);
    // Non-existent target
    const r1 = await agent
      .post("/api/friends/request")
      .set(authHeader(token))
      .send({ email: "ghost@nowhere.local" })
      .expect(200);
    expect(r1.body).toEqual({ ok: true });

    // Self
    const me = await agent.get("/api/stats/me").set(authHeader(token));
    expect(me.status).toBe(200);
    // Use own email
    const r2 = await agent
      .post("/api/friends/request")
      .set(authHeader(token))
      .send({ email: "ghost@nowhere.local" })
      .expect(200);
    expect(r2.body).toEqual({ ok: true });
  });

  it("friends/request creates a pending row for real users", async () => {
    const agent = newAgent();
    const a = await registerUser(agent);
    const b = await registerUser(agent);
    const res = await agent
      .post("/api/friends/request")
      .set(authHeader(a.token))
      .send({ email: b.email })
      .expect(200);
    expect(res.body).toEqual({ ok: true });

    const pending = await agent
      .get("/api/friends/pending")
      .set(authHeader(b.token))
      .expect(200);
    expect(pending.body.incoming).toHaveLength(1);
    expect(pending.body.incoming[0].from.id).toBe(a.userId);
    expect(pending.body.incoming[0].from).not.toHaveProperty("email");
  });
});
