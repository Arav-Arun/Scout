import type { Metadata } from "next";
import { Hanken_Grotesk } from "next/font/google";
import "./globals.css";

// Hanken Grotesk: a refined, slightly characterful grotesque with excellent
// tabular figures - more considered than the default Inter, still enterprise-clean.
const sans = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-hanken",
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Scout - AI Data Analytics Agent",
  description:
    "Ask open-ended questions of your ClickHouse data warehouse in plain English. Scout discovers the schema, runs SQL iteratively, and returns hero metrics, charts and narrative insights.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={sans.variable} suppressHydrationWarning>
      <head>
        {/* Apply light theme by default before paint. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{document.documentElement.setAttribute('data-theme','light')}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
