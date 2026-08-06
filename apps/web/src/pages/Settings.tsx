import React, { useState } from 'react';
import { TopBar } from '@/components/layout/TopBar';
import { Button } from '@/components/ui/Button';

export default function Settings() {
  const [masterVolume, setMasterVolume] = useState(80);
  const [musicVolume, setMusicVolume] = useState(60);
  const [sfxVolume, setSfxVolume] = useState(100);

  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian">
      <TopBar />
      
      <div className="flex-1 pt-24 px-12 pb-12 max-w-4xl mx-auto w-full">
        <h1 className="text-3xl font-display text-gray-200 mb-8 uppercase tracking-widest">Settings</h1>
        
        <div className="bg-obsidian/80 border border-stone p-8 mb-8">
          <h2 className="text-xl font-display text-gray-400 mb-6 border-b border-stone pb-2">Audio</h2>
          
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <span className="text-sm font-ui text-gray-300 w-32">Master Volume</span>
              <input 
                type="range" 
                min="0" max="100" 
                value={masterVolume} 
                onChange={(e) => setMasterVolume(parseInt(e.target.value))}
                className="flex-1 mx-4 accent-gray-400"
              />
              <span className="text-sm font-ui text-gray-500 w-8 text-right">{masterVolume}%</span>
            </div>
            
            <div className="flex items-center justify-between">
              <span className="text-sm font-ui text-gray-300 w-32">Music</span>
              <input 
                type="range" 
                min="0" max="100" 
                value={musicVolume} 
                onChange={(e) => setMusicVolume(parseInt(e.target.value))}
                className="flex-1 mx-4 accent-gray-400"
              />
              <span className="text-sm font-ui text-gray-500 w-8 text-right">{musicVolume}%</span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm font-ui text-gray-300 w-32">SFX</span>
              <input 
                type="range" 
                min="0" max="100" 
                value={sfxVolume} 
                onChange={(e) => setSfxVolume(parseInt(e.target.value))}
                className="flex-1 mx-4 accent-gray-400"
              />
              <span className="text-sm font-ui text-gray-500 w-8 text-right">{sfxVolume}%</span>
            </div>
          </div>
        </div>

        <div className="bg-obsidian/80 border border-stone p-8 mb-8">
          <h2 className="text-xl font-display text-gray-400 mb-6 border-b border-stone pb-2">Wallet & Account</h2>
          
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <div>
                <div className="text-sm text-gray-200">Connected Wallet (Stacks)</div>
                <div className="text-xs text-gray-500">SP2K...7A92</div>
              </div>
              <Button variant="secondary">Disconnect</Button>
            </div>
          </div>
        </div>
        
        <div className="flex justify-end">
          <Button variant="primary" className="w-48">Save Changes</Button>
        </div>
      </div>
    </div>
  );
}
