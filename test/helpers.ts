import { createHash } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";

// Rate limiting is off here: these tests send many requests from one IP.
// test/rate-limit.test.ts covers the limits with their real settings.
export const app = createApp({ rateLimit: false });
export const api = () => request(app);
export { prisma };

export const PASSWORD = "Secret123!";

let counter = 0;
export const uniqueEmail = () => `user${Date.now()}${counter++}@example.com`;

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export const decodeJwt = (token: string) =>
  JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()) as { iat: number; exp: number; sub: string };

export async function resetDatabase() {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "customers", "invitations", "refresh_tokens", "users", "companies" CASCADE`);
}

export async function registerUser(email = uniqueEmail(), password = PASSWORD) {
  const res = await api()
    .post("/api/auth/register")
    .send({ fullName: "محمد أحمد", companyName: "شركة ميزان", email, password });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { email, password, user: res.body.user };
}

export async function login(email: string, password = PASSWORD, remember = false) {
  const res = await api().post("/api/auth/login").send({ email, password, remember });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { accessToken: string; refreshToken: string; user: { id: string; email: string } };
}

/** Days between createdAt and expiresAt of the stored refresh token. */
export async function refreshLifetimeDays(refreshToken: string) {
  const row = await prisma.refreshToken.findUniqueOrThrow({ where: { tokenHash: hashToken(refreshToken) } });
  return Math.round((row.expiresAt.getTime() - row.createdAt.getTime()) / 86_400_000);
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/** Registers a company and logs its owner in. */
export async function ownerSession() {
  const { email, user } = await registerUser();
  const session = await login(email);
  return { email, companyId: user.company.id as string, userId: user.id as string, token: session.accessToken };
}

/** Owner invites someone; returns the invite token taken from the link. */
export async function invite(ownerToken: string, role = "accountant", email = uniqueEmail()) {
  const res = await api().post("/api/invitations").set(auth(ownerToken)).send({ name: "Sara Ali", email, role });
  if (res.status !== 201) throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  const token = new URL(res.body.inviteUrl).pathname.split("/").pop()!;
  return { email, token, invitation: res.body.invitation };
}

/** Invites someone, accepts the invite, and logs them in. */
export async function teamMember(ownerToken: string, role = "accountant") {
  const { email, token } = await invite(ownerToken, role);
  const accepted = await api().post("/api/invitations/accept").send({ token, password: PASSWORD });
  if (accepted.status !== 201) throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  const session = await login(email);
  return { email, userId: accepted.body.user.id as string, token: session.accessToken, refreshToken: session.refreshToken };
}
