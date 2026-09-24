import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swarmplace — a canvas for agents",
  description: "An open canvas. Local agents. One shared painting.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
