import { useEffect, useState } from 'react'
import { useAuth0 } from '@auth0/auth0-react'
import { Users as UsersIcon, ShieldAlert } from 'lucide-react'

interface UsersProps {
  isAdmin: boolean
}

interface UserRow {
  user_id: string
  email?: string
  name?: string
  last_login?: string
  created_at?: string
  environmentIds?: string[]
}

export default function Users({ isAdmin }: UsersProps) {
  const { getAccessTokenSilently } = useAuth0()
  const [users, setUsers] = useState<UserRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteName, setInviteName] = useState('')
  const [inviteEnvironments, setInviteEnvironments] = useState<string[]>([])
  const [inviteLink, setInviteLink] = useState<string | null>(null)
  const [isInviting, setIsInviting] = useState(false)

  const environmentOptions = [
    { id: 'home', label: 'Home' },
    { id: 'office', label: 'Office' },
    { id: 'vacation', label: 'Vacation Home' },
  ]

  useEffect(() => {
    const loadUsers = async () => {
      if (!isAdmin) {
        setIsLoading(false)
        return
      }

      try {
        const token = await getAccessTokenSilently()
        const response = await fetch('/.netlify/functions/list-users', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })

        if (!response.ok) {
          throw new Error('Unable to load users')
        }

        const data = await response.json()
        setUsers(data.users ?? [])
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unable to load users')
      } finally {
        setIsLoading(false)
      }
    }

    void loadUsers()
  }, [getAccessTokenSilently, isAdmin])

  const handleInvite = async () => {
    if (!inviteEmail) {
      setError('Email is required to invite a user')
      return
    }

    setError(null)
    setInviteLink(null)
    setIsInviting(true)

    try {
      const token = await getAccessTokenSilently()
      const response = await fetch('/.netlify/functions/create-user', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: inviteEmail,
          name: inviteName,
          environmentIds: inviteEnvironments,
        }),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => null)
        throw new Error(data?.error || 'Unable to create user')
      }

      const data = await response.json()
      setInviteLink(data.inviteLink ?? null)
      setInviteEmail('')
      setInviteName('')
      setInviteEnvironments([])
      setUsers((prev) => [data.user, ...prev])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create user')
    } finally {
      setIsInviting(false)
    }
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-dark-1 via-brand-2 to-brand-1 p-4 md:p-8">
        <div className="max-w-4xl mx-auto">
          <div className="bg-light-2 bg-opacity-10 rounded-2xl p-8 backdrop-blur-sm text-center">
            <ShieldAlert className="w-10 h-10 text-yellow-300 mx-auto mb-4" />
            <h1 className="text-2xl font-heavy text-light-2 mb-2">Admin access required</h1>
            <p className="text-light-1">You don’t have permission to view users.</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-dark-1 via-brand-2 to-brand-1 p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <UsersIcon className="w-8 h-8 text-brand-2" />
          <div>
            <h1 className="text-3xl md:text-4xl font-heavy text-light-2">Users</h1>
            <p className="text-light-1">Manage and review portal accounts</p>
          </div>
        </div>

        <div className="bg-light-2 bg-opacity-95 rounded-2xl p-6 shadow-xl backdrop-blur-lg mb-6">
          <h2 className="text-xl font-heavy text-dark-1 mb-4">Invite user</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <input
              value={inviteName}
              onChange={(event) => setInviteName(event.target.value)}
              placeholder="Name (optional)"
              className="w-full rounded-lg border border-dark-2 border-opacity-20 px-3 py-2"
            />
            <input
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="Email"
              type="email"
              className="w-full rounded-lg border border-dark-2 border-opacity-20 px-3 py-2"
            />
            <div className="flex flex-wrap gap-2">
              {environmentOptions.map((env) => (
                <label key={env.id} className="flex items-center gap-2 text-sm text-dark-2">
                  <input
                    type="checkbox"
                    checked={inviteEnvironments.includes(env.id)}
                    onChange={(event) => {
                      setInviteEnvironments((prev) =>
                        event.target.checked
                          ? [...prev, env.id]
                          : prev.filter((id) => id !== env.id),
                      )
                    }}
                  />
                  {env.label}
                </label>
              ))}
            </div>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={handleInvite}
              disabled={isInviting}
              className="px-4 py-2 rounded-lg bg-brand-2 text-light-2 font-medium hover:bg-brand-3 transition-all disabled:opacity-60"
            >
              {isInviting ? 'Creating...' : 'Create user'}
            </button>
            {inviteLink && (
              <div className="text-sm text-dark-2">
                Invite link: <a href={inviteLink} className="text-brand-2 underline" target="_blank">Open</a>
              </div>
            )}
          </div>
        </div>

        <div className="bg-light-2 bg-opacity-95 rounded-2xl p-6 shadow-xl backdrop-blur-lg">
          {isLoading && <p className="text-dark-2">Loading users...</p>}
          {error && <p className="text-red-600">{error}</p>}
          {!isLoading && !error && users.length === 0 && (
            <p className="text-dark-2">No users found.</p>
          )}

          {!isLoading && !error && users.length > 0 && (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left">
                <thead>
                  <tr className="text-dark-2 text-sm">
                    <th className="py-2">Name</th>
                    <th className="py-2">Email</th>
                    <th className="py-2">Environments</th>
                    <th className="py-2">Last login</th>
                    <th className="py-2">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.user_id} className="border-t border-dark-2 border-opacity-10">
                      <td className="py-3 font-medium text-dark-1">{user.name ?? '—'}</td>
                      <td className="py-3 text-dark-1">{user.email ?? '—'}</td>
                      <td className="py-3 text-dark-2">
                        {user.environmentIds?.length
                          ? user.environmentIds.map((env) => environmentOptions.find((option) => option.id === env)?.label ?? env).join(', ')
                          : '—'}
                      </td>
                      <td className="py-3 text-dark-2">
                        {user.last_login ? new Date(user.last_login).toLocaleString() : '—'}
                      </td>
                      <td className="py-3 text-dark-2">
                        {user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
