/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import Landing from './pages/Landing';
import Map from './pages/Map';
import CharacterSelect from './pages/CharacterSelect';
import Shop from './pages/Shop';
import Party from './pages/Party';
import Combat from './pages/Combat';
import Forge from './pages/Forge';
import Reward from './pages/Reward';
import Leaderboard from './pages/Leaderboard';
import Inventory from './pages/Inventory';
import Profile from './pages/Profile';
import Settings from './pages/Settings';
import { startBgm, playSfx } from './lib/audio';
import { WalletProvider } from './lib/wallet';

const PageWrapper = ({ children }: { children: React.ReactNode }) => (
  <motion.div
    initial={{ opacity: 0, filter: 'blur(8px)' }}
    animate={{ opacity: 1, filter: 'blur(0px)' }}
    exit={{ opacity: 0, filter: 'blur(8px)' }}
    transition={{ duration: 0.3 }}
    className="absolute inset-0 w-full h-full"
  >
    {children}
  </motion.div>
);

function AnimatedRoutes() {
  const location = useLocation();
  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<PageWrapper><Landing /></PageWrapper>} />
        <Route path="/map" element={<PageWrapper><Map /></PageWrapper>} />
        <Route path="/characters" element={<PageWrapper><CharacterSelect /></PageWrapper>} />
        <Route path="/shop" element={<PageWrapper><Shop /></PageWrapper>} />
        <Route path="/party" element={<PageWrapper><Party /></PageWrapper>} />
        <Route path="/combat" element={<PageWrapper><Combat /></PageWrapper>} />
        <Route path="/forge" element={<PageWrapper><Forge /></PageWrapper>} />
        <Route path="/reward" element={<PageWrapper><Reward /></PageWrapper>} />
        <Route path="/leaderboard" element={<PageWrapper><Leaderboard /></PageWrapper>} />
        <Route path="/inventory" element={<PageWrapper><Inventory /></PageWrapper>} />
        <Route path="/profile" element={<PageWrapper><Profile /></PageWrapper>} />
        <Route path="/settings" element={<PageWrapper><Settings /></PageWrapper>} />
      </Routes>
    </AnimatePresence>
  );
}

export default function App() {
  useEffect(() => {
    const handleGlobalClick = () => {
      startBgm();
      playSfx('click');
    };
    
    // Start BGM on first interaction
    document.addEventListener('click', handleGlobalClick, { once: true });
    
    // Global click sound for buttons
    const playClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('button') || target.closest('a') || target.closest('.cursor-pointer')) {
        playSfx('click');
      }
    };
    document.addEventListener('click', playClick);

    return () => {
      document.removeEventListener('click', handleGlobalClick);
      document.removeEventListener('click', playClick);
    };
  }, []);

  return (
    <WalletProvider>
      <BrowserRouter>
        <div className="relative w-full h-full bg-obsidian overflow-hidden">
          <AnimatedRoutes />
        </div>
      </BrowserRouter>
    </WalletProvider>
  );
}
