import request, { SuperTest, Test } from "supertest";
import { Round } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import { createApp } from "../src/app";
import { signToken } from "../src/middleware/auth";

export function newAgent() {
  return request.agent(createApp());
}

let userCount = 0;
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

export function authHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}
