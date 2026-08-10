import { CreateLink } from "@/components/CreateLink";

/**
 * /new — make a session link without a booking.
 *
 * Unlisted rather than secret. Nothing links here, it is excluded from
 * indexing, and the endpoint behind it needs an admin sign-in AND
 * LIVE_TEST_ROOMS=true on the server — so the obscurity of the path is
 * convenience, not the control. Someone who finds this page and is not an
 * admin gets nothing from it.
 *
 * It exists so a non-technical owner can make a link, send it to whoever he
 * likes and try the thing, as many times as he wants, without a booking
 * existing and without anyone running curl for him.
 *
 * Every room made here admits ANY signed-in XPRTO account, which is exactly why
 * the whole feature is behind a server flag that must be off before launch.
 */
export default function NewSessionPage() {
    return <CreateLink />;
}
