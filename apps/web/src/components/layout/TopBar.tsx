import React from 'react';
import { Mail, Bell, Settings } from 'lucide-react';
import { motion } from 'motion/react';
import { useNavigate, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useWallet } from '@/lib/wallet';
import imgProfileArcanist from '@/assets/images/profile_arcanist_1785809282488.jpg';

export function TopBar() {
  const navigate = useNavigate();
  const location = useLocation();
  const { address } = useWallet();

  // Rank is a Phase 7 (leaderboard) value; until then show the identity we
  // actually know rather than a made-up one.
  const identity = address ? `${address.slice(0, 5)}…${address.slice(-4)}` : 'Not connected';

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
          <div className="w-10 h-10 rounded-full border-2 border-stone group-hover:border-void transition-colors bg-obsidian overflow-hidden">
            <img src={imgProfileArcanist} className="w-full h-full object-cover" alt="Profile" />
          </div>
          <div>
            <div className="text-sm font-semibold text-gray-200 group-hover:text-white font-mono">{identity}</div>
            <div className="text-[10px] text-gray-500 uppercase tracking-widest">
              {address ? 'Connected' : 'Wallet'}
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
        <motion.button whileHover={{ scale: 1.1, color: '#fff' }} className="p-2 border border-transparent hover:border-gray-700 hover:bg-stone rounded-sm">
          <Bell size={18} />
        </motion.button>
        <motion.button 
          whileHover={{ scale: 1.1, color: '#fff' }} 
          className="p-2 border border-transparent hover:border-gray-700 hover:bg-stone rounded-sm"
          onClick={() => navigate('/settings')}
        >
          <Settings size={18} />
        </motion.button>
      </div>
      
    </div>
  );
}
