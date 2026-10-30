import React, { useEffect, useMemo, useState } from 'react';
import type { AccessLevel, Permission, Role, Ticket, TicketStatus, User, Ward } from './types/grievance';
import { roles as initialRoles, tickets as initialTickets, wards as initialWards } from './data/mockData';

export interface ActivityEvent {
  id: number;
  userId: string | null;
  ticketId: string | null;
  grievanceId?: string;
  actorName?: string;
  type: string;
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
}

interface NotificationItem {
  id: string;
  module: string;
  summary: string;
  createdAt: string;
}

type ActiveView = 'dashboard' | 'grievances' | 'users' | 'roles' | 'activity_feed' | 'audit' | 'wards';
type ModalKind = 'role' | 'user' | 'profile' | 'settings' | 'audit-details' | null;

const noAccessRole: Role = {
  id: 'ROLE-NO-ACCESS',
  name: 'No access',
  description: '',
  permissions: [],
  scopeType: 'WARD',
  wardIds: [],
  isSystem: true,
};

const permissionCatalog: readonly [Permission, string][] = [
  ['tickets:read', 'Read grievance tickets in assigned scope'],
  ['tickets:resolve', 'Resolve grievances & submit action reports'],
  ['tickets:reroute', 'Reroute cases and change triage statuses'],
  ['users:manage', 'Manage staff accounts and permissions'],
  ['analytics:view', 'View jurisdiction analytics & audit records'],
];

const permissionsByAccessLevel: Record<AccessLevel, Permission[]> = {
  SUPER_ADMIN: ['tickets:read', 'tickets:resolve', 'tickets:reroute', 'users:manage', 'analytics:view'],
  DIVISION_ADMIN: ['tickets:read', 'tickets:resolve', 'tickets:reroute', 'analytics:view'],
  L1_RESOLVING_OFFICER: ['tickets:read', 'tickets:resolve', 'tickets:reroute'],
  APPELLATE_AUTHORITY: ['tickets:read', 'tickets:resolve', 'analytics:view'],
  OTHER_CASE_TRIAGE: ['tickets:read', 'tickets:reroute'],
};

function persisted<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value));
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const tabToken = sessionStorage.getItem('mha-tab-session');
  const response = await fetch(path, {
    ...init,
    credentials: 'omit',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(tabToken ? { Authorization: `Bearer ${tabToken}` } : {}),
      ...init.headers,
    },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status}).`);
  return result as T;
}

function friendlyStatus(status: TicketStatus) {
  return status === 'PENDING' ? 'Pending' : status === 'UNDER_INVESTIGATION' ? 'In progress' : 'Resolved';
}

function categoryLabel(category: Ticket['category']) {
  return (
    ({
      CYBERCRIME: 'Cybercrime',
      IMMIGRATION: 'Immigration',
      DISASTER_RELIEF: 'Disaster relief',
      UT_ADMIN: 'UT administration',
      FREEDOM_FIGHTERS_REHABILITATION: 'Freedom fighters',
      CAPF_MISCONDUCT: 'CAPF conduct',
      FCRA_NGO: 'NGO / FCRA',
      INTERNAL_SECURITY: 'Internal security',
      COUNTER_TERRORISM: 'Counter terrorism',
      LWE_NORTH_EAST: 'LWE / North East',
      BORDER_MANAGEMENT: 'Border management',
      JUDICIAL: 'Judicial',
      POLICE: 'Police',
      CENTRE_STATE: 'Centre–State',
      INTERNAL_DIVISIONS: 'Internal divisions',
      OTHER: 'Other department triage',
    } as const)[category] || category
  );
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
}

function prettyKey(key: string) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (l) => l.toUpperCase())
    .replace('Ifsc', 'IFSC')
    .replace('Utr', 'UTR')
    .replace('Aadhaar', 'Aadhaar');
}

export default function App() {
  const [roles, setRoles] = useState<Role[]>(initialRoles);
  const [users, setUsers] = useState<User[]>([]);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [wardList, setWardList] = useState(initialWards);
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [sessionUser, setSessionUser] = useState<User | null>(null);
  const [sessionRole, setSessionRole] = useState<Role | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [needsInitialAdmin, setNeedsInitialAdmin] = useState(false);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [credentialNotice, setCredentialNotice] = useState<{ name: string; email: string; password: string } | null>(null);

  // Active view navigation
  const [activeView, setActiveView] = useState<ActiveView>('dashboard');
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalKind>(null);
  const [activeAuditDetail, setActiveAuditDetail] = useState<ActivityEvent | null>(null);
  const [toast, setToast] = useState('');
  const [showBackToTop, setShowBackToTop] = useState(false);

  // Masthead menus
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [notificationMenuOpen, setNotificationMenuOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);

  // Filters & Search
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [divisionFilter, setDivisionFilter] = useState('ALL');
  const [auditFilter, setAuditFilter] = useState('ALL');

  // Role Management State
  const [selectedRoleId, setSelectedRoleId] = useState('');
  const [selectedRoleDepartment, setSelectedRoleDepartment] = useState('CYBER_INFORMATION_SECURITY');
  const [roleName, setRoleName] = useState('');
  const [roleAccessLevel, setRoleAccessLevel] = useState<AccessLevel>('DIVISION_ADMIN');
  const [rolePermissions, setRolePermissions] = useState<Permission[]>([]);

  // Accessibility Font scale
  const [fontScale, setFontScale] = useState<number>(() => Math.min(1.25, Math.max(1, persisted('mha-font-scale', 1))));

  const isSuperAdmin = sessionUser?.roleId === 'ROLE-SUPER-ADMIN';
  const activeRole = sessionRole ?? roles.find((r) => r.id === sessionUser?.roleId) ?? noAccessRole;
  const activeWards = activeRole.wardIds?.length
    ? (sessionUser?.assignedWards ?? []).filter((id) => activeRole.wardIds?.includes(id))
    : sessionUser?.assignedWards ?? [];
  const hasTicketRead = activeRole.permissions.includes('tickets:read');

  // Scroll listener for back-to-top button
  useEffect(() => {
    const handleScroll = () => {
      const scrollTop = Math.max(window.scrollY, document.documentElement.scrollTop, document.body.scrollTop);
      setShowBackToTop(scrollTop > 240);
    };
    window.addEventListener('scroll', handleScroll);
    document.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('scroll', handleScroll);
      document.removeEventListener('scroll', handleScroll, true);
    };
  }, []);

  const scrollPageToTop = () => {
    const targets = new Set<HTMLElement>();
    if (document.scrollingElement instanceof HTMLElement) targets.add(document.scrollingElement);
    targets.add(document.documentElement);
    targets.add(document.body);
    const root = document.getElementById('root');
    if (root) targets.add(root);
    let node = document.querySelector('.masthead') as HTMLElement | null;
    while (node) {
      targets.add(node);
      node = node.parentElement;
    }
    targets.forEach((target) => { target.scrollTop = 0; target.scrollLeft = 0; });
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    document.querySelector('.masthead')?.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
  };

  // Hydrate data
  const hydrate = async () => {
    try {
      const data = await api<{
        user: User;
        role: Role;
        tickets: Ticket[];
        roles: Role[];
        users: User[];
        wards: typeof initialWards;
        activities?: ActivityEvent[];
      }>('/api/bootstrap');
      setSessionUser(data.user);
      setSessionRole(data.role);
      setTickets(data.tickets);
      setRoles(data.roles);
      setUsers(data.users || []);
      setWardList(data.wards || initialWards);
      if (data.activities) setActivities(data.activities);
      if (data.user.roleId === 'ROLE-SUPER-ADMIN') {
        setActiveView('users');
      } else {
        setActiveView('dashboard');
      }
    } catch {
      // Fallback
    }
  };

  useEffect(() => {
    let active = true;
    Promise.all([api<{ user: User; role: Role }>('/api/auth/me'), api<{ needsInitialAdmin: boolean }>('/api/auth/setup-status')])
      .then(async ([, setup]) => {
        if (!active) return;
        setNeedsInitialAdmin(setup.needsInitialAdmin);
        await hydrate();
      })
      .catch(async () => {
        try {
          const setup = await api<{ needsInitialAdmin: boolean }>('/api/auth/setup-status');
          if (active) setNeedsInitialAdmin(setup.needsInitialAdmin);
        } catch {}
      })
      .finally(() => {
        if (active) setAuthReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    save('mha-font-scale', fontScale);
    document.documentElement.style.setProperty('--font-scale', String(fontScale));
  }, [fontScale]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Sync role editor when selected role changes
  const roleDepartments = [
    { id: 'CYBER_INFORMATION_SECURITY', name: 'Cyber & Information Security', divisions: ['CYBER_INFORMATION_SECURITY'] },
    { id: 'FOREIGNERS', name: 'Foreigners & Immigration', divisions: ['FOREIGNERS'] },
    { id: 'DISASTER_MANAGEMENT', name: 'Disaster Management (NDRF & Relief)', divisions: ['DISASTER_MANAGEMENT'] },
    { id: 'CAPF_POLICE', name: 'CAPF & Police', divisions: ['CENTRAL_ARMED_POLICE_FORCES', 'POLICE'] },
    { id: 'NGO_FCRA', name: 'FCRA & NGO', divisions: ['NGO_FCRA'] },
    { id: 'UT_ADMINISTRATION', name: 'Union Territory Administration', divisions: ['UT_ADMINISTRATION'] },
    { id: 'FREEDOM_FIGHTERS_REHABILITATION', name: 'Freedom Fighters & Rehabilitation', divisions: ['FREEDOM_FIGHTERS_REHABILITATION'] },
    { id: 'CTCR_INTERNAL_SECURITY', name: 'CTCR & Internal Security', divisions: ['COUNTER_TERRORISM', 'INTERNAL_SECURITY', 'LWE_NORTH_EAST'] },
    { id: 'OTHER_TRIAGE', name: 'Other Cases Triage', divisions: ['OTHER_TRIAGE'] },
    { id: 'NATIONAL_WARD', name: 'National / Ward Operations', divisions: [] },
    { id: 'OTHER_DIVISIONS', name: 'Other MHA Divisions', divisions: ['BORDER_MANAGEMENT', 'JUDICIAL', 'CENTRE_STATE', 'INTERNAL_ADMINISTRATION'] },
  ];
  const activeDepartment = roleDepartments.find((department) => department.id === selectedRoleDepartment) ?? roleDepartments[0];
  const departmentRoles = roles.filter((role) => activeDepartment.divisions.length
    ? activeDepartment.divisions.includes(role.divisionId ?? '')
    : !role.divisionId);
  const currentRole = departmentRoles.find((role) => role.id === selectedRoleId) ?? departmentRoles[0] ?? roles[0];
  const availableRolePermissions = permissionsByAccessLevel[roleAccessLevel];
  useEffect(() => {
    if (currentRole) {
      setRoleName(currentRole.name);
      const level = currentRole.accessLevel ?? (currentRole.scopeType === 'WARD' ? 'L1_RESOLVING_OFFICER' : 'DIVISION_ADMIN');
      setRoleAccessLevel(level);
      setRolePermissions(currentRole.permissions.filter((permission) => permissionsByAccessLevel[level].includes(permission)));
    }
  }, [selectedRoleId, roles]);

  // Scoped tickets
  const allowedTickets = useMemo(() => {
    return tickets.filter((ticket) => {
      if (!activeRole.permissions.includes('tickets:read')) return false;
      if (activeRole.scopeType === 'DIVISION' && ticket.divisionId !== activeRole.divisionId) return false;
      if (activeRole.scopeType === 'WARD' && !activeWards.includes(ticket.wardId)) return false;
      return true;
    });
  }, [tickets, activeRole, activeWards]);

  // Filtered tickets
  const filteredTickets = useMemo(() => {
    return allowedTickets.filter((ticket) => {
      const q = query.trim().toLowerCase();
      const searchable = [ticket.grievanceId, ticket.complainantName, ticket.location.district, ticket.wardId, categoryLabel(ticket.category)].join(' ').toLowerCase();
      return (
        (!q || searchable.includes(q)) &&
        (statusFilter === 'ALL' || ticket.status === statusFilter) &&
        (divisionFilter === 'ALL' || ticket.divisionId === divisionFilter)
      );
    });
  }, [allowedTickets, query, statusFilter, divisionFilter]);

  const selectedTicket = tickets.find((t) => t.id === selectedTicketId) ?? null;

  // Actions
  const signIn = async (email: string, password: string) => {
    try {
      const result = await api<{ user: User; role: Role; mustChangePassword: boolean; token: string }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      sessionStorage.setItem('mha-tab-session', result.token);
      if (result.mustChangePassword) {
        setSessionUser(result.user);
        setSessionRole(result.role);
        setMustChangePassword(true);
        setLoginError('');
        return;
      }
      await hydrate();
      setLoginError('');
      setToast(`Welcome back, ${result.user.name}.`);
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : 'Could not sign in.');
    }
  };

  const signOut = async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } finally {
      sessionStorage.removeItem('mha-tab-session');
      setSessionUser(null);
      setSessionRole(null);
      setTickets([]);
      setWardList(initialWards);
      setSelectedTicketId(null);
      setModal(null);
      setAccountMenuOpen(false);
      setNotificationMenuOpen(false);
      setUsers([]);
      setRoles(initialRoles);
      setActiveView('dashboard');
    }
  };

  const changeOwnPassword = async (currentPassword: string, newPassword: string) => {
    try {
      await api('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setMustChangePassword(false);
      setModal(null);
      await hydrate();
      setToast('Password updated successfully.');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not update password.');
    }
  };

  const submitReport = async (id: string, status: TicketStatus, report: string) => {
    try {
      const saved = await api<Ticket>(`/api/tickets/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, actionTakenReport: report }),
      });
      setTickets((curr) => curr.map((t) => (t.id === id ? saved : t)));
      setToast(`Grievance ${saved.grievanceId} updated to ${friendlyStatus(status)}.`);
      setSelectedTicketId(null);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Failed to update grievance.');
    }
  };

  const routeOtherCase = async (id: string, divisionId: string) => {
    try {
      await api<Ticket>(`/api/tickets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ routeToDivisionId: divisionId }) });
      setTickets((current) => current.filter((ticket) => ticket.id !== id));
      setSelectedTicketId(null);
      setToast('Case analyzed and forwarded to the selected department.');
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not route this case.');
    }
  };

  const addUser = async (user: User) => {
    try {
      const saved = await api<User & { temporaryPassword?: string }>('/api/users', {
        method: 'POST',
        body: JSON.stringify(user),
      });
      setUsers((curr) => [...curr, saved]);
      setModal(null);
      setCredentialNotice({ name: saved.name, email: saved.email, password: saved.temporaryPassword ?? '' });
      setToast(`Account created for ${saved.name}.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Failed to create user.');
    }
  };

  const toggleUser = async (user: User) => {
    try {
      const saved = await api<User>(`/api/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !user.isActive }),
      });
      setUsers((curr) => curr.map((u) => (u.id === saved.id ? saved : u)));
      setToast(`${saved.name} is now ${saved.isActive ? 'Active' : 'Suspended'}.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Failed to toggle account.');
    }
  };

  const saveUserEdit = async (user: User) => {
    try {
      const saved = await api<User>(`/api/users/${encodeURIComponent(user.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: user.name, email: user.email, roleId: user.roleId, isActive: user.isActive, assignedWards: user.assignedWards }),
      });
      setUsers((current) => current.map((item) => item.id === saved.id ? saved : item));
      setEditingUser(null);
      setToast(`Account changes saved for ${saved.name}.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Could not save account changes.');
    }
  };

  const resetPassword = async (user: User) => {
    try {
      const result = await api<{ temporaryPassword: string }>(`/api/users/${encodeURIComponent(user.id)}/reset-password`, {
        method: 'POST',
      });
      setCredentialNotice({ name: user.name, email: user.email, password: result.temporaryPassword });
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Failed to reset password.');
    }
  };

  const addRole = async (newRole: Role) => {
    try {
      const saved = await api<Role>('/api/roles', {
        method: 'POST',
        body: JSON.stringify(newRole),
      });
      setRoles((curr) => [...curr, saved]);
      setSelectedRoleId(saved.id);
      setModal(null);
      setToast(`Role ${saved.name} created.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Failed to create role.');
    }
  };

  const cloneRole = async () => {
    if (!currentRole) return;
    const name = window.prompt(`Name for the copy of “${currentRole.name}”:`, `${currentRole.name} Copy`);
    if (!name?.trim()) return;
    await addRole({ ...currentRole, id: `ROLE-CUSTOM-${Date.now()}`, name: name.trim(), isSystem: false });
  };

  const updateRole = async () => {
    if (!currentRole) return;
    try {
      const saved = await api<Role>(`/api/roles/${encodeURIComponent(currentRole.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: roleName, description: currentRole.description, permissions: rolePermissions, accessLevel: roleAccessLevel }),
      });
      setRoles((curr) => curr.map((r) => (r.id === saved.id ? saved : r)));
      setToast(`Permissions updated for ${saved.name}.`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : 'Failed to save role permissions.');
    }
  };

  const downloadAuditCsv = () => {
    const headers = ['Timestamp', 'Actor', 'Event Type', 'Summary', 'Ticket ID'];
    const rows = activities.map((a) => [
      `"${a.createdAt}"`,
      `"${a.actorName ?? 'System'}"`,
      `"${a.type}"`,
      `"${a.summary.replace(/"/g, '""')}"`,
      `"${a.grievanceId ?? ''}"`,
    ]);
    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `mha-audit-log-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setToast('Audit CSV downloaded.');
  };

  // Loading state
  if (!authReady) {
    return (
      <main className="app-shell" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <p className="loading" style={{ font: '500 13px DM Mono, monospace' }}>
          Connecting to MHA Grievance service...
        </p>
      </main>
    );
  }

  // Sign in screen
  if (!sessionUser) {
    return (
      <SignInScreen
        setup={needsInitialAdmin}
        error={loginError}
        onSignIn={signIn}
        onClearError={() => setLoginError('')}
        onInitialAdmin={async (payload) => {
          try {
            await api('/api/auth/initial-admin', { method: 'POST', body: JSON.stringify(payload) });
            setNeedsInitialAdmin(false);
            setLoginError('Staff Admin account created. Sign in using your credentials.');
          } catch (err) {
            setLoginError(err instanceof Error ? err.message : 'Could not create Staff Admin.');
          }
        }}
      />
    );
  }

  // Navigation Items matching library admin portal
  const navigation: { id: ActiveView; label: string }[] = isSuperAdmin
    ? [
        { id: 'users', label: 'Staff accounts' },
        { id: 'roles', label: 'Roles & permissions' },
      ]
    : [
        { id: 'dashboard', label: 'Operations Dashboard' },
        { id: 'grievances', label: 'Grievance inbox' },
        { id: 'activity_feed', label: 'Activity feed' },
        ...(activeRole.permissions.includes('analytics:view') ? [{ id: 'audit' as ActiveView, label: 'Audit log' }] : []),
        { id: 'wards', label: 'Ward directory' },
      ];

  const effectiveView: ActiveView = isSuperAdmin
    ? activeView === 'roles'
      ? 'roles'
      : 'users'
    : activeView === 'users' || activeView === 'roles'
    ? 'dashboard'
    : activeView;

  // Calculated 7-day intake activity from actual scoped tickets
  const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const today = new Date();
  const past7Days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() - (6 - i));
    return {
      dateStr: d.toISOString().slice(0, 10),
      label: dayLabels[d.getDay()],
    };
  });
  const weeklyActivity = past7Days.map(({ dateStr, label }) => {
    const count = allowedTickets.filter((t) => t.submissionTimestamp.slice(0, 10) === dateStr).length;
    return { label, count };
  });
  const maxWeekly = Math.max(1, ...weeklyActivity.map((w) => w.count));

  return (
    <div className="app-shell" onClick={() => { setAccountMenuOpen(false); setNotificationMenuOpen(false); }}>
      {/* Top Masthead - Exact Clone of Library App Admin Masthead */}
      <header className="masthead" onClick={(e) => e.stopPropagation()}>
        <div className="brand">
          <div className="brand-mark">MHA</div>
          <div>
            <p className="brand-title">MINISTRY OF HOME AFFAIRS</p>
            <p className="brand-subtitle">Grievance Operations &amp; Management</p>
          </div>
        </div>
        <div className="user-block">
          <div className="live-badge" id="live-indicator">
            <span className="live-dot" /> Connected to service
          </div>
          <div className="header-account-name">{sessionUser.name}</div>

          {/* Account menu toggle */}
          <div className="account-menu">
            <button
              className="account-menu-toggle"
              type="button"
              aria-label="Open user menu"
              aria-expanded={accountMenuOpen}
              onClick={() => {
                setAccountMenuOpen(!accountMenuOpen);
                setNotificationMenuOpen(false);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 21a8 8 0 0 0-16 0" />
                <circle cx="12" cy="8" r="4" />
              </svg>
            </button>
            <div className="account-dropdown" hidden={!accountMenuOpen}>
              <button
                type="button"
                onClick={() => {
                  setAccountMenuOpen(false);
                  setModal('profile');
                }}
              >
                Profile
              </button>
              <button
                type="button"
                onClick={() => {
                  setAccountMenuOpen(false);
                  setModal('settings');
                }}
              >
                Settings
              </button>
              <button type="button" className="account-logout" onClick={signOut}>
                Log out
              </button>
            </div>
          </div>

          {/* Notification Menu */}
          <div className="notification-menu">
            <button
              className={`notification-toggle ${notifications.length > 0 ? 'has-notifications' : ''}`}
              type="button"
              aria-label="Notifications"
              aria-expanded={notificationMenuOpen}
              onClick={() => {
                setNotificationMenuOpen(!notificationMenuOpen);
                setAccountMenuOpen(false);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
                <path d="M10 21h4" />
              </svg>
              {notifications.length > 0 && <span className="notification-count">{notifications.length}</span>}
            </button>
            <div className="notification-dropdown" hidden={!notificationMenuOpen}>
              <div className="notification-dropdown-head">
                <strong>Notifications</strong>
                <span>{notifications.length} updates</span>
              </div>
              {notifications.length > 0 ? (
                notifications.map((n) => (
                  <article className="notification-item" key={n.id}>
                    <div className="notification-item-top">
                      <span className="status">{n.module}</span>
                      <button
                        type="button"
                        aria-label="Remove"
                        onClick={() => setNotifications((curr) => curr.filter((item) => item.id !== n.id))}
                      >
                        ×
                      </button>
                    </div>
                    <div className="notification-open">
                      <span>{n.summary}</span>
                      <span className="notification-time">{new Date(n.createdAt).toLocaleTimeString('en-IN')}</span>
                    </div>
                  </article>
                ))
              ) : (
                <div className="notification-empty">No unread notifications.</div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Main Page Area */}
      <main className="page">
        <div className="page-heading">
          <div>
            <p className="eyebrow">{isSuperAdmin ? 'MHA / ACCESS MANAGEMENT' : 'MHA / GRIEVANCE PORTAL'}</p>
            <h1>
              {isSuperAdmin
                ? 'Access management'
                : effectiveView === 'dashboard'
                ? 'Grievance command center'
                : effectiveView === 'grievances'
                ? 'Grievance triage queue'
                : effectiveView === 'activity_feed'
                ? 'Activity stream'
                : effectiveView === 'audit'
                ? 'Audit record log'
                : 'Ward jurisdictions'}
            </h1>
            <p className="heading-note">
              {isSuperAdmin
                ? 'Manage staff users and role permissions.'
                : `Active jurisdiction: ${activeRole.name} · ${activeRole.scopeType} scope.`}
            </p>
          </div>
        </div>

        {/* Two-column layout with left numbered side navigation */}
        <div className="layout">
          <nav className="side-nav" aria-label="Administration">
            {navigation.map((item, index) => (
              <button
                key={item.id}
                className={`nav-button ${effectiveView === item.id ? 'active' : ''}`}
                onClick={() => setActiveView(item.id)}
              >
                <span className="nav-glyph">{String(index + 1).padStart(2, '0')}</span>
                {item.label}
              </button>
            ))}
          </nav>

          <section className="content" id="view-content" aria-live="polite">
            {/* VIEW: DASHBOARD (STAFF / OFFICERS ONLY) */}
            {!isSuperAdmin && effectiveView === 'dashboard' && (
              <div>
                <div className="section-head">
                  <div>
                    <h2>Grievance Operations Dashboard</h2>
                    <p>Live grievance metrics, SLA status distribution, and 7-day intake volume.</p>
                  </div>
                  <button className="button button-quiet button-small" onClick={() => { hydrate(); setToast('Dashboard metrics refreshed.'); }}>
                    ↻ Refresh
                  </button>
                </div>

                <div className="stat-grid">
                  <div className="stat-card">
                    <p className="eyebrow">Catalog Grievances</p>
                    <div className="stat-val">{allowedTickets.length}</div>
                    <div className="stat-sub">Across active jurisdiction scope</div>
                  </div>
                  <div className="stat-card">
                    <p className="eyebrow">Awaiting Action</p>
                    <div className="stat-val">{allowedTickets.filter((t) => t.status !== 'RESOLVED').length}</div>
                    <div className="stat-sub">Pending or under active investigation</div>
                  </div>
                  <div className="stat-card">
                    <p className="eyebrow">SLA At Risk</p>
                    <div className="stat-val">{allowedTickets.filter((t) => t.slaStatus !== 'ON_TIME' && t.status !== 'RESOLVED').length}</div>
                    <div className="stat-sub">Approaching deadline or overdue</div>
                  </div>
                  <div className="stat-card">
                    <p className="eyebrow">Resolved Cases</p>
                    <div className="stat-val">{allowedTickets.filter((t) => t.status === 'RESOLVED').length}</div>
                    <div className="stat-sub">Closed with official action reports</div>
                  </div>
                </div>

                {/* 7-Day Chart Panel */}
                <div className="panel">
                  <div className="panel-head">
                    <h3>Grievance Intake Volume (Past 7 Days)</h3>
                    <span className="table-secondary">Daily intake activity</span>
                  </div>
                  <div className="panel-body">
                    <div className="chart-bars">
                      {weeklyActivity.map((w) => {
                        const pct = Math.round((w.count / maxWeekly) * 100);
                        return (
                          <div className="bar-col" key={w.label}>
                            <span className="bar-val">{w.count}</span>
                            <div className="bar-track">
                              <div className="bar-fill" style={{ height: `${Math.max(6, pct)}%` }} />
                            </div>
                            <span className="bar-label">{w.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>

                {/* Scope Jurisdiction Summary Panel */}
                <div className="panel" style={{ marginTop: '14px' }}>
                  <div className="panel-head">
                    <h3>Jurisdiction Coverage &amp; Response SLA</h3>
                    <span className="table-secondary">Target response within 21 days</span>
                  </div>
                  <div className="panel-body">
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '14px' }}>
                      <div style={{ padding: '12px', background: '#f8faf8', border: '1px solid var(--line)', borderRadius: '4px' }}>
                        <span className="eyebrow">SCOPE MODE</span>
                        <div style={{ fontSize: '13px', fontWeight: 800, color: 'var(--forest)', marginTop: '4px' }}>
                          {activeRole.scopeType} ACCESS
                        </div>
                        <div className="table-secondary" style={{ marginTop: '4px' }}>
                          {activeRole.scopeType === 'GLOBAL'
                            ? 'National oversight across all 15 MHA divisions'
                            : activeRole.scopeType === 'DIVISION'
                            ? `Division: ${activeRole.divisionId?.replaceAll('_', ' ')}`
                            : `Wards: ${activeWards.join(', ') || 'No wards'}`}
                        </div>
                      </div>
                      <div style={{ padding: '12px', background: '#f8faf8', border: '1px solid var(--line)', borderRadius: '4px' }}>
                        <span className="eyebrow">SLA HEALTH ON TRACK</span>
                        <div style={{ fontSize: '13px', fontWeight: 800, color: '#287a5f', marginTop: '4px' }}>
                          {allowedTickets.length ? Math.round((allowedTickets.filter((t) => t.slaStatus === 'ON_TIME').length / allowedTickets.length) * 100) : 100}%
                        </div>
                        <div className="table-secondary" style={{ marginTop: '4px' }}>
                          {allowedTickets.filter((t) => t.slaStatus === 'ON_TIME').length} of {allowedTickets.length} cases on time
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* VIEW: GRIEVANCE INBOX (STAFF / OFFICERS ONLY) */}
            {!isSuperAdmin && effectiveView === 'grievances' && (
              <div>
                <div className="section-head">
                  <div>
                    <h2>Grievance Triage Queue</h2>
                    <p>Review, investigate, and record official resolutions for citizen complaints.</p>
                  </div>
                  <button className="button button-quiet button-small" onClick={() => { hydrate(); setToast('Queue refreshed.'); }}>
                    ↻ Refresh
                  </button>
                </div>

                {!hasTicketRead ? (
                  <div className="notice error">Your active role does not have Read access to the grievance queue.</div>
                ) : (
                  <div className="panel">
                    <div className="panel-head">
                      <h3>Active Grievance Cases</h3>
                      <span className="table-secondary">{filteredTickets.length} cases</span>
                    </div>
                    <div className="panel-body">
                      <div className="toolbar" style={{ marginBottom: '14px' }}>
                        <input
                          className="input search-input"
                          placeholder="Search grievance ID, citizen, ward, district..."
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                        <select
                          className="select"
                          style={{ width: '150px' }}
                          value={statusFilter}
                          onChange={(e) => setStatusFilter(e.target.value)}
                        >
                          <option value="ALL">All Status</option>
                          <option value="PENDING">Pending</option>
                          <option value="UNDER_INVESTIGATION">In progress</option>
                          <option value="RESOLVED">Resolved</option>
                        </select>
                        <select
                          className="select"
                          style={{ width: '180px' }}
                          value={divisionFilter}
                          onChange={(e) => setDivisionFilter(e.target.value)}
                        >
                          <option value="ALL">All Divisions</option>
                          {[...new Set(allowedTickets.map((t) => t.divisionId))].map((div) => (
                            <option key={div} value={div}>
                              {div.replaceAll('_', ' ')}
                            </option>
                          ))}
                        </select>
                        <button className="button button-quiet button-small" onClick={cloneRole}>Clone</button>
                        {(query || statusFilter !== 'ALL' || divisionFilter !== 'ALL') && (
                          <button
                            className="button button-quiet button-small"
                            onClick={() => {
                              setQuery('');
                              setStatusFilter('ALL');
                              setDivisionFilter('ALL');
                            }}
                          >
                            Reset filters
                          </button>
                        )}
                      </div>

                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Grievance ID</th>
                              <th>Citizen / Language</th>
                              <th>Ward / District</th>
                              <th>Category</th>
                              <th>SLA Status</th>
                              <th>Status</th>
                              <th>Action</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredTickets.map((ticket) => (
                              <tr key={ticket.id} onClick={() => setSelectedTicketId(ticket.id)} style={{ cursor: 'pointer' }}>
                                <td>
                                  <span className="table-primary" style={{ color: 'var(--forest)' }}>
                                    {ticket.grievanceId}
                                  </span>
                                  <span className="table-secondary">{formatDate(ticket.submissionTimestamp)}</span>
                                </td>
                                <td>
                                  <span className="table-primary">{ticket.complainantName}</span>
                                  <span className="table-secondary">{ticket.detectedLanguage}</span>
                                </td>
                                <td>
                                  <span className="table-primary">{ticket.wardId.replace('WARD-', 'Ward ')}</span>
                                  <span className="table-secondary">{ticket.location.district}</span>
                                </td>
                                <td>
                                  <span className="category-pill">{categoryLabel(ticket.category)}</span>
                                </td>
                                <td>
                                  <span
                                    className={`sla-badge ${
                                      ticket.status === 'RESOLVED'
                                        ? 'sla-ontime'
                                        : ticket.slaStatus === 'OVERDUE'
                                        ? 'sla-overdue'
                                        : ticket.slaStatus === 'WARNING'
                                        ? 'sla-warning'
                                        : 'sla-ontime'
                                    }`}
                                  >
                                    <i />
                                    {ticket.status === 'RESOLVED' ? 'CLOSED' : ticket.slaStatus.replace('_', ' ')}
                                  </span>
                                </td>
                                <td>
                                  <span
                                    className={`status ${
                                      ticket.status === 'RESOLVED'
                                        ? 'status-resolved'
                                        : ticket.status === 'UNDER_INVESTIGATION'
                                        ? 'status-under_investigation'
                                        : 'status-pending'
                                    }`}
                                  >
                                    {friendlyStatus(ticket.status)}
                                  </span>
                                </td>
                                <td>
                                  <button
                                    className="button button-quiet button-small"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedTicketId(ticket.id);
                                    }}
                                  >
                                    Review →
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {filteredTickets.length === 0 && <div className="empty">No matching grievances in your scope.</div>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* VIEW: STAFF ACCOUNTS (SUPER ADMIN ONLY) */}
            {effectiveView === 'users' && isSuperAdmin && (
              <div>
                <div className="section-head">
                  <div>
                    <h2>Staff Accounts</h2>
                    <p>Create staff access, manage role assignments, and revoke active sessions.</p>
                  </div>
                  <button className="button button-primary button-small" onClick={() => setModal('user')}>
                    + Add Staff
                  </button>
                </div>

                <div className="panel">
                  <div className="panel-head">
                    <h3>Staff Directory</h3>
                    <span className="table-secondary">{users.length} accounts</span>
                  </div>
                  <div className="panel-body">
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Staff Member</th>
                            <th>Role</th>
                            <th>Scope / Wards</th>
                            <th>Status</th>
                            <th>Last Sign-In</th>
                            <th>Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {users.map((person) => (
                            <tr key={person.id}>
                              <td>
                                <span className="table-primary">{person.name}</span>
                                <span className="table-secondary">{person.email}</span>
                              </td>
                              <td>{roles.find((r) => r.id === person.roleId)?.name ?? 'No role'}</td>
                              <td>{person.assignedWards.length ? person.assignedWards.join(', ') : 'Role default'}</td>
                              <td>
                                <span className={`status ${person.isActive ? 'status-approved' : 'inactive'}`}>
                                  {person.isActive ? 'Active' : 'Suspended'}
                                </span>
                              </td>
                              <td>
                                {person.lastSignIn ? new Date(person.lastSignIn).toLocaleString('en-IN') : 'Never'}
                              </td>
                              <td>
                                <div className="row-actions">
                                  {person.roleId === 'ROLE-SUPER-ADMIN' ? (
                                    <span className="table-secondary">Protected account</span>
                                  ) : (
                                    <>
                                      <button className="button button-quiet button-small" onClick={() => setEditingUser(person)}>
                                        Edit
                                      </button>
                                      <button className="button button-quiet button-small" onClick={() => resetPassword(person)}>
                                        Reset password
                                      </button>
                                      <button
                                        className={`button ${person.isActive ? 'button-danger' : 'button-quiet'} button-small`}
                                        disabled={person.id === sessionUser.id}
                                        onClick={() => toggleUser(person)}
                                      >
                                        {person.isActive ? 'Suspend' : 'Reactivate'}
                                      </button>
                                      <button className="button button-danger button-small" onClick={() => setToast('Account removal is not available yet.')}>
                                        Remove
                                      </button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* VIEW: ROLES & PERMISSIONS (SUPER ADMIN ONLY) */}
            {effectiveView === 'roles' && isSuperAdmin && (
              <div>
                <div className="section-head">
                  <div>
                    <h2>Roles &amp; Permissions</h2>
                    <p>Define custom officer roles, scope boundaries, and action permissions.</p>
                  </div>
                  <button className="button button-primary button-small" onClick={() => setModal('role')}>
                    + New Role
                  </button>
                </div>

                <div className="panel">
                  <div className="panel-head">
                    <h3>Role Settings &amp; Permissions Matrix</h3>
                    <span className="table-secondary">{roles.length} roles configured</span>
                  </div>
                  <div className="panel-body">
                    <div className="role-settings-card">
                      <div className="role-settings-toolbar">
                        <strong>Select Department &amp; Role</strong>
                        <select
                          className="select"
                          id="role-department-select"
                          value={selectedRoleDepartment}
                          onChange={(event) => {
                            const nextDepartment = roleDepartments.find((department) => department.id === event.target.value)!;
                            const nextRoles = roles.filter((role) => nextDepartment.divisions.length
                              ? nextDepartment.divisions.includes(role.divisionId ?? '')
                              : !role.divisionId);
                            setSelectedRoleDepartment(event.target.value);
                            setSelectedRoleId(nextRoles[0]?.id ?? '');
                          }}
                        >
                          {roleDepartments.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}
                        </select>
                        <select
                          className="select"
                          id="role-name-select"
                          value={currentRole?.id ?? ''}
                          onChange={(e) => setSelectedRoleId(e.target.value)}
                        >
                          {departmentRoles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name} · {r.accessLevel ?? (r.scopeType === 'WARD' ? 'L1_RESOLVING_OFFICER' : 'DIVISION_ADMIN')}
                            </option>
                          ))}
                        </select>
                      </div>

                      {currentRole && (
                        <>
                          <div className="role-editor">
                            <div className="field">
                              <label>Role name</label>
                              <input
                                className="input"
                                value={roleName}
                                onChange={(e) => setRoleName(e.target.value)}
                              />
                            </div>
                            <div className="role-scope-summary">
                              Scope:{' '}
                              <strong>
                                {currentRole.scopeType}
                                {currentRole.divisionId ? ` · ${currentRole.divisionId.replaceAll('_', ' ')}` : ''}
                                {currentRole.wardIds?.length ? ` · ${currentRole.wardIds.join(', ')}` : ''}
                              </strong>
                            </div>
                            <label className="field">
                              <span>Vertical access level</span>
                              <select className="select" value={roleAccessLevel} onChange={(event) => {
                                const nextLevel = event.target.value as AccessLevel;
                                if (nextLevel === 'SUPER_ADMIN' && currentRole.id !== 'ROLE-SUPER-ADMIN') {
                                  setToast('Super Admin access is reserved for the protected Staff Admin role.');
                                  return;
                                }
                                setRoleAccessLevel(nextLevel);
                                const nextAvailable = permissionsByAccessLevel[nextLevel];
                                setRolePermissions((current) => current.filter((permission) => nextAvailable.includes(permission)));
                              }}>
                                {currentRole.id === 'ROLE-SUPER-ADMIN'
                                  ? <option value="SUPER_ADMIN">Super Admin</option>
                                  : currentRole.scopeType === 'WARD'
                                  ? <option value="L1_RESOLVING_OFFICER">L1 Resolving Officer</option>
                                  : <>
                                      <option value="DIVISION_ADMIN">Division Admin</option>
                                      <option value="APPELLATE_AUTHORITY">Appellate Authority</option>
                                      {currentRole.divisionId === 'OTHER_TRIAGE' && <option value="OTHER_CASE_TRIAGE">Other Case Triage Officer</option>}
                                    </>}
                              </select>
                            </label>
                          </div>

                          <div className="permission-matrix">
                            <div className="permission-matrix-head">
                              <span>Permission Module</span>
                              <span>Access Granted</span>
                            </div>
                            {permissionCatalog.filter(([permission]) => availableRolePermissions.includes(permission)).map(([perm, label]) => (
                              <label className="permission-matrix-row" key={perm}>
                                <span>{label}</span>
                                <input
                                  type="checkbox"
                                  checked={rolePermissions.includes(perm)}
                                  onChange={() =>
                                    setRolePermissions((curr) =>
                                      curr.includes(perm) ? curr.filter((p) => p !== perm) : [...curr, perm]
                                    )
                                  }
                                />
                              </label>
                            ))}
                          </div>
                          <p className="table-secondary" style={{ margin: '8px 0 0' }}>
                            Permission modules are limited by this role’s access level. Department or ward scope still determines which cases the role can access.
                          </p>

                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span className="table-secondary">
                              {currentRole.isSystem
                                ? 'System role. Staff Admin can edit this role and its permissions.'
                                : `${rolePermissions.length} permissions enabled.`}
                            </span>
                            <button className="button button-primary" onClick={updateRole}>
                              Save permissions
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Available Roles Panel */}
                <div className="panel" style={{ marginTop: '14px' }}>
                  <div className="panel-head">
                    <h3>Available roles</h3>
                    <span className="table-secondary">{departmentRoles.length} roles</span>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>NAME</th>
                          <th>TYPE</th>
                          <th>ASSIGNED USERS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {departmentRoles.map((role) => (
                          <tr
                            key={role.id}
                            onClick={() => {
                              setSelectedRoleId(role.id);
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                            style={{ cursor: 'pointer' }}
                          >
                            <td>
                              <span className="table-primary">{role.name}</span>
                            </td>
                            <td>
                              <span className="status">
                                {role.isSystem ? 'System' : 'Custom'}
                              </span>
                            </td>
                            <td>{users.filter((u) => u.roleId === role.id).length}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* VIEW: ACTIVITY FEED (STAFF / OFFICERS ONLY) */}
            {!isSuperAdmin && effectiveView === 'activity_feed' && (
              <div>
                <div className="section-head">
                  <div>
                    <h2>Recent Operations &amp; Activity Feed</h2>
                    <p>Live stream of administrative actions, intake submissions, and case updates.</p>
                  </div>
                  <button className="button button-quiet button-small" onClick={() => { hydrate(); setToast('Activity feed refreshed.'); }}>
                    ↻ Refresh
                  </button>
                </div>

                <div className="panel">
                  <div className="panel-head">
                    <h3>Activity Stream</h3>
                    <span className="table-secondary">{activities.length} events</span>
                  </div>
                  <div className="panel-body">
                    <div className="activity-list">
                      {activities.map((a) => (
                        <div className="activity-item" key={a.id}>
                          <div>
                            <span className="activity-title">{a.summary}</span>
                            <div className="activity-meta">
                              <span>{a.actorName ?? 'System'}</span> &middot;{' '}
                              <span className="status" style={{ fontSize: '9px', padding: '2px 5px' }}>
                                {a.type}
                              </span>{' '}
                              &middot; <span>{new Date(a.createdAt).toLocaleString('en-IN')}</span>
                            </div>
                          </div>
                          {a.details && Object.keys(a.details).length > 0 && (
                            <button
                              className="button button-quiet button-small"
                              onClick={() => {
                                setActiveAuditDetail(a);
                                setModal('audit-details');
                              }}
                            >
                              Inspect
                            </button>
                          )}
                        </div>
                      ))}
                      {activities.length === 0 && <div className="empty">No recent activity logged.</div>}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* VIEW: AUDIT LOG (STAFF / OFFICERS ONLY) */}
            {!isSuperAdmin && effectiveView === 'audit' && (
              <div>
                <div className="section-head">
                  <div>
                    <h2>Audit Log</h2>
                    <p>Immutable, append-only record of all administrative operations, logins, and case updates.</p>
                  </div>
                  <div className="toolbar">
                    <button className="button button-quiet button-small" onClick={downloadAuditCsv}>
                      Export Audit CSV
                    </button>
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-head">
                    <h3>Audit Records</h3>
                    <span className="table-secondary">{activities.length} entries</span>
                  </div>
                  <div className="panel-body">
                    <div className="toolbar" style={{ marginBottom: '14px' }}>
                      <select
                        className="select"
                        style={{ width: '180px' }}
                        value={auditFilter}
                        onChange={(e) => setAuditFilter(e.target.value)}
                      >
                        <option value="ALL">All Event Types</option>
                        {[...new Set(activities.map((a) => a.type))].map((type) => (
                          <option key={type} value={type}>
                            {type}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Timestamp</th>
                            <th>Actor</th>
                            <th>Event Type</th>
                            <th>Summary</th>
                            <th>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activities
                            .filter((a) => auditFilter === 'ALL' || a.type === auditFilter)
                            .map((a) => (
                              <tr key={a.id}>
                                <td style={{ fontFamily: 'DM Mono, monospace', fontSize: '10px' }}>
                                  {new Date(a.createdAt).toLocaleString('en-IN')}
                                </td>
                                <td>
                                  <strong>{a.actorName ?? 'System'}</strong>
                                </td>
                                <td>
                                  <span className="status">{a.type}</span>
                                </td>
                                <td>{a.summary}</td>
                                <td>
                                  <button
                                    className="button button-quiet button-small"
                                    onClick={() => {
                                      setActiveAuditDetail(a);
                                      setModal('audit-details');
                                    }}
                                  >
                                    View JSON
                                  </button>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* VIEW: WARD DIRECTORY (STAFF / OFFICERS ONLY) */}
            {!isSuperAdmin && effectiveView === 'wards' && (
              <div>
                <div className="section-head">
                  <div>
                    <h2>Ward Directory &amp; Jurisdictions</h2>
                    <p>Designated operational wards and jurisdictional districts across India.</p>
                  </div>
                </div>

                <div className="ward-grid">
                  {wardList.map((ward) => (
                    <div className="ward-card" key={ward.id}>
                      <div className="ward-card-head">
                        <span className="eyebrow">{ward.id}</span>
                        <span className="status">{ward.zone ?? 'Central Zone'}</span>
                      </div>
                      <h3>{ward.name}</h3>
                      <div className="ward-card-meta">
                        {ward.district}, {ward.state} &middot; Pincode {ward.pincodePrefix}XXX
                      </div>
                      <div className="table-secondary" style={{ marginTop: '6px' }}>
                        Active complaints:{' '}
                        <strong>{tickets.filter((t) => t.wardId === ward.id).length}</strong>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      </main>

      {/* Case Details Drawer */}
      {selectedTicket && (
        <>
          <button className="drawer-scrim" onClick={() => setSelectedTicketId(null)} aria-label="Close" />
          <TicketDrawer
            ticket={selectedTicket}
            role={activeRole}
            onClose={() => setSelectedTicketId(null)}
            onSubmit={submitReport}
            onRoute={routeOtherCase}
          />
        </>
      )}

      {/* Modal: Add Staff */}
      {editingUser && (
        <div className="dialog-backdrop" onClick={() => setEditingUser(null)}>
          <div className="dialog" onClick={(event) => event.stopPropagation()}>
            <div className="dialog-head">
              <h2>Edit staff account</h2>
              <button type="button" className="button button-quiet button-small" onClick={() => setEditingUser(null)}>Close</button>
            </div>
            <EditStaffForm user={editingUser} roles={roles} wards={wardList} onClose={() => setEditingUser(null)} onSave={saveUserEdit} />
          </div>
        </div>
      )}
      {modal === 'user' && (
        <div className="dialog-backdrop">
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <h2>Onboard Staff Member</h2>
              <button type="button" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            <AddStaffForm
              roles={roles}
              wards={wardList}
              onClose={() => setModal(null)}
              onSubmit={addUser}
            />
          </div>
        </div>
      )}

      {/* Modal: New Role */}
      {modal === 'role' && (
        <div className="dialog-backdrop" onClick={() => setModal(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <h2>Create Department Role</h2>
              <button type="button" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            <NewRoleForm
              wards={wardList}
              onClose={() => setModal(null)}
              onSubmit={addRole}
            />
          </div>
        </div>
      )}

      {/* Modal: Profile */}
      {modal === 'profile' && (
        <div className="dialog-backdrop" onClick={() => setModal(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <h2>User Profile</h2>
              <button type="button" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            <div className="profile-details">
              <div className="profile-detail-row">
                <span className="field-label">Full Name</span>
                <strong className="profile-detail-value">{sessionUser.name}</strong>
              </div>
              <div className="profile-detail-row">
                <span className="field-label">Department Email</span>
                <strong className="profile-detail-value">{sessionUser.email}</strong>
              </div>
              <div className="profile-detail-row">
                <span className="field-label">Contact Phone</span>
                <strong className="profile-detail-value">{sessionUser.mobileNumber}</strong>
              </div>
              <div className="profile-detail-row">
                <span className="field-label">Assigned Role</span>
                <strong className="profile-detail-value">{activeRole.name}</strong>
              </div>
              <div className="profile-detail-row">
                <span className="field-label">Jurisdiction Scope</span>
                <strong className="profile-detail-value">
                  {activeRole.scopeType} {activeRole.divisionId ? `· ${activeRole.divisionId.replaceAll('_', ' ')}` : ''}
                </strong>
              </div>
            </div>
            <div className="dialog-actions">
              <button className="button button-quiet" onClick={() => setModal(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Settings */}
      {modal === 'settings' && (
        <div className="dialog-backdrop" onClick={() => setModal(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <h2>Account Settings</h2>
              <button type="button" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            <div className="dialog-body">
              <SettingsDialog
                onChangePassword={changeOwnPassword}
              />
            </div>
          </div>
        </div>
      )}

      {/* Modal: Audit Event JSON Details */}
      {modal === 'audit-details' && activeAuditDetail && (
        <div className="dialog-backdrop" onClick={() => setModal(null)}>
          <div className="dialog" style={{ width: '600px' }} onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <h2>Audit Event Details</h2>
              <button type="button" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            <div className="dialog-body">
              <pre
                style={{
                  background: '#f8faf8',
                  padding: '14px',
                  borderRadius: '4px',
                  border: '1px solid var(--line)',
                  fontSize: '11px',
                  fontFamily: 'DM Mono, monospace',
                  overflow: 'auto',
                  maxHeight: '340px',
                }}
              >
                {JSON.stringify(activeAuditDetail, null, 2)}
              </pre>
            </div>
            <div className="dialog-actions">
              <button className="button button-quiet" onClick={() => setModal(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Credential Notification Modal */}
      {credentialNotice && (
        <div className="dialog-backdrop">
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <h2>One-Time Account Credentials</h2>
            </div>
            <div className="dialog-body">
              <p className="table-secondary">
                Share these credentials with {credentialNotice.name}. The temporary password is shown only once.
              </p>
              <div className="field">
                <label>Department Email</label>
                <div className="credential">{credentialNotice.email}</div>
              </div>
              <div className="field">
                <label>Temporary Password</label>
                <div className="credential">{credentialNotice.password}</div>
              </div>
            </div>
            <div className="dialog-actions">
              <button
                className="button button-quiet"
                onClick={async () => {
                  await navigator.clipboard.writeText(
                    `Email: ${credentialNotice.email}\nTemporary password: ${credentialNotice.password}`
                  );
                  setToast('Credentials copied to clipboard.');
                }}
              >
                Copy credentials
              </button>
              <button className="button button-primary" onClick={() => setCredentialNotice(null)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Must Change Password Forced Modal */}
      {mustChangePassword && (
        <div className="dialog-backdrop">
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <h2>Security Required: Change Password</h2>
            </div>
            <div className="dialog-body">
              <p className="notice">You must change your temporary password before accessing the workspace.</p>
              <MustChangePasswordForm onSave={changeOwnPassword} onSignOut={signOut} />
            </div>
          </div>
        </div>
      )}

      {/* Toast Notification */}
      <div id="toast" className={`toast ${toast ? 'visible' : ''}`}>
        {toast}
      </div>

      {/* Back to top floating button */}
      <button
        id="back-to-top"
        className="back-to-top"
        type="button"
        hidden={!showBackToTop}
        onClick={scrollPageToTop}
      >
        ↑ <span>Top</span>
      </button>
    </div>
  );
}

/* =========================================================
   COMPONENTS
========================================================= */

function SignInScreen({
  setup,
  error,
  onSignIn,
  onClearError,
  onInitialAdmin,
}: {
  setup: boolean;
  error: string;
  onSignIn: (email: string, password: string) => void;
  onClearError: () => void;
  onInitialAdmin: (p: { name: string; email: string; mobileNumber: string; password: string }) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (setup) {
      if (password !== confirmPassword) {
        onClearError();
        return;
      }
      onInitialAdmin({ name, email, mobileNumber, password });
    } else {
      onSignIn(email, password);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-aside">
        <div className="brand">
          <div className="brand-mark">MHA</div>
          <div>
            <p className="brand-title">MINISTRY OF HOME AFFAIRS</p>
            <p className="brand-subtitle">Grievance Operations &amp; Management</p>
          </div>
        </div>
        <div>
          <h1>Grievance operations, in one place.</h1>
          <p>
            Unified dashboard for multilingual citizen grievance intake, jurisdictional triage, officer action reports,
            and department-wide SLA accountability.
          </p>
        </div>
        <div className="login-aside-foot">GOVERNMENT OF INDIA &middot; INTERNAL MHA SERVICE</div>
      </div>

      <div className="login-main">
        <form className="login-form" onSubmit={handleSubmit}>
          <div>
            <h2>{setup ? 'Initial Administrator Setup' : 'Staff Sign In'}</h2>
            <p>{setup ? 'Create the first Staff Admin account.' : 'Access your authorized grievance desk.'}</p>
          </div>

          {error && <div className="notice error">{error}</div>}

          {setup && (
            <>
              <label>
                Full name
                <input
                  className="input"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Administrator Sharma"
                />
              </label>
              <label>
                Mobile number
                <input
                  className="input"
                  required
                  value={mobileNumber}
                  onChange={(e) => setMobileNumber(e.target.value)}
                  placeholder="+91 98765 43210"
                />
              </label>
            </>
          )}

          <label>
            Department email / Login ID
            <input
              className="input"
              type="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                onClearError();
              }}
              placeholder="officer@mha.gov.in"
            />
          </label>

          <label>
            Password
            <div className="password-input-wrap">
              <input
                className="input"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={setup ? 8 : undefined}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  onClearError();
                }}
                placeholder={setup ? 'At least 8 characters' : 'Enter password'}
              />
              <button
                type="button"
                className="password-toggle-btn"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </label>

          {setup && (
            <label>
              Confirm password
              <input
                className="input"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
          )}

          <button className="button button-primary" type="submit" style={{ marginTop: '6px' }}>
            {setup ? 'Create Administrator Account' : 'Sign in to Workspace'}
          </button>
        </form>
      </div>
    </div>
  );
}

function TicketDrawer({
  ticket,
  role,
  onClose,
  onSubmit,
  onRoute,
}: {
  ticket: Ticket;
  role: Role;
  onClose: () => void;
  onSubmit: (id: string, status: TicketStatus, report: string) => void;
  onRoute: (id: string, divisionId: string) => void;
}) {
  const [status, setStatus] = useState<TicketStatus>(ticket.status);
  const [report, setReport] = useState(ticket.actionTakenReport ?? '');
  const [tab, setTab] = useState<'context' | 'timeline'>('context');
  const [routeDivision, setRouteDivision] = useState('CYBER_INFORMATION_SECURITY');
  const canTriageOther = role.accessLevel === 'OTHER_CASE_TRIAGE' && ticket.category === 'OTHER';

  const canAct = role.permissions.includes('tickets:resolve') || role.permissions.includes('tickets:reroute');
  const details = Object.entries(ticket.details ?? {}).map(([key, value]) => ({
    label: prettyKey(key),
    value:
      typeof value === 'object' && value !== null
        ? Object.entries(value as Record<string, string>)
            .map(([k, v]) => `${prettyKey(k)}: ${v}`)
            .join(' · ')
        : String(value),
  }));

  return (
    <aside className="ticket-drawer">
      <header className="drawer-header">
        <div>
          <span className="drawer-kicker">Grievance Case File</span>
          <h2>{ticket.grievanceId}</h2>
          <span className="drawer-subtitle">
            Submitted {formatDate(ticket.submissionTimestamp)} &middot; {ticket.location.district}, {ticket.location.state}
          </span>
        </div>
        <button className="close-drawer" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>

      <div className="drawer-person">
        <div className="drawer-avatar">
          {ticket.complainantName
            .split(' ')
            .map((p) => p[0])
            .slice(0, 2)
            .join('')}
        </div>
        <div className="drawer-person-info">
          <b>{ticket.complainantName}</b>
          <span>
            {ticket.mobileNumber} <i>&middot;</i> Pincode {ticket.location.pincode}
          </span>
        </div>
        <span
          className={`status ${
            ticket.status === 'RESOLVED'
              ? 'status-resolved'
              : ticket.status === 'UNDER_INVESTIGATION'
              ? 'status-under_investigation'
              : 'status-pending'
          }`}
        >
          {friendlyStatus(ticket.status)}
        </span>
      </div>

      <div className="drawer-tabs">
        <button className={tab === 'context' ? 'selected' : ''} onClick={() => setTab('context')}>
          Citizen Context
        </button>
        <button className={tab === 'timeline' ? 'selected' : ''} onClick={() => setTab('timeline')}>
          Case Timeline
        </button>
      </div>

      {tab === 'context' ? (
        <div className="drawer-body">
          <div className="case-tags">
            <span className="category-pill">{categoryLabel(ticket.category)}</span>
            <span className="language-pill">Language: {ticket.detectedLanguage}</span>
          </div>

          <div className="detail-section">
            <div className="section-title">
              <b>Original Voice Complaint</b>
              <span>Illustrative audio recording</span>
            </div>
            <div className="audio-player">
              <button
                className="play-button"
                onClick={() => {
                  const audio = document.getElementById(`audio-${ticket.id}`) as HTMLAudioElement | null;
                  if (audio) void audio.play();
                }}
              >
                ▶
              </button>
              <div className="audio-track">
                <div className="audio-wave">
                  {Array.from({ length: 44 }, (_, i) => (
                    <i key={i} style={{ height: `${4 + ((i * 13 + 7) % 18)}px` }} />
                  ))}
                </div>
                <div className="audio-meta">
                  <span>Demo voice clip &middot; 0:03</span>
                  <span>WAV</span>
                </div>
              </div>
              <audio id={`audio-${ticket.id}`} src={ticket.audioFileUrl} preload="none" />
            </div>
          </div>

          <div className="detail-section">
            <div className="section-title">
              <b>Complaint Transcript</b>
              <span>Multilingual transcription &amp; translation</span>
            </div>
            <div className="transcript-grid">
              <div className="transcript-box">
                <div>
                  <span>ORIGINAL ({ticket.detectedLanguage.toUpperCase()})</span>
                  <button title="Copy" onClick={() => void navigator.clipboard?.writeText(ticket.originalRegionalText)}>
                    Copy
                  </button>
                </div>
                <p>{ticket.originalRegionalText}</p>
              </div>
              <div className="transcript-box english">
                <div>
                  <span>ENGLISH TRANSLATION</span>
                  <button title="Copy" onClick={() => void navigator.clipboard?.writeText(ticket.translatedEnglishText)}>
                    Copy
                  </button>
                </div>
                <p>{ticket.translatedEnglishText}</p>
              </div>
            </div>
          </div>

          <div className="detail-section">
            <div className="section-title">
              <b>Incident Attributes</b>
              <span>Category-specific metadata</span>
            </div>
            <div className="details-grid">
              {details.map((d) => (
                <div className="detail-field" key={d.label}>
                  <span>{d.label}</span>
                  <b>{d.value}</b>
                </div>
              ))}
            </div>
          </div>

          <div className="detail-section">
            <div className="section-title">
              <b>Reported Location</b>
              <span>{ticket.wardId.replace('WARD-', 'Ward ')}</span>
            </div>
            <div className="location-card">
              <div>
                <b>{ticket.location.completeAddress}</b>
                <span>
                  {ticket.location.district}, {ticket.location.state} &middot; {ticket.location.pincode}
                </span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="timeline-body">
          <div className="timeline-entry">
            <span className="timeline-dot blue" />
            <div>
              <b>Grievance Received</b>
              <span>{new Date(ticket.submissionTimestamp).toLocaleString('en-IN')}</span>
              <p>Submitted via citizen multilingual voice intake in {ticket.detectedLanguage}.</p>
            </div>
          </div>
          <div className="timeline-entry">
            <span className="timeline-dot amber" />
            <div>
              <b>Assigned to {ticket.divisionId.replaceAll('_', ' ')}</b>
              <span>
                {ticket.wardId} &middot; {ticket.location.district}
              </span>
              <p>Routed automatically based on category and jurisdictional boundary.</p>
            </div>
          </div>
          {ticket.actionTakenReport && (
            <div className="timeline-entry">
              <span className="timeline-dot green" />
              <div>
                <b>Action Report Filed</b>
                <span>Recorded official resolution</span>
                <p>{ticket.actionTakenReport}</p>
              </div>
            </div>
          )}
        </div>
      )}

      <footer className="action-desk">
        <div className="action-desk-title">
          <b>{canTriageOther ? 'Other Case Triage Desk' : 'Official Action Desk'}</b>
          <span>{canTriageOther ? 'Review the complaint and forward it to the correct MHA department.' : 'Record resolution findings'}</span>
        </div>
        {canTriageOther && <>
          <label>FORWARD TO DEPARTMENT
            <select className="select" value={routeDivision} onChange={(event) => setRouteDivision(event.target.value)}>
              {([
                ['CYBER_INFORMATION_SECURITY','Cyber & Information Security'],['FOREIGNERS','Foreigners & Immigration'],['DISASTER_MANAGEMENT','Disaster Management'],['CENTRAL_ARMED_POLICE_FORCES','CAPF & Police'],['NGO_FCRA','FCRA & NGO'],['UT_ADMINISTRATION','UT Administration'],['FREEDOM_FIGHTERS_REHABILITATION','Freedom Fighters & Rehabilitation'],['COUNTER_TERRORISM','Counter Terrorism & Internal Security'],
              ] as const).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </select>
          </label>
          <button className="button button-primary" onClick={() => onRoute(ticket.id, routeDivision)}>Forward case</button>
        </>}
        <label>
          CASE STATUS
          <select
            className="select"
            value={status}
            disabled={!canAct || canTriageOther}
            onChange={(e) => setStatus(e.target.value as TicketStatus)}
          >
            <option value="PENDING">Pending</option>
            <option value="UNDER_INVESTIGATION">Under investigation</option>
            <option value="RESOLVED">Resolved</option>
          </select>
        </label>
        <label>
          ACTION TAKEN REPORT (ENGLISH)
          <textarea
            className="input"
            rows={3}
            disabled={!canAct || canTriageOther}
            value={report}
            placeholder="Document investigation findings, dispatched orders, or citizen resolution..."
            onChange={(e) => setReport(e.target.value)}
          />
        </label>
        <button
          className="button button-primary"
          disabled={!canAct || canTriageOther || !report.trim()}
          onClick={() => onSubmit(ticket.id, status, report.trim())}
        >
          Submit Resolution
        </button>
      </footer>
    </aside>
  );
}

function EditStaffForm({ user, roles, wards, onClose, onSave }: { user: User; roles: Role[]; wards: Ward[]; onClose: () => void; onSave: (user: User) => void }) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [roleId, setRoleId] = useState(user.roleId);
  const [isActive, setIsActive] = useState(user.isActive);
  const [assignedWards, setAssignedWards] = useState(user.assignedWards);
  const roleDepartments = Array.from(new Set(roles.filter((role) => role.id !== 'ROLE-SUPER-ADMIN' && role.divisionId).map((role) => role.divisionId!)));
  const currentRole = roles.find((role) => role.id === roleId);
  const [departmentId, setDepartmentId] = useState(currentRole?.divisionId ?? 'WARD_OPERATIONS');
  const departmentRoles = roles.filter((role) => role.id !== 'ROLE-SUPER-ADMIN' && (departmentId === 'WARD_OPERATIONS' ? !role.divisionId : role.divisionId === departmentId));
  const updateRole = (nextRoleId: string) => {
    const nextRole = roles.find((role) => role.id === nextRoleId);
    setRoleId(nextRoleId);
    setAssignedWards((current) => nextRole?.scopeType !== 'WARD' ? [] : nextRole.wardIds?.length ? current.filter((wardId) => nextRole.wardIds?.includes(wardId)) : current);
  };
  return <form onSubmit={(event) => { event.preventDefault(); onSave({ ...user, name: name.trim(), email: email.trim(), roleId, isActive, assignedWards: currentRole?.scopeType === 'WARD' ? assignedWards : [] }); }}>
    <div className="dialog-body">
      <label className="field"><span className="field-label">Full name</span><input className="input" required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label className="field"><span className="field-label">Login ID / Department email</span><input className="input" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label className="field"><span className="field-label">Department</span><select className="select" value={departmentId} onChange={(event) => { const nextDepartment = event.target.value; setDepartmentId(nextDepartment); const firstRole = roles.find((role) => role.id !== 'ROLE-SUPER-ADMIN' && (nextDepartment === 'WARD_OPERATIONS' ? !role.divisionId : role.divisionId === nextDepartment)); if (firstRole) updateRole(firstRole.id); }}><option value="WARD_OPERATIONS">National / Ward Operations</option>{roleDepartments.map((divisionId) => <option key={divisionId} value={divisionId}>{divisionId === 'OTHER_TRIAGE' ? 'Other Cases Triage' : divisionId.replaceAll('_', ' ')}</option>)}</select></label>
      <label className="field"><span className="field-label">Role</span><select className="select" value={roleId} onChange={(event) => updateRole(event.target.value)}>{departmentRoles.map((role) => <option key={role.id} value={role.id}>{role.name} · {role.accessLevel ?? role.scopeType}</option>)}</select></label>
      {currentRole?.scopeType === 'WARD' && <div className="field"><span className="field-label">Assigned wards</span><div className="ward-assignment-list">{wards.filter((ward) => !currentRole.wardIds?.length || currentRole.wardIds.includes(ward.id)).map((ward) => <label key={ward.id}><input type="checkbox" checked={assignedWards.includes(ward.id)} onChange={(event) => setAssignedWards((current) => event.target.checked ? [...current, ward.id] : current.filter((id) => id !== ward.id))} /><span>{ward.id} · {ward.name}</span></label>)}</div></div>}
      <label className="toolbar"><input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} /> <span className="field-label">Account active</span></label>
    </div>
    <div className="dialog-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary">Save changes</button></div>
  </form>;
}

function AddStaffForm({
  roles,
  wards,
  onClose,
  onSubmit,
}: {
  roles: Role[];
  wards: Ward[];
  onClose: () => void;
  onSubmit: (u: User) => void;
}) {
  const staffRoles = roles.filter((role) => role.id !== 'ROLE-SUPER-ADMIN');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [roleId, setRoleId] = useState(staffRoles[0]?.id ?? '');
  const [selectedWards, setSelectedWards] = useState<string[]>([]);
  const [departmentId, setDepartmentId] = useState(staffRoles.find((role) => role.id === (staffRoles[0]?.id ?? ''))?.divisionId ?? 'WARD_OPERATIONS');

  const pickedRole = staffRoles.find((r) => r.id === roleId);
  const roleDepartments = Array.from(new Set(staffRoles.filter((role) => role.divisionId).map((role) => role.divisionId!)));
  const departmentRoles = staffRoles.filter((role) => departmentId === 'WARD_OPERATIONS' ? !role.divisionId : role.divisionId === departmentId);
  const updateStaffRole = (nextRoleId: string) => {
    const nextRole = staffRoles.find((role) => role.id === nextRoleId);
    setRoleId(nextRoleId);
    setSelectedWards((current) => nextRole?.scopeType !== 'WARD' ? [] : nextRole.wardIds?.length ? current.filter((wardId) => nextRole.wardIds?.includes(wardId)) : current);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !phone.trim() || !pickedRole) return;
    onSubmit({
      id: `USER-${Date.now()}`,
      name: name.trim(),
      email: email.trim(),
      mobileNumber: phone.trim(),
      roleId,
      assignedWards: pickedRole.scopeType === 'WARD' ? selectedWards : [],
      isActive: true,
      avatarInitials: name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((v) => v[0])
        .join('')
        .toUpperCase(),
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="dialog-body">
        <label className="field">
          <span className="field-label">OFFICER FULL NAME</span>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Full Name" />
        </label>
        <label className="field">
          <span className="field-label">DEPARTMENT EMAIL</span>
          <input
            className="input"
            type="email"
            required
            pattern="[^@\s]+@[^@\s]+\.[^@\s]+"
            title="Enter a complete email address, such as officer@mha.gov.in"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="officer@mha.gov.in"
          />
        </label>
        <label className="field">
          <span className="field-label">MOBILE PHONE NUMBER</span>
          <input
            className="input"
            required
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+91 98765 43210"
          />
        </label>
        <label className="field">
          <span className="field-label">DEPARTMENT</span>
          <select className="select" value={departmentId} onChange={(event) => {
            const nextDepartment = event.target.value;
            setDepartmentId(nextDepartment);
            const firstRole = staffRoles.find((role) => nextDepartment === 'WARD_OPERATIONS' ? !role.divisionId : role.divisionId === nextDepartment);
            if (firstRole) updateStaffRole(firstRole.id);
          }}>
            <option value="WARD_OPERATIONS">National / Ward Operations</option>
            {roleDepartments.map((divisionId) => <option key={divisionId} value={divisionId}>{divisionId === 'OTHER_TRIAGE' ? 'Other Cases Triage' : divisionId.replaceAll('_', ' ')}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">ASSIGNED ROLE</span>
          <select className="select" value={roleId} onChange={(e) => updateStaffRole(e.target.value)}>
            {departmentRoles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} &middot; {r.scopeType}
              </option>
            ))}
          </select>
        </label>

        {pickedRole?.scopeType === 'WARD' && (
          <div className="field">
            <span className="field-label">ASSIGNED WARDS</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', maxHeight: '140px', overflow: 'auto' }}>
              {wards.filter((ward) => !pickedRole.wardIds?.length || pickedRole.wardIds.includes(ward.id)).map((ward) => (
                <label key={ward.id} style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px' }}>
                  <input
                    type="checkbox"
                    checked={selectedWards.includes(ward.id)}
                    onChange={(e) =>
                      setSelectedWards(
                        e.target.checked ? [...selectedWards, ward.id] : selectedWards.filter((w) => w !== ward.id)
                      )
                    }
                  />
                  <span>
                    {ward.id} &middot; {ward.name}
                  </span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="dialog-actions">
        <button type="button" className="button button-quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="button button-primary">
          + Add Staff
        </button>
      </div>
    </form>
  );
}

function NewRoleForm({
  wards,
  onClose,
  onSubmit,
}: {
  wards: Ward[];
  onClose: () => void;
  onSubmit: (r: Role) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<Role['scopeType']>('WARD');
  const [division, setDivision] = useState<Role['divisionId']>('CYBER_INFORMATION_SECURITY');
  const [accessLevel, setAccessLevel] = useState<AccessLevel>('L1_RESOLVING_OFFICER');
  const [perms, setPerms] = useState<Permission[]>(['tickets:read']);
  const [selectedWards, setSelectedWards] = useState<string[]>([]);
  const grantablePermissions = permissionsByAccessLevel[accessLevel];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit({
      id: `ROLE-CUSTOM-${Date.now()}`,
      name: name.trim(),
      description: description.trim() || 'Custom department role.',
      permissions: perms,
      scopeType: scope,
      accessLevel,
      ...(division ? { divisionId: division } : {}),
      ...(scope === 'WARD' ? { wardIds: selectedWards } : {}),
      isSystem: false,
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <div className="dialog-body">
        <label className="field">
          <span className="field-label">ROLE NAME</span>
          <input className="input" required value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Cyber Response Officer" />
        </label>
        <label className="field">
          <span className="field-label">DESCRIPTION</span>
          <input
            className="input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Operational responsibilities"
          />
        </label>
        <label className="field">
          <span className="field-label">JURISDICTION SCOPE</span>
          <select className="select" value={scope} onChange={(e) => { const nextScope = e.target.value as Role['scopeType']; if (division === 'OTHER_TRIAGE' && nextScope !== 'DIVISION') return; setScope(nextScope); if (nextScope === 'WARD' && accessLevel !== 'L1_RESOLVING_OFFICER') setAccessLevel('L1_RESOLVING_OFFICER'); if (nextScope === 'DIVISION' && accessLevel === 'L1_RESOLVING_OFFICER') setAccessLevel('DIVISION_ADMIN'); }}>
            <option value="DIVISION">DIVISION (Single MHA division)</option>
            <option value="WARD" disabled={division === 'OTHER_TRIAGE'}>WARD (Assigned ward list)</option>
          </select>
        </label>

        <label className="field">
          <span className="field-label">VERTICAL ACCESS LEVEL</span>
          <select className="select" value={accessLevel} onChange={(event) => {
            const nextLevel = event.target.value as AccessLevel;
            setAccessLevel(nextLevel);
            const allowed = permissionsByAccessLevel[nextLevel];
            setPerms((current) => current.filter((permission) => allowed.includes(permission)));
            setScope(nextLevel === 'L1_RESOLVING_OFFICER' ? 'WARD' : 'DIVISION');
            if (nextLevel === 'OTHER_CASE_TRIAGE') setDivision('OTHER_TRIAGE');
          }}>
            <option value="DIVISION_ADMIN">Division Admin</option>
            <option value="L1_RESOLVING_OFFICER">L1 Resolving Officer</option>
            <option value="APPELLATE_AUTHORITY">Appellate Authority</option>
            {scope === 'DIVISION' && division === 'OTHER_TRIAGE' && <option value="OTHER_CASE_TRIAGE">Other Case Triage Officer</option>}
          </select>
        </label>

        {scope !== 'GLOBAL' && (
          <label className="field">
            <span className="field-label">{scope === 'WARD' ? 'MHA DEPARTMENT (OPTIONAL)' : 'MHA DIVISION'}</span>
            <select className="select" value={division} onChange={(e) => { const nextDivision = e.target.value as Role['divisionId']; setDivision(nextDivision); if (nextDivision === 'OTHER_TRIAGE') { setScope('DIVISION'); setAccessLevel('OTHER_CASE_TRIAGE'); setPerms((current) => current.filter((permission) => permissionsByAccessLevel.OTHER_CASE_TRIAGE.includes(permission))); } else if (accessLevel === 'OTHER_CASE_TRIAGE') { setAccessLevel('DIVISION_ADMIN'); setPerms((current) => current.filter((permission) => permissionsByAccessLevel.DIVISION_ADMIN.includes(permission))); } }}>
              {scope === 'WARD' && <option value="">All departments</option>}
              {[
                'CYBER_INFORMATION_SECURITY',
                'FOREIGNERS',
                'DISASTER_MANAGEMENT',
                'UT_ADMINISTRATION',
                'FREEDOM_FIGHTERS_REHABILITATION',
                'CENTRAL_ARMED_POLICE_FORCES',
                'NGO_FCRA',
                'INTERNAL_SECURITY',
                'COUNTER_TERRORISM',
                'LWE_NORTH_EAST',
                'BORDER_MANAGEMENT',
                'JUDICIAL',
                'POLICE',
                'CENTRE_STATE',
                'INTERNAL_ADMINISTRATION',
                'OTHER_TRIAGE',
              ].map((d) => (
                <option key={d} value={d}>
                  {d.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
        )}

        {scope === 'WARD' && (
          <div className="field">
            <span className="field-label">WARD JURISDICTION</span>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', maxHeight: '130px', overflow: 'auto' }}>
              {wards.map((ward) => (
                <label key={ward.id} style={{ display: 'flex', gap: '6px', alignItems: 'center', fontSize: '11px' }}>
                  <input
                    type="checkbox"
                    checked={selectedWards.includes(ward.id)}
                    onChange={(e) =>
                      setSelectedWards(
                        e.target.checked ? [...selectedWards, ward.id] : selectedWards.filter((w) => w !== ward.id)
                      )
                    }
                  />
                  <span>{ward.id} &middot; {ward.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="field">
          <span className="field-label">PERMISSIONS</span>
          <div style={{ display: 'grid', gap: '6px' }}>
            {permissionCatalog.filter(([permission]) => grantablePermissions.includes(permission)).map(([perm, label]) => (
              <label key={perm} style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '11px' }}>
                <input
                  type="checkbox"
                  checked={perms.includes(perm)}
                  onChange={() =>
                    setPerms((curr) => (curr.includes(perm) ? curr.filter((p) => p !== perm) : [...curr, perm]))
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="dialog-actions">
        <button type="button" className="button button-quiet" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="button button-primary">
          Create Role
        </button>
      </div>
    </form>
  );
}

function SettingsDialog({
  onChangePassword,
}: {
  onChangePassword: (c: string, n: string) => void;
}) {
  const [current, setCurrent] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirm, setConfirm] = useState('');

  return (
    <div style={{ display: 'grid', gap: '16px' }}>
      <div>
        <span className="eyebrow">CHANGE PASSWORD</span>
        <form
          style={{ display: 'grid', gap: '10px', marginTop: '8px' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (newPass === confirm) onChangePassword(current, newPass);
          }}
        >
          <label className="field">
            <span className="field-label">CURRENT PASSWORD</span>
            <input
              className="input"
              type="password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">NEW PASSWORD (MIN 8 CHARACTERS)</span>
            <input
              className="input"
              type="password"
              required
              minLength={8}
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">CONFIRM NEW PASSWORD</span>
            <input
              className="input"
              type="password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </label>
          {confirm && newPass !== confirm && <div className="notice error">Passwords do not match.</div>}
          <button className="button button-primary" type="submit" disabled={newPass !== confirm || newPass.length < 8}>
            Update Password
          </button>
        </form>
      </div>
    </div>
  );
}

function MustChangePasswordForm({
  onSave,
  onSignOut,
}: {
  onSave: (c: string, n: string) => void;
  onSignOut: () => void;
}) {
  const [curr, setCurr] = useState('');
  const [next, setNext] = useState('');
  const [conf, setConf] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (next === conf) onSave(curr, next);
      }}
      style={{ display: 'grid', gap: '10px' }}
    >
      <label className="field">
        <span className="field-label">TEMPORARY PASSWORD</span>
        <input className="input" type="password" required value={curr} onChange={(e) => setCurr(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">NEW PASSWORD (AT LEAST 8 CHARACTERS)</span>
        <input
          className="input"
          type="password"
          required
          minLength={8}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">CONFIRM NEW PASSWORD</span>
        <input
          className="input"
          type="password"
          required
          minLength={8}
          value={conf}
          onChange={(e) => setConf(e.target.value)}
        />
      </label>
      <div className="dialog-actions" style={{ padding: '10px 0 0' }}>
        <button type="button" className="button button-quiet" onClick={onSignOut}>
          Sign Out
        </button>
        <button type="submit" className="button button-primary" disabled={next !== conf || next.length < 8}>
          Save New Password
        </button>
      </div>
    </form>
  );
}
