import React from 'react';
import { Mail, Bell, Settings, CircleUserRound, Check } from 'lucide-react';
import { motion } from 'motion/react';
import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useWallet } from '@/lib/wallet';
import { getNotifications, getNotificationUnreadCount, getProfile, markAllNotificationsRead, markNotificationRead, type NotificationRecord, type ProfileResponse } from '@/lib/api';

export function TopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { address } = useWallet();
  const [profile, setProfile] = React.useState<ProfileResponse | null>(null);
  const [notifications, setNotifications] = React.useState<NotificationRecord[]>([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [notificationsOpen, setNotificationsOpen] = React.useState(false);

  React.useEffect(() => {
    if (!address) { setProfile(null); return; }
    const controller = new AbortController();
    getProfile(controller.signal).then(setProfile).catch(() => undefined);
    return () => controller.abort();
  }, [address]);

  React.useEffect(() => {
    if (!address) { setNotifications([]); setUnreadCount(0); return; }
    const controller = new AbortController();
    Promise.all([getNotifications(controller.signal), getNotificationUnreadCount(controller.signal)])
      .then(([list, count]) => { setNotifications(list.notifications); setUnreadCount(count.unreadCount); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [address]);

  // Rank is a Phase 7 (leaderboard) value; until then show the identity we
  // actually know rather than a made-up one.
  const identity = profile?.identity.displayName ?? (address ? `${address.slice(0, 5)}…${address.slice(-4)}` : 'Not connected');

  const navItems = [
    { label: 'Map', path: '/map' },
    { label: 'Characters', path: '/characters' },
    // The shop is how a player without an NFT gets one, so it sits in the top
    // nav rather than behind the empty-roster screen — a wallet holding nothing
    // is precisely the case that needs a way forward.
    { label: 'Shop', path: '/shop' },
    { label: 'Forge', path: '/forge' },
    { label: 'Inventory', path: '/inventory' },
    { label: 'Profile', path: '/profile' }
  ];

  return (
    <div className="absolute top-0 left-0 right-0 h-16 bg-obsidian/90 border-b border-stone z-50 flex items-center justify-between px-8 font-ui">
      
      <div className="flex items-center space-x-8">
        <div 
          className="flex items-center space-x-3 cursor-pointer group"
          onClick={() => navigate('/profile')}
        >
          <div className="w-10 h-10 rounded-full border-2 border-stone group-hover:border-void transition-colors bg-obsidian flex items-center justify-center">
            <CircleUserRound size={24} strokeWidth={1.25} className="text-gray-500" aria-hidden="true" />
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-200 group-hover:text-white font-mono">{identity}</div>
            <div className="text-[10px] text-gray-500 uppercase tracking-widest">
              {address ? `${address.slice(0, 5)}…${address.slice(-4)}` : 'Wallet'}
            </div>
          </div>
        </div>

        <nav className="hidden md:flex space-x-1 ml-4 border-l border-stone pl-6">
          {navItems.map((item) => {
            const isActive = location.pathname.startsWith(item.path);
            return (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={cn(
                  "px-4 py-2 text-xs uppercase tracking-widest transition-colors",
                  isActive ? "text-gray-100 bg-stone/50 font-semibold border-b-2 border-void" : "text-gray-500 hover:text-gray-300 hover:bg-stone/30"
                )}
              >
                {item.label}
              </button>
            )
          })}
        </nav>
      </div>

      {/*
        The currency chips that used to sit here showed "42.35 STX", "1,250 Soul
        Shards" and "87 Gold". All three were invented: there is no Soul Shard or
        Gold system anywhere in this codebase, and nothing fetched a balance — the
        STX figure was a literal, sitting next to a real connected address on every
        screen. On the reward screen that is actively misleading, since a player
        told "1.5 STX was sent to your wallet" would watch a balance that never
        moved.

        A real STX balance is worth showing, but it needs a source: the client has
        no Hiro access and `ConfigResponse` carries no balance endpoint, so it
        needs an API route first. Until then this follows the same rule as rank
        above — show what we know, not a plausible number.
      */}

      <div className="flex items-center space-x-4 text-gray-400">
        <motion.button whileHover={{ scale: 1.1, color: '#fff' }} className="p-2 border border-transparent hover:border-gray-700 hover:bg-stone rounded-sm">
          <Mail size={18} />
        </motion.button>
        <motion.button whileHover={{ scale: 1.1, color: '#fff' }} className="relative p-2 border border-transparent hover:border-gray-700 hover:bg-stone rounded-sm" aria-label="Notifications" onClick={() => setNotificationsOpen((open) => !open)}>
          <Bell size={18} />
          {unreadCount > 0 && <span className="absolute -right-1 -top-1 min-w-4 h-4 px-1 rounded-full bg-blood text-[10px] text-white leading-4">{unreadCount > 99 ? '99+' : unreadCount}</span>}
        </motion.button>
        <motion.button 
          whileHover={{ scale: 1.1, color: '#fff' }} 
          className="p-2 border border-transparent hover:border-gray-700 hover:bg-stone rounded-sm"
          onClick={() => navigate('/settings')}
        >
          <Settings size={18} />
        </motion.button>
      </div>

      {notificationsOpen && address && (
        <div className="absolute right-8 top-14 w-80 max-w-[calc(100vw-2rem)] border border-stone bg-obsidian shadow-xl p-3 z-50" role="dialog" aria-label="Notifications">
          <div className="flex items-center justify-between border-b border-stone pb-2 mb-2">
            <span className="text-xs uppercase tracking-widest text-gray-400">Notifications</span>
            {unreadCount > 0 && <button className="text-[10px] text-gray-400 hover:text-white" onClick={() => markAllNotificationsRead().then(() => { setUnreadCount(0); setNotifications((items) => items.map((item) => ({ ...item, read: true }))); })}>Mark all read</button>}
          </div>
          {notifications.length === 0 ? <div className="py-5 text-center text-sm text-gray-500">No notifications</div> : <div className="max-h-72 overflow-y-auto space-y-1">
            {notifications.map((item) => <button key={item.id} className={`w-full text-left p-2 flex gap-2 ${item.read ? 'opacity-60' : 'bg-stone/20'}`} onClick={() => !item.read && markNotificationRead(item.id).then(() => { setUnreadCount((count) => Math.max(0, count - 1)); setNotifications((items) => items.map((entry) => entry.id === item.id ? { ...entry, read: true } : entry)); })}>
              {item.read ? <Check size={14} className="mt-0.5 text-gray-500" /> : <Bell size={14} className="mt-0.5 text-stx-accent" />}
              <span className="text-xs text-gray-300">{item.type.replaceAll('_', ' ')}</span>
            </button>)}
          </div>}
        </div>
      )}
      
    </div>
  );
}
