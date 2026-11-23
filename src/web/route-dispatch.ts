export function extractApiPrefix(path: string): string {
  if (!path.startsWith('/api/')) return ''
  const slash = path.indexOf('/', 5)
  return slash === -1 ? path.slice(5) : path.slice(5, slash)
}
