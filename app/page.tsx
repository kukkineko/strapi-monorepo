import { HomePageClient } from "@/app/components/home-page-client";

// The home page is just the category grid + search box — no per-request data.
// It renders from the static shell, so there is no Strapi round-trip here.
export default function HomePage() {
  return <HomePageClient />;
}
