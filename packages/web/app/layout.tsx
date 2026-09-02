import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Kōsen — BTC lending, underwritten by an AI that can't move your money",
  description: "Isolated-market lending for native Bitcoin collateral with an AI credit layer.",
};

const NAV = [
  { href: "/markets", label: "Markets" },
  { href: "/borrow", label: "Borrow" },
  { href: "/lend", label: "Lend" },
  { href: "/risk", label: "Risk" },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <header className="border-b border-black/10">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
            <Link href="/markets" className="text-lg font-semibold tracking-tight">
              Kōsen
            </Link>
            <nav className="flex gap-6 text-sm">
              {NAV.map((item) => (
                <Link key={item.href} href={item.href} className="text-black/70 hover:text-black">
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-6 py-10">{children}</main>
      </body>
    </html>
  );
}
