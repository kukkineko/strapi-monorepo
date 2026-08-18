export type IgsEntry = {
  name: string;
  value: unknown;
};

const IGS_LEGACY_KEY_TO_LABEL: Record<string, string> = {
  C: "Bezeichnung 1",
  D: "Bezeichnung 2",
  IR: "Bezeichnung 3",
  IS: "Bezeichnung 4",
  HC: "Matchcode 1",
  HD: "Matchcode 2",
  BY: "Kurztext",
  P: "Ursprungsland",
  R: "Auslaufart",
};

const IGS_INFO_DEFAULT: IgsEntry[] = [
  { name: "DSU001", value: "" },
  { name: "DSU002", value: "" },
  { name: "DSU003", value: "" },
  { name: "DSU004", value: "" },
  { name: "DSU005", value: "" },
  { name: "DSU006", value: "" },
];

const IGS_DEFAULT_ENTRIES: IgsEntry[] = [
  { name: "Bezeichnung 1", value: "" },
  { name: "Bezeichnung 2", value: "" },
  { name: "Bezeichnung 3", value: "" },
  { name: "Bezeichnung 4", value: "" },
  { name: "Matchcode 1", value: "" },
  { name: "Matchcode 2", value: "" },
  { name: "Kurztext", value: "" },
  { name: "Ursprungsland", value: "" },
  { name: "Auslaufart", value: "" },
  { name: "Rubrik", value: "" },
  { name: "INFO", value: IGS_INFO_DEFAULT },
];

export const IGS_PRIMARY_FIELDS = [
  "Bezeichnung 1",
  "Bezeichnung 2",
  "Bezeichnung 3",
  "Bezeichnung 4",
  "Matchcode 1",
  "Matchcode 2",
  "Kurztext",
  "Ursprungsland",
  "Auslaufart",
  "Rubrik",
] as const;

export const IGS_DEFAULT_TEMPLATE = JSON.stringify(IGS_DEFAULT_ENTRIES, null, 2);

function normalizeName(name: string): string {
  const trimmed = name.trim();
  const mapped = IGS_LEGACY_KEY_TO_LABEL[trimmed] ?? trimmed;
  return mapped.toLowerCase();
}

function toDisplayName(name: string): string {
  const trimmed = name.trim();
  return IGS_LEGACY_KEY_TO_LABEL[trimmed] ?? trimmed;
}

function toEntriesFromValue(value: unknown): IgsEntry[] {
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (!item || typeof item !== "object") {
          return null;
        }

        const source = item as Record<string, unknown>;
        const rawName = source.name;
        if (typeof rawName !== "string" || !rawName.trim()) {
          return null;
        }

        return {
          name: toDisplayName(rawName),
          value: source.value,
        } as IgsEntry;
      })
      .filter((item): item is IgsEntry => item !== null);
  }

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).map(([key, itemValue]) => ({
      name: toDisplayName(key),
      value: itemValue,
    }));
  }

  return [];
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const maybeEntries = toEntriesFromValue(value);
    if (maybeEntries.length > 0) {
      return maybeEntries
        .map((entry) => {
          const nestedValue = stringifyValue(entry.value);
          return nestedValue ? `${entry.name}: ${nestedValue}` : entry.name;
        })
        .join(" | ");
    }

    return value.map((item) => stringifyValue(item)).filter(Boolean).join(", ");
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

export function parseIgsEntries(raw?: string): IgsEntry[] | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    const entries = toEntriesFromValue(parsed);
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

export function getIgsFieldValue(raw: string | undefined, candidates: string[]): string | null {
  const entries = parseIgsEntries(raw);
  if (!entries) {
    return null;
  }

  const wanted = candidates.map((name) => normalizeName(name));
  const matches = entries.filter((entry) => wanted.includes(normalizeName(entry.name)));

  for (const match of matches) {
    const text = stringifyValue(match.value);
    if (text) {
      return text;
    }
  }

  return null;
}

/**
 * Sets a single IGS field's value inside the raw IGS JSON, preserving the rest
 * of the structure (INFO block, ordering, other fields). Matching is by
 * normalized name, so "Rubrik" updates whichever entry the parser reads as the
 * Rubrik field. Returns the re-serialized JSON, or null when there is no IGS
 * data to update (empty/invalid) — callers should then leave IGS untouched.
 */
export function setIgsFieldValue(
  raw: string | undefined,
  fieldName: string,
  value: string,
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const target = normalizeName(fieldName);

  if (Array.isArray(parsed)) {
    let found = false;
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as { name?: unknown }).name === "string" &&
        normalizeName((item as { name: string }).name) === target
      ) {
        (item as { value: unknown }).value = value;
        found = true;
      }
    }
    if (!found) {
      parsed.push({ name: fieldName, value });
    }
    return JSON.stringify(parsed, null, 2);
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    const matchedKey = Object.keys(obj).find((key) => normalizeName(key) === target);
    obj[matchedKey ?? fieldName] = value;
    return JSON.stringify(obj, null, 2);
  }

  return null;
}

export function getIgsDisplayFields(raw?: string): Array<{ label: string; value: string }> | null {
  const entries = parseIgsEntries(raw);
  if (!entries) {
    return null;
  }

  return IGS_PRIMARY_FIELDS.map((label) => {
    const normalized = normalizeName(label);
    const values = entries
      .filter((entry) => normalizeName(entry.name) === normalized)
      .map((entry) => stringifyValue(entry.value))
      .filter(Boolean);

    return {
      label,
      value: values.join(" | "),
    };
  });
}

function deepCloneDefaults(): IgsEntry[] {
  return JSON.parse(JSON.stringify(IGS_DEFAULT_ENTRIES)) as IgsEntry[];
}

export function ensureIgsTemplate(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return IGS_DEFAULT_TEMPLATE;
  }

  const entries = parseIgsEntries(trimmed);
  if (!entries) {
    return trimmed;
  }

  const defaults = deepCloneDefaults();
  const used = new Set<number>();

  const merged = defaults.map((item) => {
    const matchIndex = entries.findIndex(
      (entry, index) => !used.has(index) && normalizeName(entry.name) === normalizeName(item.name)
    );

    if (matchIndex === -1) {
      return item;
    }

    used.add(matchIndex);
    return {
      name: item.name,
      value: entries[matchIndex]!.value,
    };
  });

  const extras = entries
    .filter((_, index) => !used.has(index))
    .map((entry) => ({
      name: entry.name,
      value: entry.value,
    }));

  return JSON.stringify([...merged, ...extras], null, 2);
}