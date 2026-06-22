import "./globals.css"
import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "CSV Pro - Desktop CSV Editor & Analytics",
  description: "Ultra-fast, local-first, memory-safe desktop CSV editor powered by Rust and React",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body className="overflow-hidden bg-zinc-950 text-zinc-100">
        {children}
      </body>
    </html>
  )
}
