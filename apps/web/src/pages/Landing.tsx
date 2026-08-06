import React, { useEffect } from 'react';
import { Button } from '@/components/ui/Button';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { useWallet } from '@/lib/wallet';
import landingBg from '@/assets/images/landing_bg_1785807745179.jpg';

export default function Landing() {
  const navigate = useNavigate();
  const { status, address, error, cancelled, connect } = useWallet();

  // A returning player with a live session shouldn't have to click through the
  // splash again.
  useEffect(() => {
    if (status === 'connected' && address) navigate('/map', { replace: true });
  }, [status, address, navigate]);

  const handleConnect = async () => {
    // connect() resolves false on cancellation or failure; the provider holds
    // the reason so the button can stay a button.
    if (await connect()) navigate('/map');
  };

  return (
    <div 
      className="relative w-full h-full flex flex-col items-center justify-center overflow-hidden bg-cover bg-center"
      style={{ backgroundImage: `url(${landingBg})` }}
    >
      <div className="absolute inset-0 bg-obsidian/60 z-0" />
      
      <div className="relative z-10 flex flex-col items-center text-center mt-[-10vh]">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1 }}
          className="mb-8 flex flex-col items-center"
        >
          <h1 className="text-7xl font-display font-black text-gray-200 tracking-[0.2em] uppercase shadow-black drop-shadow-2xl">
            GrimHallow
          </h1>
          <p className="mt-4 text-sm font-ui tracking-[0.15em] text-gray-400 uppercase">
            Your NFTs. Real Power. Real Raids. Real Rewards.
          </p>
          <p className="mt-2 text-xs font-ui text-gray-500">
            A co-op, turn-based MMORPG<br />on Stacks (Bitcoin L2)
          </p>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 1 }}
          className="flex space-x-12 mb-12 border-t border-b border-stone py-6"
        >
          <div className="flex flex-col items-center text-xs font-ui text-gray-400 tracking-widest uppercase text-center w-32">
            <span className="text-gray-300">Your NFTs</span>
            <span>Come Alive</span>
          </div>
          <div className="w-px h-8 bg-stone" />
          <div className="flex flex-col items-center text-xs font-ui text-gray-400 tracking-widest uppercase text-center w-32">
            <span className="text-gray-300">Raid Together</span>
            <span>Share the Glory</span>
          </div>
          <div className="w-px h-8 bg-stone" />
          <div className="flex flex-col items-center text-xs font-ui text-gray-400 tracking-widest uppercase text-center w-32">
            <span className="text-gray-300">Real STX Raids</span>
            <span>Real Rewards</span>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.8, duration: 1 }}
          className="flex flex-col items-center"
        >
          <Button
            variant="stx"
            size="lg"
            onClick={handleConnect}
            disabled={status === 'connecting'}
            className="mb-4 w-64"
          >
            {status === 'connecting' ? 'Awaiting Wallet…' : 'Connect Wallet'}
          </Button>

          {error && (
            <p className="mb-2 max-w-sm text-center text-xs font-ui text-blood">{error}</p>
          )}
          {cancelled && !error && (
            <p className="mb-2 text-xs font-ui text-gray-500">
              Signature declined. Nothing was sent.
            </p>
          )}

          <p className="text-xs font-ui text-gray-500">
            No wallet? <a href="#" className="text-gray-400 hover:text-gray-200 transition-colors">Learn more</a>
          </p>
        </motion.div>
      </div>
      
      {/* Dev Navigation menu - remove in prod */}
      <div className="absolute bottom-4 left-4 z-50 flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => navigate('/map')}>Map</Button>
        <Button variant="secondary" size="sm" onClick={() => navigate('/characters')}>Chars</Button>
        <Button variant="secondary" size="sm" onClick={() => navigate('/party')}>Party</Button>
        <Button variant="secondary" size="sm" onClick={() => navigate('/combat')}>Combat</Button>
        <Button variant="secondary" size="sm" onClick={() => navigate('/forge')}>Forge</Button>
        <Button variant="secondary" size="sm" onClick={() => navigate('/reward')}>Reward</Button>
        <Button variant="secondary" size="sm" onClick={() => navigate('/leaderboard')}>LDB</Button>
      </div>
    </div>
  );
}
