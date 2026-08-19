import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '${{ values.appName }}',
  // dump-quoted (D-108 correction — this was missed in the round-4 sweep, incorrectly
  // bucketed with page.tsx's JSX-text-content usage below; this one is a plain TS
  // string literal, same SyntaxError-on-apostrophe risk as the already-fixed
  // package.json/main.py cases, not the lower-priority JSX-text-content class).
  description: ${{ values.description | dump }},
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900 antialiased">
        {children}
      </body>
    </html>
  );
}
