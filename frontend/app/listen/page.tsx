import { ListsClient } from "./client";

// Lists live entirely in the browser's localStorage (open to every visitor),
// so there is no per-request Strapi data — this route renders the client shell.
export default function ListsPage() {
  return <ListsClient />;
}
