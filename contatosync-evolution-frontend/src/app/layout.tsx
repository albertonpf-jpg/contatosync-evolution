import type { Metadata } from "next";
import { AuthProvider } from '@/contexts/AuthContext';
import ClientOnly from '@/components/ClientOnly';
import "./globals.css";

export const metadata: Metadata = {
  title: "ContatoSync Evolution - Dashboard",
  description: "Sistema multi-cliente de gestão WhatsApp com CRM e IA",
  keywords: ["WhatsApp", "CRM", "IA", "Multi-cliente", "Gestão"],
  authors: [{ name: "Alberto Nascimento - Planned Midia" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body suppressHydrationWarning={true}>
        <ClientOnly>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ClientOnly>
      </body>
    </html>
  );
}
