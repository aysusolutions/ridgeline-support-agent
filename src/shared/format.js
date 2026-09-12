export const usd = cents => `$${(cents / 100).toFixed(2)}`

export const day = iso => new Date(iso).toLocaleDateString('en-US', {
  month: 'long', day: 'numeric', timeZone: 'UTC',
})

export const maskEmail = (email) => {
  const [user, domain] = String(email).split('@')
  if (!domain) return '***'
  return `${user.slice(0, 1)}***@${domain}`
}
