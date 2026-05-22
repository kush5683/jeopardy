import request, { SuperTest, Test } from "supertest";
import { Round } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";
import { signToken } from "../src/middleware/auth";

/**
 * Generates agent data.
 *
 * Parameters:
 * - None.
 *
 * Output:
 * - `TestAgent<Test>`: Returned value produced by the function body.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
export function newAgent() {
  return request.agent(createApp());
}

let userCount = 0;
/**
 * Implements the register user function.
 *
 * Parameters:
 * - `agent` (`SuperTest<Test>`): Caller-provided value consumed by the function body.
 * - `overrides` (`{ email?: string; password?: string; displayName?: string }`): Identifier value used to look up, compare, or persist related records.
 *
 * Output:
 * - `Promise<{ token: string; userId: string; email: string; cookies: string[] }>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Converts dates or deadlines between Date objects, ISO strings, day keys, and millisecond timestamps.
 * - Transforms credentials or session data into hashes, tokens, or cookies.
 */
export async function registerUser(
  agent: SuperTest<Test>,
  overrides: { email?: string; password?: string; displayName?: string } = {},
): Promise<{ token: string; userId: string; email: string; cookies: string[] }> {
  userCount += 1;
  const email = overrides.email ?? `user${userCount}-${Date.now()}@test.local`;
  const password = overrides.password ?? "password1";
  const displayName = overrides.displayName ?? `User ${userCount}`;
  const res = await agent
    .post("/api/auth/register")
    .send({ email, password, displayName })
    .expect(200);
  const cookies = Array.isArray(res.headers["set-cookie"])
    ? res.headers["set-cookie"]
    : [];
  return {
    token: signToken(res.body.user.id),
    userId: res.body.user.id,
    email,
    cookies,
  };
}

/**
 * Implements the seed clue function.
 *
 * Parameters:
 * - `opts` (`{ categoryName?: string; value?: number; round?: Round; question?: string; answer?: string; dailyDouble?: boolean; airDate?: Date; metaCategories?: string[]; }`): Date-like value converted into the canonical date or timestamp representation.
 *
 * Output:
 * - `Promise<{ clueId: number; categoryId: number; answer: string; value: number }>`: Promise resolving after asynchronous work completes, usually after API/database/state side effects finish.
 *
 * Data transformations:
 * - Reads from or writes to Prisma models and reshapes database rows into application data.
 * - Computes numeric bounds, random values, or cryptographic tokens.
 */
export async function seedClue(opts: {
  categoryName?: string;
  value?: number;
  round?: Round;
  question?: string;
  answer?: string;
  dailyDouble?: boolean;
  airDate?: Date;
  metaCategories?: string[];
} = {}): Promise<{ clueId: number; categoryId: number; answer: string; value: number }> {
  const categoryName = opts.categoryName ?? `Cat-${Math.random().toString(36).slice(2, 8)}`;
  const cat = await prisma.category.upsert({
    where: { name: categoryName },
    create: { name: categoryName, metaCategories: opts.metaCategories ?? [] },
    update: {},
  });
  const clue = await prisma.clue.create({
    data: {
      categoryId: cat.id,
      round: opts.round ?? Round.JEOPARDY,
      value: opts.value ?? 400,
      question: opts.question ?? "This is a test clue",
      answer: opts.answer ?? "test answer",
      dailyDouble: opts.dailyDouble ?? false,
      airDate: opts.airDate ?? null,
    },
  });
  return { clueId: clue.id, categoryId: cat.id, answer: clue.answer, value: clue.value };
}

/**
 * Implements the auth header function.
 *
 * Parameters:
 * - `token` (`string`): Caller-provided value consumed by the function body.
 *
 * Output:
 * - `Record<string, string>`: Collection value reshaped from the input data.
 *
 * Data transformations:
 * - Performs control-flow checks and returns or mutates values without additional structural transformation.
 */
export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
