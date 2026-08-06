import React from 'react';
import { TopBar } from '@/components/layout/TopBar';
import { Button } from '@/components/ui/Button';
import imgProfileArcanist from '@/assets/images/profile_arcanist_1785809282488.jpg';

export default function Profile() {
  return (
    <div className="relative w-full h-full flex flex-col bg-obsidian">
      <TopBar />
      
      <div className="flex-1 pt-24 px-12 pb-12 max-w-5xl mx-auto w-full flex flex-col items-center">
        
        <div className="flex flex-col items-center mb-12">
          <div className="w-32 h-32 rounded-full border-4 border-stone bg-obsidian overflow-hidden mb-6 relative">
            <img src={imgProfileArcanist} className="w-full h-full object-cover" alt="Profile" />
          </div>
          <h1 className="text-4xl font-display text-gray-200 mb-2">Arcanist#9172</h1>
          <div className="flex items-center space-x-2 text-sm font-ui text-gray-400">
            <span>Rank 241</span>
            <span>•</span>
            <span className="text-stx-accent">Member since '23</span>
          </div>
        </div>

        <div className="w-full grid grid-cols-3 gap-6 mb-12">
          <div className="bg-stone/20 border border-stone p-6 flex flex-col items-center text-center">
            <div className="text-3xl font-display text-gray-200 mb-2">142</div>
            <div className="text-xs font-ui tracking-widest text-gray-500 uppercase">Dungeons Cleared</div>
          </div>
          <div className="bg-stone/20 border border-stone p-6 flex flex-col items-center text-center">
            <div className="text-3xl font-display text-gray-200 mb-2">1,840</div>
            <div className="text-xs font-ui tracking-widest text-gray-500 uppercase">Total Kills</div>
          </div>
          <div className="bg-stone/20 border border-stone p-6 flex flex-col items-center text-center">
            <div className="text-3xl font-display text-stx-accent mb-2">350.2 STX</div>
            <div className="text-xs font-ui tracking-widest text-gray-500 uppercase">Total Earnings</div>
          </div>
        </div>

        <div className="w-full bg-obsidian/80 border border-stone p-8">
          <h2 className="text-xl font-display text-gray-200 mb-6 uppercase tracking-widest">Achievements</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-stone/50 pb-4">
              <div className="flex items-center">
                <div className="w-10 h-10 bg-void/20 border border-void flex items-center justify-center mr-4 rotate-45">
                  <div className="w-4 h-4 bg-void -rotate-45" />
                </div>
                <div>
                  <div className="text-sm text-gray-200 font-medium">Spire Conqueror</div>
                  <div className="text-xs text-gray-500">Clear the Obsidian Spire 10 times.</div>
                </div>
              </div>
              <div className="text-xs text-gray-400">Completed</div>
            </div>
            
            <div className="flex items-center justify-between border-b border-stone/50 pb-4">
              <div className="flex items-center">
                <div className="w-10 h-10 bg-stone/20 border border-stone flex items-center justify-center mr-4 rotate-45 opacity-50">
                  <div className="w-4 h-4 bg-gray-500 -rotate-45" />
                </div>
                <div className="opacity-50">
                  <div className="text-sm text-gray-200 font-medium">Slayer of Kings</div>
                  <div className="text-xs text-gray-500">Defeat the Wraith Lord without taking damage.</div>
                </div>
              </div>
              <div className="text-xs text-gray-600">Locked</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
