import { uploadMedia, getEntryById, type StrapiMedia, type Entry } from "./entries";

const ITEM_IMAGE_PREFIX = "wiki-item-images:";

function getStorageKey(itemId: string) {
  return `${ITEM_IMAGE_PREFIX}${itemId}`;
}

/**
 * Get images for an item from Strapi, with a localStorage fallback when
 * the network request fails.
 */
export async function getItemImages(itemId: string): Promise<string[]> {
  try {
    const entry = await getEntryById(itemId);
    const urls = entry?.pictureUrls ?? [];

    if (typeof window !== "undefined") {
      window.localStorage.setItem(getStorageKey(itemId), JSON.stringify(urls));
    }

    return urls;
  } catch (error) {
    console.error("[getItemImages] Error loading images:", error);

    // Return locally-cached URLs so the UI doesn't go blank on a transient error.
    if (typeof window !== "undefined") {
      const cached = window.localStorage.getItem(getStorageKey(itemId));
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as unknown;
          if (Array.isArray(parsed)) {
            return parsed.filter((item): item is string => typeof item === "string");
          }
        } catch {
          // Ignore malformed cache entry.
        }
      }
    }
    return [];
  }
}

/**
 * Upload and attach images to an entry.
 * Uses the authenticated API route so that only trusted users can
 * modify entries and the action is audit-logged.
 */
export async function appendItemImages(itemId: string, files: File[]): Promise<string[]> {
  try {
    // 1. Upload files to Strapi media library (unchanged).
    const mediaIds = await uploadMedia(files);

    // 2. Get the current entry to read existing picture IDs.
    const entry = await getEntryById(itemId);
    const currentPictures = (entry?.pictures ?? []) as (StrapiMedia | number)[];
    const existingIds = currentPictures
      .map((pic) => (typeof pic === "number" ? pic : (pic as StrapiMedia).id))
      .filter((id): id is number => typeof id === "number");

    const mergedIds = Array.from(new Set([...existingIds, ...mediaIds]));

    // 3. Update the entry via the authenticated API route.
    const res = await fetch(`/api/entries/${encodeURIComponent(itemId)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: entry?.title ?? "Untitled",
        pictures: mergedIds,
        _auditSection: "images",
      }),
    });

    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      throw new Error(data.error ?? "Failed to attach images.");
    }

    const updated = (await res.json()) as Entry;
    const urls = updated.pictureUrls ?? [];

    if (typeof window !== "undefined") {
      window.localStorage.setItem(getStorageKey(itemId), JSON.stringify(urls));
    }

    return urls;
  } catch (error) {
    console.error("Failed to append item images:", error);
    throw error;
  }
}

/**
 * Persist image URLs locally (no Strapi call).
 */
export function saveItemImages(itemId: string, images: string[]): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(getStorageKey(itemId), JSON.stringify(images));
}

/**
 * Remove an image from an entry by index and persist the change to Strapi.
 * Uses the authenticated API route so that only trusted users can
 * modify entries and the action is audit-logged.
 */
export async function removeItemImage(itemId: string, index: number): Promise<string[]> {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const entry = await getEntryById(itemId);
    const currentPictures = (entry?.pictures ?? []) as (StrapiMedia | number)[];

    const pictureIds = currentPictures
      .map((pic) => (typeof pic === "number" ? pic : (pic as StrapiMedia).id))
      .filter((id): id is number => typeof id === "number");

    const nextPictureIds = pictureIds.filter((_, picIndex) => picIndex !== index);

    if (nextPictureIds.length !== pictureIds.length) {
      const res = await fetch(`/api/entries/${encodeURIComponent(itemId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: entry?.title ?? "Untitled",
          pictures: nextPictureIds,
          _auditSection: "images",
          _auditAction: "delete",
        }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to remove image.");
      }

      const updated = (await res.json()) as Entry;
      const urls = updated.pictureUrls ?? [];
      window.localStorage.setItem(getStorageKey(itemId), JSON.stringify(urls));
      return urls;
    }

    return entry?.pictureUrls ?? [];
  } catch (error) {
    console.error("[removeItemImage] Error removing image:", error);
    throw error;
  }
}
