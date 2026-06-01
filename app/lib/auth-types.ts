export type AuthUser = {
  id: number;
  userID: string;
  name: Record<string, unknown>;
  username: Record<string, unknown>;
  email: string;
  company: Record<string, unknown>;
  data: Record<string, unknown>;
  confirmed: boolean;
  trusted: boolean;
  blocked: boolean;
  employee: boolean;
  administrator: boolean;
};

export function toObjectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

/**
 * Normalise a Strapi JSON field into a Record.  If the API returns a raw
 * string (e.g. `"johndoe"`) instead of an object, it is wrapped as
 * `{ value: <string> }` so callers always get a Record.
 */
export function toJsonField(value: unknown): Record<string, unknown> {
  if (!value) {
    return {};
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return {};
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }

      return { value: parsed };
    } catch {
      return { value: trimmed };
    }
  }

  return { value };
}

function toBooleanLike(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (!lowered) {
      return false;
    }

    return lowered === "true" || lowered === "1" || lowered === "yes";
  }

  return Boolean(value);
}

/* --------------- Display helpers for JSON fields --------------- */

/** Extract a display string from the `name` JSON field ({name, surname}). */
export function displayName(name: Record<string, unknown>): string {
  const firstName = typeof name.name === "string" ? name.name.trim() : "";
  const surname = typeof name.surname === "string" ? name.surname.trim() : "";
  return [firstName, surname].filter(Boolean).join(" ");
}

/** Extract a display string from the `username` JSON field. */
export function displayUsername(username: Record<string, unknown>): string {
  if (typeof username.value === "string" && username.value.trim()) {
    return username.value.trim();
  }

  if (typeof username.display === "string" && username.display.trim()) {
    return username.display.trim();
  }

  for (const val of Object.values(username)) {
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }

  return "";
}

/** Extract a display string from the `company` JSON field. */
export function displayCompany(company: Record<string, unknown>): string {
  if (typeof company.name === "string" && company.name.trim()) {
    return company.name.trim();
  }

  if (typeof company.value === "string" && company.value.trim()) {
    return company.value.trim();
  }

  for (const val of Object.values(company)) {
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }

  return "";
}

export function readFavIds(data: unknown): string[] {
  const record = toObjectRecord(data);
  const rawFav = record.fav;

  if (!Array.isArray(rawFav)) {
    return [];
  }

  return rawFav
    .map((item) => String(item).trim())
    .filter(Boolean);
}

export function parseNameSurnameValue(value: unknown): {
  firstName: string;
  surname: string;
  displayName: string;
  rawJson: string;
} {
  const asString = typeof value === "string" ? value.trim() : "";
  const asObject = toObjectRecord(value);
  const objectFirstName = typeof asObject.name === "string" ? asObject.name.trim() : "";
  const objectSurname = typeof asObject.surname === "string" ? asObject.surname.trim() : "";
  const objectDisplayName = [objectFirstName, objectSurname].filter(Boolean).join(" ").trim();
  const fallback = {
    firstName: objectFirstName,
    surname: objectSurname,
    displayName: objectDisplayName || asString,
    rawJson: asString || JSON.stringify(asObject),
  };

  if (!asString && !objectDisplayName) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(asString) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fallback;
    }

    const source = parsed as { name?: unknown; surname?: unknown };
    const firstName = typeof source.name === "string" ? source.name.trim() : "";
    const surname = typeof source.surname === "string" ? source.surname.trim() : "";
    const displayNameValue = [firstName, surname].filter(Boolean).join(" ").trim();

    return {
      firstName,
      surname,
      displayName: displayNameValue,
      rawJson: asString,
    };
  } catch {
    return fallback;
  }
}

export function buildNameJson(firstName: string, surname: string): Record<string, unknown> {
  return {
    name: firstName.trim(),
    surname: surname.trim(),
  };
}

export function buildUsernameJson(value: string): Record<string, unknown> {
  return { value: value.trim() };
}

export function buildCompanyJson(value: string): Record<string, unknown> {
  return value.trim() ? { name: value.trim() } : {};
}

export function hydrateAuthUserFromProfile<T extends AuthUser>(user: T, profile: unknown): T {
  const profileRecord = toObjectRecord(profile);
  const profileData = toObjectRecord(profileRecord.data);

  // Resolve the name JSON field (try `name` first, fall back to legacy `name_Surname`)
  const rawName = profileRecord.name ?? profileData.name ?? profileRecord.name_Surname ?? profileData.name_Surname;
  const nameJson = toJsonField(rawName);
  const hasName = Object.keys(nameJson).length > 0;

  const rawUsername = profileRecord.username ?? profileData.username;
  const usernameJson = toJsonField(rawUsername);
  const hasUsername = Object.keys(usernameJson).length > 0;

  const rawCompany = profileRecord.company ?? profileData.company;
  const companyJson = toJsonField(rawCompany);
  const hasCompany = Object.keys(companyJson).length > 0;

  const rawUserID = profileRecord.userID ?? profileData.userID;
  const userID = typeof rawUserID === "string" ? rawUserID.trim() : "";

  return {
    ...user,
    userID: userID || user.userID,
    name: hasName ? nameJson : user.name,
    username: hasUsername ? usernameJson : user.username,
    company: hasCompany ? companyJson : user.company,
    confirmed:
      Object.prototype.hasOwnProperty.call(profileRecord, "confirmed")
        ? toBooleanLike(profileRecord.confirmed)
        : Object.prototype.hasOwnProperty.call(profileData, "confirmed")
          ? toBooleanLike(profileData.confirmed)
          : user.confirmed,
    trusted:
      Object.prototype.hasOwnProperty.call(profileRecord, "trusted")
        ? toBooleanLike(profileRecord.trusted)
        : Object.prototype.hasOwnProperty.call(profileData, "trusted")
          ? toBooleanLike(profileData.trusted)
          : user.trusted,
    blocked:
      Object.prototype.hasOwnProperty.call(profileRecord, "blocked")
        ? toBooleanLike(profileRecord.blocked)
        : Object.prototype.hasOwnProperty.call(profileData, "blocked")
          ? toBooleanLike(profileData.blocked)
          : user.blocked,
    administrator:
      Object.prototype.hasOwnProperty.call(profileRecord, "administrator")
        ? toBooleanLike(profileRecord.administrator)
        : Object.prototype.hasOwnProperty.call(profileData, "administrator")
          ? toBooleanLike(profileData.administrator)
          : user.administrator,
    employee:
      Object.prototype.hasOwnProperty.call(profileRecord, "employee")
        ? toBooleanLike(profileRecord.employee)
        : Object.prototype.hasOwnProperty.call(profileData, "employee")
          ? toBooleanLike(profileData.employee)
          : user.employee,
    data: Object.keys(profileData).length > 0 ? profileData : user.data,
  };
}
