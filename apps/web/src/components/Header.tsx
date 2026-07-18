import { Link } from '@tanstack/react-router'

export default function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-border bg-background/90 px-4 backdrop-blur-lg">
      <nav className="page-wrap flex items-center py-3 sm:py-4">
        <Link
          to="/"
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-semibold text-foreground no-underline sm:px-4 sm:py-2"
        >
          <span className="h-2 w-2 rounded-full bg-foreground" />
          dac-google meet
        </Link>
      </nav>
    </header>
  )
}
