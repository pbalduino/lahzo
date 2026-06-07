import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lahzo SMS Console",
  description: "Conversational SMS system for Lahzo technical assessment.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
