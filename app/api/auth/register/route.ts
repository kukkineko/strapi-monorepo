import { NextResponse } from "next/server";
import { registerUser, setSessionJwt } from "@/app/lib/auth-server";
import { clientIpFromHeaders, isRateLimited } from "@/app/lib/rate-limit";

const REGISTER_LIMIT = 6;
const REGISTER_WINDOW_MS = 60 * 60 * 1000;

function normalizeSlug(value: string): string {
  const lowered = value.trim().toLowerCase();
  const ascii = lowered.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const slug = ascii.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "user";
}

function buildUsernameCandidates(firstName: string, surname: string): string[] {
  const firstNormalized = normalizeSlug(firstName).replace(/_/g, "");
  const surnameNormalized = normalizeSlug(surname).replace(/_/g, "");

  const firstBase = firstNormalized || "us";
  const surnameBase = surnameNormalized || "usr";

  const firstStart = Math.min(2, firstBase.length);
  const surnameStart = Math.min(3, surnameBase.length);

  const candidates: string[] = [
    `${firstBase.slice(0, firstStart)}${surnameBase.slice(0, surnameStart)}`,
  ];

  let currentFirst = firstStart;
  let currentSurname = surnameStart;

  while (currentSurname < surnameBase.length) {
    currentSurname += 1;
    candidates.push(`${firstBase.slice(0, currentFirst)}${surnameBase.slice(0, currentSurname)}`);
  }

  while (currentFirst < firstBase.length) {
    currentFirst += 1;
    candidates.push(`${firstBase.slice(0, currentFirst)}${surnameBase.slice(0, surnameBase.length)}`);
  }

  const fullBase = `${firstBase}${surnameBase}`;
  candidates.push(fullBase);

  for (let i = 1; i <= 9; i++) {
    candidates.push(`${fullBase}${i}`);
  }

  return Array.from(new Set(candidates.map((value) => value.toLowerCase()).filter(Boolean)));
}

export async function POST(request: Request) {
  const ip = clientIpFromHeaders(request.headers);
  if (isRateLimited(`register:${ip}`, REGISTER_LIMIT, REGISTER_WINDOW_MS)) {
    return NextResponse.json(
      { error: "Too many registration attempts. Please wait a while and try again." },
      { status: 429 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    name?: unknown;
    surname?: unknown;
    email?: unknown;
    company?: unknown;
    password?: unknown;
  } | null;

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const surname = typeof body?.surname === "string" ? body.surname.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const company = typeof body?.company === "string" ? body.company.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!name || !surname || !email || !password) {
    return NextResponse.json({ error: "Name, surname, email, and password are required." }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
  }

  const usernameCandidates = buildUsernameCandidates(name, surname);

  let lastError = "Registration failed.";
  let lastStatus = 400;

  for (const username of usernameCandidates) {
    const result = await registerUser({
      username,
      email,
      password,
      firstName: name,
      lastName: surname,
      company,
    });

    if (result.ok) {
      await setSessionJwt(result.jwt);
      return NextResponse.json({ user: result.user });
    }

    const message = result.error.toLowerCase();
    // An email collision is fatal — a different username won't help.
    if (message.includes("email")) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }
    // A username collision: try the next candidate.
    if (message.includes("username")) {
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }
    // Any other error is fatal.
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json({ error: lastError }, { status: lastStatus });
}
