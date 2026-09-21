// Public settings the static pages need before anyone is signed in.
export default function handler(req, res) {
  res.setHeader("cache-control", "public, max-age=300");
  res.status(200).json({ clerkPublishableKey: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY ?? process.env.CLERK_PUBLISHABLE_KEY ?? null });
}
