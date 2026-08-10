import { SessionRoom } from "@/components/SessionRoom";

/**
 * /s/<slug>
 *
 * A server component that does nothing but hand the slug down. There is
 * deliberately no server-side fetch here: the session's access check needs the
 * user's bearer token, which lives in the browser and never touches this
 * origin's server. Rendering anything about the session on the server would
 * mean either shipping the token to it or leaking room detail to whoever holds
 * the URL — and the whole design rests on the URL proving nothing.
 */
export default async function SessionPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <SessionRoom slug={slug} />;
}
