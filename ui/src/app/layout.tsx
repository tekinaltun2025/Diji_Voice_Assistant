import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import Link from 'next/link';
// @ts-ignore // globals.css side-effect import
import './globals.css';
// (removed duplicate Link import)

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Diji - Türkçe Sesli Asistan',
  description: 'Diji - Türkçe Sesli Asistan ve Akıllı Asistan',
  authors: [{ name: 'Diji Team' }],
  keywords: ['Diji', 'sesli asistan', 'turkish voice assistant', 'AI', 'MCP'],
  openGraph: {
    title: 'Diji - Türkçe Sesli Asistan',
    description: 'Diji - Türkçe Sesli Asistan ve Akıllı Asistan',
    type: 'website',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="tr-TR" className={`${inter.variable} font-sans`}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0f172a" />
      </head>
      <body className="bg-diji-background text-diji-text antialiased min-h-screen selection:bg-diji-primary selection:text-white">
        {/* Header with settings link */}
        <header className="flex justify-end p-4">
          <Link href="/settings" className="text-diji-primary hover:underline">Ayarlar</Link>
        </header>
        {children}
      </body>
    </html>
  );
}