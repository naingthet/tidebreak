import { Provider } from '@/components/provider';
import type { Metadata } from 'next';
import { getPageImage, source } from '@/lib/source';
import { SITE_ORIGIN } from '@/lib/site';
import './global.css';

const homePage = source.getPage([]);
const homeImage = homePage ? getPageImage(homePage).url : '/og/image.png';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: 'Tidebreak Docs',
    template: '%s — Tidebreak Docs',
  },
  description: 'Documentation for Tidebreak.',
  openGraph: {
    siteName: 'Tidebreak Docs',
    images: homeImage,
  },
  twitter: {
    card: 'summary_large_image',
    images: homeImage,
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <Provider searchApi={`${process.env.BASE_PATH ?? ''}/api/search`}>
          {children}
        </Provider>
      </body>
    </html>
  );
}
