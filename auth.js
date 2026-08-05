// auth.js — developer account auth (bcrypt password hashing + JWT sessions).
// This protects the dashboard. Game telemetry ingestion uses a separate
// api-key check (see server.js /ingest) — two different trust boundaries.

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { users } from "./db.js";

const SECRET = process.env.JWT_SECRET || "dev-only-secret-change-me";
// Dashboard activity renews this token on authenticated requests. A user who
// stays away for three days must sign in again; an actively used dashboard
// keeps its session without forcing an arbitrary weekly logout.
const TOKEN_TTL = "3d";

export async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}

export async function verifyPassword(pw, hash) {
  if (!hash) return false;
  return bcrypt.compare(pw, hash);
}

export function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, SECRET, {
    expiresIn: TOKEN_TTL,
  });
}

// Express middleware: require a valid bearer token, attach req.user.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sign in to continue." });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = users.byId(payload.uid);
    if (!user) return res.status(401).json({ error: "Session no longer valid." });
    req.user = user;
    // Rolling expiration: the browser replaces its stored token with this
    // fresh one after each successful authenticated dashboard request.
    res.set("X-Session-Token", signToken(user));
    next();
  } catch {
    return res.status(401).json({ error: "Session expired. Sign in again." });
  }
}
