import { NavLink, Outlet } from 'react-router-dom';
import { useGateway } from '@repo/ui';
import { useMediaQuery } from '../hooks/useMediaQuery.js';

type NavItem = {
  to: string;
  label: string;
  icon: string;
};

const mainNavItems: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: '\u229E' },
  { to: '/timeline', label: 'Timeline', icon: '\u2630' },
  { to: '/insights', label: 'Insights', icon: '\u25C9' },
  { to: '/simulation', label: 'Simulation', icon: '\u27F3' },
  { to: '/goals', label: 'Goals', icon: '\u25CE' },
];

const secondaryNavItems: NavItem[] = [
  { to: '/adapters', label: 'Adapters', icon: '\u26A1' },
  { to: '/settings', label: 'Settings', icon: '\u2699' },
];

function ConnectionIndicator({ connected }: { connected: boolean }) {
  const dotColor = connected ? 'bg-positive' : 'bg-negative';
  const statusText = connected ? 'Connected' : 'Disconnected';

  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <span className={`inline-block h-2 w-2 rounded-pill ${dotColor}`} />
      <span className="text-caption text-text-tertiary">{statusText}</span>
    </div>
  );
}

export function Layout() {
  const { connected } = useGateway();
  const isWide = useMediaQuery('(min-width: 1024px)');
  const collapsed = !isWide;

  return (
    <div className="flex h-screen overflow-hidden bg-surface">
      <aside
        className="flex flex-col border-r border-border bg-surface-raised"
        style={{ width: collapsed ? 64 : 240, minWidth: collapsed ? 64 : 240 }}
      >
        <div className="flex h-16 items-center px-4">
          <span className="text-title font-medium text-text-primary">
            {collapsed ? 'P' : 'PRE'}
          </span>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-2">
          {mainNavItems.map((item) => (
            <SidebarLink key={item.to} item={item} collapsed={collapsed} />
          ))}

          <div className="my-2 border-t border-border" />

          {secondaryNavItems.map((item) => (
            <SidebarLink key={item.to} item={item} collapsed={collapsed} />
          ))}
        </nav>

        <ConnectionIndicator connected={connected} />
      </aside>

      <main className="flex-1 overflow-y-auto p-8">
        <Outlet />
      </main>
    </div>
  );
}

function SidebarLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      className={({ isActive }) =>
        [
          'flex items-center gap-3 rounded px-3 py-2 text-body transition-colors',
          isActive
            ? 'border-l-[3px] border-accent bg-accent/5 text-accent'
            : 'border-l-[3px] border-transparent text-text-secondary hover:bg-surface-sunken hover:text-text-primary',
        ].join(' ')
      }
    >
      <span className="text-body">{item.icon}</span>
      {!collapsed && <span>{item.label}</span>}
    </NavLink>
  );
}
