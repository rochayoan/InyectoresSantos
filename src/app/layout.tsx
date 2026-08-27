import type { ReactNode } from 'react';

export const metadata = {
  title: 'Inyectores Santos',
  description: 'Respuestas automáticas de WhatsApp para Inyectores Santos',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
